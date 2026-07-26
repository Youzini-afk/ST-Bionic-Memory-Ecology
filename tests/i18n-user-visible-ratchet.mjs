/**
 * ST-BME: i18n user-visible ratchet test
 *
 * Scans migrated UI files for obvious hardcoded Chinese in user-visible
 * API surface patterns (toastr, confirm, textContent, innerHTML, template
 * literals, title, placeholder, aria-label, button HTML) and enforces that
 * no new regressions are introduced. Comments and t("...") catalog lookups
 * are explicitly allowed.
 *
 * This is a ratchet, not a global ban: it only checks the explicitly-listed
 * UI files that have been migrated.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ─── Files to scan ──────────────────────────────────────────────────────────

const UI_JS_FILES = [
  "ui/panel-bridge.js",
  "ui/recall-message-ui.js",
  "ui/panel-ena-sections.js",
  "ui/ui-status.js",
  "ui/history-notice.js",
  "ui/ui-label-formatter.js",
  "ui/graph-renderer.js",
];

const UI_HTML_FILES = [
  "ui/panel.html",
];

// ─── Pattern definitions ────────────────────────────────────────────────────

/**
 * Detect CJK Han characters in a string.
 */
const CJK_RE = /\p{Script=Han}/u;

/**
 * Strip JS block and single-line comments from source.
 * Conservative: removes comment content so Chinese inside comments is not flagged.
 */
function stripComments(src) {
  let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
  result = result.replace(/\/\/.*$/gm, "");
  return result;
}

/**
 * Strip t("...") and t('...') catalog call patterns so Chinese inside
 * i18n lookups is not flagged. Also handles t("key", { params }, { opts }).
 * Neutralises the string content so CJK regex won't match inside t() args.
 */
function stripI18nCalls(src) {
  let result = src;
  // Double-quoted t() calls: t("anything", {...}, {...})
  result = result.replace(
    /\bt\s*\(\s*"([^"\\]|\\.)*"\s*(?:,\s*\{[^}]*\}\s*)*(?:,\s*\{[^}]*\}\s*)*\)/g,
    (m) => m.replace(/"/g, "\x00"),
  );
  // Single-quoted t() calls: t('anything', {...}, {...})
  result = result.replace(
    /\bt\s*\(\s*'([^'\\]|\\.)*'\s*(?:,\s*\{[^}]*\}\s*)*(?:,\s*\{[^}]*\}\s*)*\)/g,
    (m) => m.replace(/'/g, "\x00"),
  );
  return result;
}

/**
 * Known violations baseline: counts of Chinese-containing lines per file
 * AFTER comments and t() calls are stripped. These represent internal
 * defaults / fallback labels that route through i18n at runtime.
 * The ratchet ensures these counts do not increase.
 */
const BASELINE = {
  "ui/panel-bridge.js": 7,       // console.error/warn messages (dev-only, not user-visible)
  "ui/recall-message-ui.js": 0,  // fully migrated
  "ui/panel-ena-sections.js": 0, // fully migrated
  "ui/ui-status.js": 0,          // fully migrated
  "ui/history-notice.js": 0,     // fully migrated
  "ui/ui-label-formatter.js": 0,  // fully migrated
  "ui/graph-renderer.js": 0,     // fully migrated
};

// ─── Scanning logic ─────────────────────────────────────────────────────────

