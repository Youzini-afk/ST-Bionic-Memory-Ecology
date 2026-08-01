import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const TEST_ROOT = path.resolve(process.cwd(), "tests");
const EXCLUDED_TESTS = new Set(["triviumdb-poc.mjs"]);
const PRODUCT_CONTRACT_TESTS = [
  "agent-context-window.mjs",
  "agent-journal.mjs",
  "agent-llm-transport-contract.mjs",
  "agent-loop.mjs",
  "agent-model-protocol.mjs",
  "agent-run-monitor.mjs",
  "agent-run-view.mjs",
  "agent-runtime-settings.mjs",
  "agent-token-counter.mjs",
  "agent-tool-registry.mjs",
  "authority-companion-module.mjs",
  "chat-transaction-coordinator.mjs",
  "conversation-identity-vnext.mjs",
  "ena-planner-plots.mjs",
  "event-binding-priority.mjs",
  "extraction-external-abort.mjs",
  "graph-agent-retriever.mjs",
  "recall-injection-plan.mjs",
  "graph-steward-agent.mjs",
  "identity-resolver.mjs",
  "indexeddb-sync.mjs",
  "llm-streaming.mjs",
  "luker-host-adapter.mjs",
  "manual-agent-extraction-route.mjs",
  "memory-branch.mjs",
  "memory-changeset.mjs",
  "memory-graph-projection.mjs",
  "memory-history-reconciliation.mjs",
  "memory-inbox.mjs",
  "memory-inbox-batch.mjs",
  "memory-ledger.mjs",
  "memory-ledger-indexeddb.mjs",
  "memory-ledger-storage.mjs",
  "memory-runtime-mode.mjs",
  "memory-runtime-mode-ui.mjs",
  "memory-query.mjs",
  "memory-steward-service.mjs",
  "memory-steward-tools.mjs",
  "message-updated-lightweight.mjs",
  "panel-bridge.mjs",
  "panel-ena-debug.mjs",
  "product-surface-contract.mjs",
  "recall-authoritative-generation-input.mjs",
  "recall-agent-service.mjs",
  "recall-candidate-packet.mjs",
  "recall-empty-persistence.mjs",
  "recall-empty-card-state.mjs",
  "recall-reapply-block.mjs",
  "recall-reroll-reuse.mjs",
  "task-presentation.mjs",
  "transient-agent-journal.mjs",
  "turn-artifact.mjs",
  "vector-backend-score.mjs",
  "vnext-architecture-contract.mjs",
  "vnext-product-invariants.mjs",
];

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
  const stableTests = await collectStableTests();
  const productContractOnly = process.argv.includes("--product-contract");
  const tests = productContractOnly
    ? PRODUCT_CONTRACT_TESTS.filter((name) => stableTests.includes(name))
    : stableTests;

  if (productContractOnly && tests.length !== PRODUCT_CONTRACT_TESTS.length) {
    const missing = PRODUCT_CONTRACT_TESTS.filter((name) => !stableTests.includes(name));
    throw new Error(`missing product contract tests: ${missing.join(", ")}`);
  }

  console.log(
    productContractOnly
      ? `[ST-BME][test-suite] running ${tests.length} product contract tests`
      : `[ST-BME][test-suite] running ${tests.length} stable tests (excluded: ${Array.from(EXCLUDED_TESTS).join(", ")})`,
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
