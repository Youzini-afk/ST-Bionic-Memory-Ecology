import { readdir, stat } from "node:fs/promises";
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

function toDataModuleUrl(source = "") {
  return `data:text/javascript,${encodeURIComponent(String(source || ""))}`;
}

const CHECK_SYNTAX_HOOK_BOOTSTRAP_URL = toDataModuleUrl(`
import * as nodeModule from "node:module";

const register = typeof nodeModule.register === "function" ? nodeModule.register : undefined;
const registerHooks = typeof nodeModule.registerHooks === "function"
  ? nodeModule.registerHooks
  : undefined;

const scriptShimUrl = ${JSON.stringify(toDataModuleUrl([
  "export function getRequestHeaders() { return {}; }",
  "export function saveMetadata() {}",
  "export function saveSettingsDebounced() {}",
  "export function substituteParamsExtended(value) { return String(value ?? ''); }",
].join("\n")))};
const extensionsShimUrl = ${JSON.stringify(toDataModuleUrl([
  "export const extension_settings = { st_bme: {} };",
  "export function getContext() { return {}; }",
  "export function saveMetadataDebounced() {}",
].join("\n")))};
const openaiShimUrl = ${JSON.stringify(toDataModuleUrl([
  "export const chat_completion_sources = {};",
  "export async function sendOpenAIRequest() { return {}; }",
].join("\n")))};

function resolveShim(specifier) {
  const normalized = String(specifier || "");
  if (normalized.endsWith("/script.js")) return scriptShimUrl;
  if (normalized.endsWith("/extensions.js")) return extensionsShimUrl;
  if (normalized.endsWith("/openai.js")) return openaiShimUrl;
  return "";
}

if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const shimUrl = resolveShim(specifier);
      if (shimUrl) {
        return {
          shortCircuit: true,
          url: shimUrl,
        };
      }
      return nextResolve(specifier, context);
    },
  });
} else if (typeof register === "function") {
  register(${JSON.stringify(toDataModuleUrl(`
export async function resolve(specifier, context, nextResolve) {
  const normalized = String(specifier || "");
  if (normalized.endsWith("/script.js")) {
    return { shortCircuit: true, url: ${JSON.stringify(toDataModuleUrl([
      "export function getRequestHeaders() { return {}; }",
      "export function saveMetadata() {}",
      "export function saveSettingsDebounced() {}",
      "export function substituteParamsExtended(value) { return String(value ?? ''); }",
    ].join("\n")))} };
  }
  if (normalized.endsWith("/extensions.js")) {
    return { shortCircuit: true, url: ${JSON.stringify(toDataModuleUrl([
      "export const extension_settings = { st_bme: {} };",
      "export function getContext() { return {}; }",
      "export function saveMetadataDebounced() {}",
    ].join("\n")))} };
  }
  if (normalized.endsWith("/openai.js")) {
    return { shortCircuit: true, url: ${JSON.stringify(toDataModuleUrl([
      "export const chat_completion_sources = {};",
      "export async function sendOpenAIRequest() { return {}; }",
    ].join("\n")))} };
  }
  return nextResolve(specifier, context);
}
`))}, import.meta.url);
}
`);

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
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", CHECK_SYNTAX_HOOK_BOOTSTRAP_URL, "--check", filePath], {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });

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