function scanFileForUserVisibleChinese(relativePath) {
  const fullPath = join(PROJECT_ROOT, relativePath);
  let source;
  try {
    source = readFileSync(fullPath, "utf8");
  } catch {
    console.warn(`[i18n-ratchet] SKIP — file not found: ${relativePath}`);
    return [];
  }

  const stripped = stripComments(source);
  const safe = stripI18nCalls(stripped);
  const lines = safe.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CJK_RE.test(line)) continue;

    // Skip import lines
    if (/^\s*import\s/.test(line)) continue;

    // Skip console/debugLog calls (dev-only, not user-visible)
    if (/console\.(log|error|warn|info|debug)\s*\(/.test(line)) continue;
    if (/debugLog\s*\(/.test(line)) continue;

    const trimmed = line.trim();

    // ─── User-visible API patterns that SHOULD use t() ────

    // 1. toastr.*() calls with Chinese
    if (/\btoastr\s*\.\s*(?:success|error|info|warning|notify)\s*\(/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "toastr", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 2. confirm(...) calls with Chinese
    if (/\bconfirm\s*\(/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "confirm", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 3. prompt(...) calls with Chinese
    if (/\bprompt\s*\(/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "prompt", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 4. .textContent = with Chinese
    if (/\.textContent\s*=/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "textContent", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 5. .innerHTML = with Chinese
    if (/\.innerHTML\s*=/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "innerHTML", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 6. .title / .placeholder / .ariaLabel = with Chinese
    if (/\.(?:title|placeholder|ariaLabel)\s*=/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "attribute", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 7. setAttribute('title'/'placeholder'/'aria-label', ...) with Chinese
    if (/\.setAttribute\s*\(\s*["'](?:title|placeholder|aria-label)["']\s*,/.test(trimmed) && CJK_RE.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "setAttribute", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 8. <button> with Chinese text
    if (/<button[^>]*>.*\p{Script=Han}.*<\/button>/u.test(trimmed)) {
      violations.push({ file: relativePath, line: i + 1, kind: "button-html", snippet: trimmed.slice(0, 120) });
      continue;
    }

    // 9. Template literals with Chinese in innerHTML/textContent context
    if (/`[^`]*\p{Script=Han}[^`]*`/u.test(trimmed)) {
      if (/\.innerHTML\s*[+=]|\.textContent\s*[+=]|\.innerText\s*[+=]/.test(trimmed)) {
        violations.push({ file: relativePath, line: i + 1, kind: "template-literal", snippet: trimmed.slice(0, 120) });
        continue;
      }
    }
  }

  return violations;
}

function scanHtmlForMissingDataI18n(relativePath) {
  const fullPath = join(PROJECT_ROOT, relativePath);
  let source;
  try {
    source = readFileSync(fullPath, "utf8");
  } catch {
    console.warn(`[i18n-ratchet] SKIP — file not found: ${relativePath}`);
    return [];
  }

  const violations = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CJK_RE.test(line)) continue;

    // Skip lines that already have data-i18n (properly migrated)
    if (/data-i18n(?:-[a-z-]+)?=/.test(line)) continue;

    // Skip HTML comments
    if (/^\s*<!--/.test(line.trim())) continue;

    // <button...>Chinese text</button> without data-i18n
    if (/<button[^>]*>.*\p{Script=Han}.*<\/button>/u.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "button-html", snippet: line.trim().slice(0, 120) });
      continue;
    }

    // title="Chinese", placeholder="Chinese", aria-label="Chinese"
    if (/(?:title|placeholder|aria-label)\s*=\s*["'][^"']*\p{Script=Han}[^"']*["']/u.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "attribute-chinese", snippet: line.trim().slice(0, 120) });
      continue;
    }

    // <span>Chinese</span> without data-i18n
    if (/<span[^>]*>[\s]*\p{Script=Han}[\p{Script=Han}\s\w]*<\/span>/u.test(line) && !/data-i18n/.test(line)) {
      violations.push({ file: relativePath, line: i + 1, kind: "span-chinese-no-i18n", snippet: line.trim().slice(0, 120) });
      continue;
    }
  }

  return violations;
}

// ─── Count broad Chinese lines for ratchet ──────────────────────────────────

function countChineseLines(relativePath) {
  const fullPath = join(PROJECT_ROOT, relativePath);
  let source;
  try {
    source = readFileSync(fullPath, "utf8");
  } catch {
    return -1;
  }
  const stripped = stripComments(source);
  const safe = stripI18nCalls(stripped);
  const lines = safe.split("\n");
  let count = 0;
  for (const line of lines) {
    if (CJK_RE.test(line)) count++;
  }
  return count;
}

// ─── Test execution ─────────────────────────────────────────────────────────

const allViolations = [];
let totalFilesScanned = 0;

for (const relPath of UI_JS_FILES) {
  const violations = scanFileForUserVisibleChinese(relPath);
  allViolations.push(...violations);
  totalFilesScanned++;
}

for (const relPath of UI_HTML_FILES) {
  const violations = scanHtmlForMissingDataI18n(relPath);
  allViolations.push(...violations);
  totalFilesScanned++;
}

// Group violations by file for reporting
const violationsByFile = new Map();
for (const v of allViolations) {
  if (!violationsByFile.has(v.file)) violationsByFile.set(v.file, []);
  violationsByFile.get(v.file).push(v);
}

console.log(`\ni18n user-visible ratchet: scanned ${totalFilesScanned} files`);
console.log(`  Total user-visible Chinese violations found: ${allViolations.length}`);

if (violationsByFile.size > 0) {
  for (const [file, vs] of violationsByFile) {
    console.log(`\n  ${file}:`);
    for (const v of vs) {
      console.log(`    L${v.line} [${v.kind}]: ${v.snippet}`);
    }
  }
}

// Broad Chinese line counts (comments + t() calls stripped)
console.log(`\nBroad Chinese line counts (comments + t() calls stripped):`);
for (const relPath of UI_JS_FILES) {
  const count = countChineseLines(relPath);
  if (count >= 0) {
    console.log(`  ${relPath}: ${count}`);
  }
}

// ─── Assertions ─────────────────────────────────────────────────────────────

// 1. Strict user-visible violations: MUST be zero
//    toastr, confirm, prompt, textContent, innerHTML, attribute, setAttribute,
//    button-html, template-literal patterns must use t() lookups.
const strictKinds = [
  "toastr", "confirm", "prompt", "textContent", "innerHTML",
  "attribute", "setAttribute", "button-html", "template-literal",
];

const strictViolations = allViolations.filter((v) => strictKinds.includes(v.kind));

assert.equal(
  strictViolations.length,
  0,
  `Strict i18n violation(s) found (toastr/confirm/prompt/textContent/innerHTML/attribute/setAttribute/button-html/template-literal must use t()):\n` +
    strictViolations.map((v) => `  ${v.file}:L${v.line} [${v.kind}]: ${v.snippet}`).join("\n") +
    "\n\nReplace hardcoded Chinese with t() catalog lookups.",
);

// 2. Ratchet: total Chinese lines per file must not exceed baseline
for (const [file, baseline] of Object.entries(BASELINE)) {
  const current = countChineseLines(file);
  if (current < 0) continue; // file was skipped
  assert.ok(
    current <= baseline,
    `i18n ratchet violated for ${file}: found ${current} Chinese-containing lines (comments/t() stripped), baseline is ${baseline}. ` +
      `New hardcoded Chinese must use t() lookups instead.`,
  );
}

// 3. panel.html: HTML Chinese content without data-i18n must not grow beyond baseline
const htmlViolations = allViolations.filter((v) => UI_HTML_FILES.includes(v.file));
const HTML_BASELINE = 441; // panel.html has substantial unmigrated Chinese text
assert.ok(
  htmlViolations.length <= HTML_BASELINE,
  `panel.html has ${htmlViolations.length} Chinese content lines without data-i18n, expected ≤ ${HTML_BASELINE} (existing baseline):\n` +
    htmlViolations.map((v) => `  L${v.line} [${v.kind}]: ${v.snippet}`).join("\n"),
);

console.log("\ni18n user-visible ratchet tests passed");
