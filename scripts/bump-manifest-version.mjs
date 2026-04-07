import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function incrementVersion(version) {
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("manifest.json version is missing.");
  }

  const segments = version.split(".").map((segment) => {
    if (!/^\d+$/.test(segment)) {
      throw new Error(`Unsupported version segment: ${segment}`);
    }
    return Number(segment);
  });

  if (!segments.length) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  let carry = 1;
  for (let index = segments.length - 1; index >= 0 && carry; index -= 1) {
    segments[index] += carry;
    if (index > 0 && segments[index] >= 10) {
      segments[index] = 0;
      carry = 1;
    } else {
      carry = 0;
    }
  }

  return segments.join(".");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const manifestPath = path.resolve(process.cwd(), process.env.MANIFEST_PATH || "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const currentVersion = manifest?.version;
  const nextVersion = incrementVersion(currentVersion);

  if (dryRun) {
    console.log(`${currentVersion} -> ${nextVersion}`);
    return;
  }

  manifest.version = nextVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Updated manifest version: ${currentVersion} -> ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
