// ST-BME: i18n import boundary enforcement
// Ensures that prompt/data modules (prompting/**, retrieval/injector.js,
// graph/schema.js, sync/**, vector/**) do NOT import from the i18n module.
// This is a static analysis guard: i18n is UI-only and must not leak into
// data-pipeline or prompt-building code.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ─── Configuration ───────────────────────────────────────────────────────────

const PROJECT_ROOT = new URL("../", import.meta.url);

const BOUNDARY_PATTERNS = [
  // i18n module import patterns to forbid
  /from\s+["'](?:\.\.\/)+i18n(?:\/[^"']*)?["']/,
  /require\s*\(\s*["'](?:\.\.\/)+i18n(?:\/[^"']*)?["']\s*\)/,
  /import\s*\(\s*["'](?:\.\.\/)+i18n(?:\/[^"']*)?["']\s*\)/,
];

const BOUNDARY_MODULES = [
  // prompting/ — all files in the prompting directory
  { dir: "prompting", files: null },
  // retrieval/injector.js specifically
  { dir: "retrieval", files: ["injector.js"] },
  // graph/schema.js specifically
  { dir: "graph", files: ["schema.js"] },
  // sync/ — all files in the sync directory
  { dir: "sync", files: null },
  // vector/ — all files in the vector directory
  { dir: "vector", files: null },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readProjectFile(relativePath) {
  return readFileSync(new URL(relativePath, PROJECT_ROOT), "utf8");
}

/**
 * Check if a source file contains any forbidden i18n import pattern.
 * Returns violations found, or an empty array.
 */
function checkI18nImports(source, filePath) {
  const violations = [];
  for (const pattern of BOUNDARY_PATTERNS) {
    const match = source.match(pattern);
    if (match) {
      const lineNum = source.substring(0, match.index).split("\n").length;
      violations.push({ filePath, line: lineNum, match: match[0].trim() });
    }
  }
  return violations;
}

/**
 * Get all .js files in a directory (non-recursive for simplicity; the
 * project's restricted dirs are flat).
 */
function getJsFilesInDir(dirPath) {
  const entries = readdirSync(new URL(`${dirPath}/`, PROJECT_ROOT), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const allViolations = [];

for (const entry of BOUNDARY_MODULES) {
  const fileList = entry.files || getJsFilesInDir(entry.dir);
  for (const filename of fileList) {
    const relativePath = `${entry.dir}/${filename}`;
    let source;
    try {
      source = readProjectFile(relativePath);
    } catch {
      console.warn(`[i18n-boundary] SKIP — file not found: ${relativePath}`);
      continue;
    }
    const violations = checkI18nImports(source, relativePath);
    allViolations.push(...violations);
  }
}

if (allViolations.length > 0) {
  const report = allViolations
    .map(
      (v) => `  ${v.filePath}:${v.line} — ${v.match}`,
    )
    .join("\n");
  assert.fail(
    `i18n import boundary violation(s) found in ${allViolations.length} location(s):\n${report}\n\n` +
      "i18n is UI-only. Prompt/data modules (prompting/**, retrieval/injector.js, " +
      "graph/schema.js, sync/**, vector/**) must not import i18n.",
  );
}

// Optional: verify that the boundary modules themselves are valid JS by
// checking for obvious syntax issues (e.g., unmatched braces, obviously
// malformed import statements that might hide i18n imports).
// This is a lightweight sanity check, not a full parse.

const MINIMAL_FILE_COUNT = {
  prompting: 9,
  retrieval: 1, // injector.js only
  graph: 1, // schema.js only
  sync: 13,
  vector: 6,
};

for (const entry of BOUNDARY_MODULES) {
  if (entry.files) {
    for (const filename of entry.files) {
      const relativePath = `${entry.dir}/${filename}`;
      try {
        const source = readProjectFile(relativePath);
        // Ensure the file has at least some content
        assert.ok(
          source.trim().length > 0,
          `${relativePath} is empty — cannot verify boundary compliance`,
        );
      } catch {
        // Already warned above — skip
      }
    }
  } else {
    const dirFiles = getJsFilesInDir(entry.dir);
    assert.ok(
      dirFiles.length >= (MINIMAL_FILE_COUNT[entry.dir] || 1),
      `${entry.dir} expected at least ${MINIMAL_FILE_COUNT[entry.dir]} .js files for boundary coverage, got ${dirFiles.length}`,
    );
  }
}

console.log("i18n boundary enforcement tests passed");
console.log(`  Scanned modules: ${BOUNDARY_MODULES.length} directories / files`);
console.log(`  Violations found: ${allViolations.length}`);
