import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ST-BME VM-slice test-tax ratchet.
//
// Background: several legacy tests read index.js as raw TEXT, slice functions
// out by marker strings, and execute the fragment (vm.runInContext) or write a
// temp module. This couples every index.js edit to byte offsets and repeatedly
// caused "X is not defined" sandbox breaks. The detangling plan migrates these
// tests to import real ESM modules instead.
//
// This ratchet makes the coupling impossible to reintroduce or grow:
//   1. No NEW test file may read index.js as text.
//   2. Allowlisted (legacy) files may not GAIN more slice markers.
//   3. When a legacy file stops slicing index.js, it MUST be removed from the
//      allowlist (the budget can only shrink, never sit stale).
//
// As each migration phase lands, delete the corresponding allowlist entry.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname);
const SELF_RELATIVE = "tests/index-slicing-ratchet.mjs";

// Legacy offenders with their CURRENT marker-call budget (measured at ratchet
// introduction). Budgets are an upper bound: migrations may only reduce them.
// Remove the entry entirely once a file no longer reads index.js as text.
const ALLOWLIST = Object.freeze({});

async function collectTestFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

function toRelative(fullPath) {
  return path
    .relative(path.resolve(TESTS_ROOT, ".."), fullPath)
    .split(path.sep)
    .join("/");
}

// Detects the root smell: reading index.js as TEXT (not importing it).
function readsIndexAsText(source) {
  const referencesIndexPath = /["'`][^"'`]*\/index\.js["'`]/.test(source);
  const readsFile = /readFile(Sync)?\s*\(/.test(source);
  return referencesIndexPath && readsFile;
}

// Counts marker-extraction calls — the unit that grows when more slices are added.
function countMarkerCalls(source) {
  const matches = source.match(/(indexSource|source)\.indexOf\(|extractSnippet\(/g);
  return matches ? matches.length : 0;
}

async function run() {
  const files = await collectTestFiles(TESTS_ROOT);
  const violations = [];
  const seenAllowlisted = new Set();

  for (const full of files) {
    const rel = toRelative(full);
    if (rel === SELF_RELATIVE) continue;

    const source = await fs.readFile(full, "utf8");
    const slices = readsIndexAsText(source);
    const allow = ALLOWLIST[rel];

    if (slices && !allow) {
      violations.push(
        `NEW offender: ${rel} reads index.js as text. Tests must import real ESM modules, not slice index.js by marker.`,
      );
      continue;
    }

    if (allow) {
      seenAllowlisted.add(rel);
      if (!slices) {
        violations.push(
          `${rel} no longer slices index.js — remove it from the ratchet ALLOWLIST (${allow.stage}). The allowlist may only shrink.`,
        );
        continue;
      }
      const markerCalls = countMarkerCalls(source);
      if (markerCalls > allow.maxMarkerCalls) {
        violations.push(
          `${rel} gained slice markers (${markerCalls} > budget ${allow.maxMarkerCalls}). index.js slicing may only shrink, never grow.`,
        );
      }
    }
  }

  // Any allowlist entry whose file vanished must also be pruned.
  for (const rel of Object.keys(ALLOWLIST)) {
    if (!seenAllowlisted.has(rel)) {
      violations.push(
        `ALLOWLIST entry ${rel} has no matching test file — remove the stale entry.`,
      );
    }
  }

  assert.equal(
    violations.length,
    0,
    `\nindex.js slicing ratchet failed:\n  - ${violations.join("\n  - ")}\n`,
  );

  console.log(
    `index-slicing-ratchet tests passed (${seenAllowlisted.size} legacy offenders tracked, no new slicing)`,
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
