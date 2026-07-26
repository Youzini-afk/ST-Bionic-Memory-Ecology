import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const SOURCE_ROOTS = [
  "index.js",
  "ena-planner",
  "graph",
  "host",
  "llm",
  "maintenance",
  "prompting",
  "retrieval",
  "runtime",
  "scripts",
  "sync",
  "ui",
  "vector",
  "vendor/wasm",
  "native",
];

async function collectFiles(targetPath) {
  const absolutePath = path.resolve(process.cwd(), targetPath);
  const fileStat = await stat(absolutePath);
  if (fileStat.isFile()) {
    return [absolutePath];
  }

  const files = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const nextRelative = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(nextRelative)));
      continue;
    }
    if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      files.push(path.resolve(process.cwd(), nextRelative));
    }
  }
  return files;
}

function toPosixPath(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

async function runNodeCheck(filePath) {
  // Force ES module parsing. This repo's `.js` files are ESM (import/export,
  // and the browser loads them as modules), but package.json has no
  // `"type": "module"`, so `node --check file.js` parses them as CommonJS/script
  // and silently accepts invalid ESM syntax (e.g. an arrow function pasted inside
  // an `import { ... }` block — which shipped a broken index.js once). Node only
  // allows `--input-type=module` with stdin input, not a file argument, so we
  // pipe the file content through stdin. `--check` validates syntax only and does
  // not resolve imports, so no module-resolution hook is needed here.
  const source = await readFile(filePath, "utf8");
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--check", "--input-type=module", "-"],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "inherit", "inherit"],
        windowsHide: true,
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${filePath} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${filePath} exited with code ${code}`));
        return;
      }
      resolve();
    });

    child.stdin.on("error", reject);
    child.stdin.end(source);
  });
}

async function main() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    files.push(...(await collectFiles(root)));
  }

  const uniqueFiles = Array.from(new Set(files)).sort((left, right) =>
    toPosixPath(left).localeCompare(toPosixPath(right), "en"),
  );
  console.log(`[ST-BME][check] syntax-checking ${uniqueFiles.length} files`);

  for (const filePath of uniqueFiles) {
    console.log(`[ST-BME][check] -> ${toPosixPath(filePath)}`);
    await runNodeCheck(filePath);
  }

  console.log("[ST-BME][check] syntax checks passed");
}

main().catch((error) => {
  console.error(
    "[ST-BME][check] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
