import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These are migration budgets, not approved architecture. Each phase removes
// entries as the matching host access moves behind host/. A stale entry fails.
const LEGACY_DIRECT_HOST_IMPORTS = new Set();

const LEGACY_DIRECT_HOST_GLOBALS = new Set();

const MAX_COORDINATOR_LINES = Object.freeze({
  "index.js": 18_393,
  "ui/panel.js": 14_976,
});

async function collectSourceFiles(relativeDir = "") {
  const absoluteDir = path.join(PROJECT_ROOT, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if ([".git", "node_modules", "tests", "vendor"].includes(entry.name)) continue;
    const relativePath = path.posix.join(relativeDir.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(relativePath);
    }
  }

  return files;
}

function importsSillyTavernInternals(source) {
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  return imports.some((specifier) =>
    /(?:^|\/)(?:script|extensions|openai)\.js(?:\?.*)?$/.test(specifier) ||
    /\/regex\/engine\.js(?:\?.*)?$/.test(specifier),
  );
}

function readsHostGlobals(source) {
  return /\b(?:globalThis|window)\.(?:SillyTavern|Luker|TavernHelper|Mvu|EjsTemplate|chat_metadata|this_chid|characters)\b/.test(
    source,
  );
}

function assertShrinkingBudget({ files, offenders, allowlist, label }) {
  const unexpected = offenders.filter((file) => !file.startsWith("host/") && !allowlist.has(file));
  const stale = [...allowlist].filter((file) => !offenders.includes(file));

  assert.deepEqual(
    unexpected,
    [],
    `${label} escaped host/: ${unexpected.join(", ")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `${label} migration budget is stale; remove: ${stale.join(", ")}`,
  );
  assert.ok(files.length > 0, "source scan unexpectedly found no files");
}

const files = await collectSourceFiles();
const sources = new Map(
  await Promise.all(
    files.map(async (file) => [file, await fs.readFile(path.join(PROJECT_ROOT, file), "utf8")]),
  ),
);

assertShrinkingBudget({
  files,
  offenders: files.filter((file) => importsSillyTavernInternals(sources.get(file))),
  allowlist: LEGACY_DIRECT_HOST_IMPORTS,
  label: "direct SillyTavern imports",
});

assertShrinkingBudget({
  files,
  offenders: files.filter((file) => readsHostGlobals(sources.get(file))),
  allowlist: LEGACY_DIRECT_HOST_GLOBALS,
  label: "direct SillyTavern globals",
});

for (const [file, maxLines] of Object.entries(MAX_COORDINATOR_LINES)) {
  const lineCount = sources.get(file).split(/\r?\n/).length - 1;
  assert.ok(
    lineCount <= maxLines,
    `${file} grew from the phase-0 ceiling (${lineCount} > ${maxLines}); move ownership out instead`,
  );
}

console.log("architecture boundary ratchets passed");
