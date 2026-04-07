import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const TEST_ROOT = path.resolve(process.cwd(), "tests");
const EXCLUDED_TESTS = new Set(["triviumdb-poc.mjs"]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function collectStableTests() {
  const entries = await readdir(TEST_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .filter((name) => !EXCLUDED_TESTS.has(name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function runNodeFile(relativePath) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relativePath], {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${relativePath} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${relativePath} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const tests = await collectStableTests();
  console.log(
    `[ST-BME][test-suite] running ${tests.length} stable tests (excluded: ${Array.from(EXCLUDED_TESTS).join(", ")})`,
  );

  for (const testName of tests) {
    const relativePath = toPosixPath(path.join("tests", testName));
    console.log(`[ST-BME][test-suite] -> ${relativePath}`);
    await runNodeFile(relativePath);
  }

  console.log("[ST-BME][test-suite] all stable tests passed");
}

main().catch((error) => {
  console.error(
    "[ST-BME][test-suite] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
