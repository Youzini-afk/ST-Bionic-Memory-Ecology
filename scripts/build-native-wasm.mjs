import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const CRATE_DIR = path.resolve(ROOT, "native", "stbme-core");
const OUT_DIR = path.resolve(ROOT, "vendor", "wasm", "pkg");

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`[ST-BME][native] building Rust/WASM from ${CRATE_DIR}`);
  await runCommand(
    "wasm-pack",
    [
      "build",
      "--target",
      "web",
      "--release",
      "--out-dir",
      path.relative(CRATE_DIR, OUT_DIR),
      "--out-name",
      "stbme_core_pkg",
    ],
    CRATE_DIR,
  );

  console.log("[ST-BME][native] wasm artifact build completed");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[ST-BME][native] build failed:", message);
  console.error(
    "[ST-BME][native] Ensure rustup + wasm32 target + wasm-pack are installed.",
  );
  process.exitCode = 1;
});
