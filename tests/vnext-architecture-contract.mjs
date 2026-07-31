import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowedImports = Object.freeze({
  domain: new Set(["domain"]),
  application: new Set(["application", "domain", "agent", "storage", "projection"]),
  agent: new Set(["agent", "domain"]),
  storage: new Set(["storage", "domain"]),
  projection: new Set(["projection", "domain", "graph", "runtime"]),
});

async function collect(directory) {
  const absolute = path.join(root, directory);
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(relative)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relative);
  }
  return files;
}

function importedLayer(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
  return resolved.split("/")[0] || null;
}

for (const [layer, allowed] of Object.entries(allowedImports)) {
  const files = await collect(layer);
  for (const file of files) {
    const source = await fs.readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(
      source,
      /(?:globalThis|window)\.(?:SillyTavern|Luker|TavernHelper|Mvu)\b/,
      `${file} reads a host global outside host/`,
    );
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const dependencyLayer = importedLayer(file, match[1]);
      if (!dependencyLayer || !allowedImports[dependencyLayer]) continue;
      assert.ok(
        allowed.has(dependencyLayer),
        `${file} imports forbidden layer ${dependencyLayer}: ${match[1]}`,
      );
    }
  }
}

console.log("vNext architecture contract tests passed");
