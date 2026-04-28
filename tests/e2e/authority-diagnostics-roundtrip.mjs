import assert from "node:assert/strict";

import {
  buildAuthorityDiagnosticsBundle,
  buildAuthorityPerformanceBaseline,
  writeAuthorityDiagnosticsBundle,
} from "../../maintenance/authority-diagnostics-bundle.js";
import { createAuthorityBlobAdapter } from "../../maintenance/authority-blob-adapter.js";
import {
  createAuthorityE2eContext,
  createAuthorityE2eContractGraph,
  runAuthorityE2eStep,
} from "../helpers/authority-e2e-context.mjs";

const context = createAuthorityE2eContext({
  skipMessage:
    "authority diagnostics E2E skipped: set AUTHORITY_E2E_BASE_URL to run against a real Authority server",
});

if (context.skip) {
  console.log(context.skipMessage);
  process.exit(0);
}

const diagnosticsPath = String(
  context.env.AUTHORITY_E2E_DIAGNOSTICS_PATH || `st-bme/e2e/${context.runId}/diagnostics.json`,
);
const graph = createAuthorityE2eContractGraph(context.chatId, `${context.runId}-diagnostics`, {
  revision: 3,
});
const graphPersistence = {
  chatId: context.chatId,
  revision: graph.meta.revision,
  loadState: "loaded",
  loadDiagnostics: {
    source: "authority-sql",
    totalMs: 12,
    hydrateMs: 4,
    updatedAt: new Date().toISOString(),
  },
  persistDelta: {
    totalMs: 8,
    commitMs: 3,
    commitPayloadBytes: 256,
    updatedAt: new Date().toISOString(),
  },
  authorityRecentJobs: [
    { id: `${context.runId}-job-ok`, queueState: "success" },
    { id: `${context.runId}-job-running`, queueState: "running" },
  ],
  authorityLastJobId: `${context.runId}-job-running`,
  authorityLastJobStatus: "running",
  authorityConsistencyState: "success",
  authorityBlobCheckpointPath: `st-bme/e2e/${context.runId}/checkpoint.json`,
  authorityBlobCheckpointRevision: graph.meta.revision,
};
const baseline = buildAuthorityPerformanceBaseline({
  chatId: context.chatId,
  graphPersistence,
  graph,
  consistencyAudit: {
    issues: [],
    sql: { revision: graph.meta.revision },
    trivium: { revision: graph.meta.revision },
    blob: { revision: graph.meta.revision },
    summary: { level: "success" },
  },
});

console.log(
  `authority-diagnostics-roundtrip E2E started: ${JSON.stringify({
    baseUrl: context.baseUrl,
    chatId: context.chatId,
    namespace: context.namespace,
    diagnosticsPath,
  })}`,
);

await runAuthorityE2eStep("diagnostics-roundtrip", async () => {
  const adapter = createAuthorityBlobAdapter(
    {
      authorityBaseUrl: context.baseUrl,
      authorityBlobNamespace: context.namespace,
    },
    {
      fetchImpl: context.fetchImpl,
      headerProvider: context.headerProvider,
    },
  );
  const bundle = buildAuthorityDiagnosticsBundle({
    chatId: context.chatId,
    reason: "authority-e2e-diagnostics-roundtrip",
    settings: {
      authorityBaseUrl: context.baseUrl,
      authorityApiKey: "secret-for-redaction-check",
    },
    graphPersistence,
    graph,
    runtimeStatus: {
      text: "authority-e2e",
      level: "success",
      updatedAt: Date.now(),
    },
    performanceBaseline: baseline,
    lastExtract: graph.nodes.slice(0, 1),
    lastRecall: graph.nodes.slice(1),
  });
  assert.equal(bundle.settings.authorityApiKey, "[REDACTED]");
  let deleteResult = null;
  try {
    const writeResult = await writeAuthorityDiagnosticsBundle(adapter, bundle, {
      chatId: context.chatId,
      reason: "authority-e2e-diagnostics-roundtrip",
      path: diagnosticsPath,
    });
    assert.equal(writeResult.ok, true);

    const statResult = await adapter.stat(diagnosticsPath);
    assert.equal(statResult.exists, true);

    const readResult = await adapter.readJson(diagnosticsPath);
    assert.equal(readResult.exists, true);
    assert.equal(readResult.payload.kind, "st-bme-authority-diagnostics");
    assert.equal(readResult.payload.chatId, context.chatId);
    assert.equal(readResult.payload.performanceBaseline.graphRevision, graph.meta.revision);
    assert.equal(readResult.payload.settings.authorityApiKey, "[REDACTED]");
    return {
      path: writeResult.path,
      graphRevision: readResult.payload.performanceBaseline.graphRevision,
      nodeCount: readResult.payload.graphSummary.nodeCount,
    };
  } finally {
    deleteResult = await adapter.delete(diagnosticsPath).catch(() => null);
    if (deleteResult) {
      assert.equal(deleteResult.ok, true);
    }
  }
});

console.log("authority-diagnostics-roundtrip E2E passed");
