import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const args = new Map(
  process.argv.slice(2).map((entry) => {
    const [key, ...rest] = String(entry || "").split("=");
    return [key, rest.join("=") || true];
  }),
);
const baselineRef = String(args.get("--baseline") || "origin/main");
const currentRef = String(args.get("--current") || "HEAD");
const outputJson = args.has("--json");
const useNativeHydrate = args.has("--native-hydrate");
const nativeHydrateThreshold = args.get("--native-hydrate-threshold");

async function runCommand(command, commandArgs, cwd) {
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20,
    env: {
      ...process.env,
      ST_BME_NODE_MODULES_ROOT: projectRoot,
    },
  });
  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  };
}

async function resolveRef(ref) {
  const result = await runCommand("git", ["rev-parse", ref], projectRoot);
  return result.stdout;
}

async function ensureFileFromCurrentRepo(relativePath, targetRoot) {
  const sourcePath = path.join(projectRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

function readJsonLine(stdout = "") {
  const trimmed = String(stdout || "").trim();
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function formatDelta(current = 0, baseline = 0) {
  const delta = current - baseline;
  const ratio = baseline !== 0 ? (delta / baseline) * 100 : 0;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)}ms (${sign}${ratio.toFixed(1)}%)`;
}

function collectMetricRows(compare, metricPath, label) {
  return Object.entries(compare).map(([preset, metrics]) => ({
    preset,
    label,
    baseline: Number(metricPath(metrics.baseline) || 0),
    current: Number(metricPath(metrics.current) || 0),
  }));
}

function printRows(rows = [], title = "") {
  console.log(`\n[ST-BME][P1-compare] ${title}`);
  for (const row of rows) {
    console.log(
      `${row.preset} baseline=${row.baseline.toFixed(2)}ms current=${row.current.toFixed(2)}ms delta=${formatDelta(row.current, row.baseline)}`,
    );
  }
}

async function runBenchSuite(cwd) {
  const persistLoadArgs = ["tests/perf/persist-load-bench.mjs", "--json"];
  if (useNativeHydrate) {
    persistLoadArgs.push("--native-hydrate");
  }
  if (nativeHydrateThreshold !== undefined && nativeHydrateThreshold !== true) {
    persistLoadArgs.push(`--native-hydrate-threshold=${nativeHydrateThreshold}`);
  }
  const persistLoad = await runCommand(
    process.execPath,
    persistLoadArgs,
    cwd,
  );
  const loadPreapply = await runCommand(
    process.execPath,
    ["tests/perf/load-preapply-bench.mjs", "--json"],
    cwd,
  );
  return {
    persistLoad: readJsonLine(persistLoad.stdout),
    loadPreapply: readJsonLine(loadPreapply.stdout),
  };
}

function compareBenchResults(baseline, current) {
  const presets = {};
  const presetNames = new Set([
    ...Object.keys(baseline.persistLoad?.presets || {}),
    ...Object.keys(current.persistLoad?.presets || {}),
    ...Object.keys(baseline.loadPreapply?.presets || {}),
    ...Object.keys(current.loadPreapply?.presets || {}),
  ]);
  for (const preset of presetNames) {
    presets[preset] = {
      baseline: {
        ...(baseline.persistLoad?.presets?.[preset] || {}),
        ...(baseline.loadPreapply?.presets?.[preset] || {}),
      },
      current: {
        ...(current.persistLoad?.presets?.[preset] || {}),
        ...(current.loadPreapply?.presets?.[preset] || {}),
      },
    };
  }
  return presets;
}

async function createWorktree(ref, tempRoot, name) {
  const worktreePath = path.join(tempRoot, name);
  await runCommand("git", ["worktree", "add", "--detach", worktreePath, ref], projectRoot);
  await ensureFileFromCurrentRepo("tests/perf/persist-load-bench.mjs", worktreePath);
  await ensureFileFromCurrentRepo("tests/perf/load-preapply-bench.mjs", worktreePath);
  await ensureFileFromCurrentRepo("tests/helpers/memory-opfs.mjs", worktreePath);
  return worktreePath;
}

async function removeWorktree(worktreePath) {
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], projectRoot);
}

async function main() {
  const baselineSha = await resolveRef(baselineRef);
  const currentSha = await resolveRef(currentRef);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "st-bme-p1-compare-"));
  let baselinePath = "";
  let currentPath = "";

  try {
    baselinePath = await createWorktree(baselineSha, tempRoot, "baseline");
    currentPath =
      currentRef === "HEAD" ? projectRoot : await createWorktree(currentSha, tempRoot, "current");

    const baselineResults = await runBenchSuite(baselinePath);
    const currentResults = await runBenchSuite(currentPath);
    const compare = compareBenchResults(baselineResults, currentResults);

    if (outputJson) {
      console.log(
        JSON.stringify({
          baselineRef,
          baselineSha,
          currentRef,
          currentSha,
          nativeHydrateRequested: useNativeHydrate,
          nativeHydrateThreshold:
            nativeHydrateThreshold !== undefined && nativeHydrateThreshold !== true
              ? String(nativeHydrateThreshold)
              : null,
          compare,
        }),
      );
      return;
    }

    console.log(`[ST-BME][P1-compare] baseline=${baselineRef} (${baselineSha.slice(0, 7)})`);
    console.log(`[ST-BME][P1-compare] current=${currentRef} (${currentSha.slice(0, 7)})`);
    if (useNativeHydrate) {
      console.log(
        `[ST-BME][P1-compare] nativeHydrate=on threshold=${
          nativeHydrateThreshold !== undefined && nativeHydrateThreshold !== true
            ? nativeHydrateThreshold
            : "default"
        }`,
      );
    }

    printRows(
      collectMetricRows(compare, (entry) => entry.opfsCommitMs?.p95, "opfsCommitMs.p95"),
      "opfs commit p95",
    );
    printRows(
      collectMetricRows(compare, (entry) => entry.indexedDbProbeRejectMs?.p95, "indexedDbProbeRejectMs.p95"),
      "indexeddb probe-reject preApply p95",
    );
    printRows(
      collectMetricRows(compare, (entry) => entry.opfsProbeRejectMs?.p95, "opfsProbeRejectMs.p95"),
      "opfs probe-reject preApply p95",
    );
    printRows(
      collectMetricRows(compare, (entry) => entry.indexedDbPreApplySuccessMs?.p95, "indexedDbPreApplySuccessMs.p95"),
      "indexeddb success preApply p95",
    );
    printRows(
      collectMetricRows(compare, (entry) => entry.hydrateMs?.p95, "hydrateMs.p95"),
      "hydrate p95",
    );
  } finally {
    if (baselinePath) {
      await removeWorktree(baselinePath);
    }
    if (currentPath && currentPath !== projectRoot) {
      await removeWorktree(currentPath);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
