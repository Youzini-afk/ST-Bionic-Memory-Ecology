import assert from "node:assert/strict";

import {
  buildAuthorityDiagnosticsBundle,
  buildAuthorityDiagnosticsBundlePath,
  buildAuthorityDiagnosticsManifestPath,
  buildAuthorityPerformanceBaseline,
  readAuthorityDiagnosticsManifest,
  removeAuthorityDiagnosticsManifestEntry,
  sanitizeDiagnosticsSettings,
  upsertAuthorityDiagnosticsManifestEntry,
  writeAuthorityDiagnosticsBundle,
} from "../maintenance/authority-diagnostics-bundle.js";

function createMockAdapter() {
  const calls = [];
  const storage = new Map();
  return {
    calls,
    storage,
    async writeJson(path, payload, options = {}) {
      storage.set(path, structuredClone(payload));
      calls.push([path, payload, options]);
      return {
        ok: true,
        path,
        size: JSON.stringify(payload).length,
      };
    },
    async readJson(path) {
      if (!storage.has(path)) {
        return {
          exists: false,
          path,
        };
      }
      return {
        exists: true,
        path,
        payload: structuredClone(storage.get(path)),
      };
    },
    async delete(path) {
      const existed = storage.delete(path);
      return {
        ok: true,
        path,
        deleted: existed,
        missing: !existed,
      };
    },
  };
}

{
  const sanitized = sanitizeDiagnosticsSettings({
    authorityBaseUrl: "https://example.test",
    authorityApiKey: "secret-1",
    nested: {
      embeddingApiKey: "secret-2",
      label: "ok",
    },
    models: [
      { name: "a", token: "secret-3" },
      { name: "b", enabled: true },
    ],
  });
  assert.equal(sanitized.authorityBaseUrl, "https://example.test");
  assert.equal(sanitized.authorityApiKey, "[REDACTED]");
  assert.equal(sanitized.nested.embeddingApiKey, "[REDACTED]");
  assert.equal(sanitized.nested.label, "ok");
  assert.equal(sanitized.models[0].token, "[REDACTED]");
}

{
  const baseline = buildAuthorityPerformanceBaseline({
    chatId: "chat/main",
    graphPersistence: {
      chatId: "chat/main",
      revision: 12,
      loadState: "loaded",
      loadDiagnostics: {
        source: "authority-sql",
        totalMs: 45,
        hydrateMs: 18,
      },
      persistDelta: {
        totalMs: 22,
        commitMs: 8,
        commitPayloadBytes: 2048,
      },
      authorityRecentJobs: [
        { id: "job-1", queueState: "success" },
        { id: "job-2", queueState: "failed" },
      ],
      authorityLastJobId: "job-2",
      authorityLastJobStatus: "failed",
      authorityConsistencyState: "warning",
      authorityBlobCheckpointRevision: 11,
      authorityDiagnosticsBundlePath: "user/files/diag.json",
      authorityDiagnosticsBundleSize: 512,
    },
    graph: {
      chatId: "chat/main",
      meta: { revision: 12 },
      nodes: [{ id: "n1" }, { id: "n2" }],
      edges: [{ id: "e1" }],
      historyState: { extractionCount: 5 },
    },
    consistencyAudit: {
      issues: [{ code: "revision-drift" }],
      sql: { revision: 12 },
      trivium: { revision: 10 },
      blob: { revision: 11 },
    },
  });
  assert.equal(baseline.kind, "authority-performance-baseline");
  assert.equal(baseline.graphRevision, 12);
  assert.equal(baseline.graphNodeCount, 2);
  assert.equal(baseline.soak.recentJobCount, 2);
  assert.equal(baseline.soak.failedJobCount, 1);
  assert.equal(baseline.audit.issueCount, 1);
  assert.equal(baseline.artifacts.diagnosticsBundlePath, "user/files/diag.json");
}

{
  const bundle = buildAuthorityDiagnosticsBundle({
    chatId: "chat/main",
    reason: "manual-export",
    settings: {
      authorityApiKey: "secret-1",
      authorityBlobEnabled: true,
    },
    runtimeStatus: {
      text: "待命",
      meta: "准备就绪",
      level: "idle",
      updatedAt: 1,
    },
    runtimeDebug: {
      runtimeDebug: {
        injections: {
          recall: {
            retrievalMeta: {
              authorityCandidateUsed: true,
            },
          },
        },
      },
    },
    graphPersistence: {
      authorityBlobState: "active",
      authorityLastBlobPath: "user/files/demo.json",
    },
    graph: {
      nodes: [
        { id: "n1", type: "memory", archived: false },
        { id: "n2", type: "summary", archived: true },
      ],
      edges: [{ id: "e1" }],
      historyState: {
        chatId: "chat/main",
        extractionCount: 4,
        lastProcessedAssistantFloor: 12,
        activeRegion: "archive",
        activeRecallOwnerKeys: ["character:Alice"],
      },
      vectorIndexState: {
        mode: "authority",
        source: "authority-trivium",
        dirty: false,
        collectionId: "collection-1",
        hashToNodeId: {
          a: "n1",
        },
      },
      summaryState: {
        enabled: true,
        lastSummarizedExtractionCount: 3,
      },
    },
    lastExtractionStatus: {
      text: "提取完成",
      meta: "ok",
      level: "success",
      updatedAt: 2,
    },
    lastVectorStatus: {
      text: "向量完成",
      meta: "ok",
      level: "success",
      updatedAt: 3,
    },
    lastRecallStatus: {
      text: "召回完成",
      meta: "ok",
      level: "success",
      updatedAt: 4,
    },
    lastBatchStatus: {
      ok: true,
      stage: "finalize",
    },
    lastInjection: "A".repeat(4500),
    lastExtract: [{ id: "n1" }],
    lastRecall: [{ id: "n2" }],
    performanceBaseline: {
      kind: "authority-performance-baseline",
      graphRevision: 9,
      load: { totalMs: 12 },
    },
  });

  assert.equal(bundle.kind, "st-bme-authority-diagnostics");
  assert.equal(bundle.chatId, "chat/main");
  assert.equal(bundle.settings.authorityApiKey, "[REDACTED]");
  assert.equal(bundle.graphSummary.nodeCount, 2);
  assert.equal(bundle.graphSummary.activeNodeCount, 1);
  assert.equal(bundle.graphSummary.archivedNodeCount, 1);
  assert.equal(bundle.graphSummary.edgeCount, 1);
  assert.equal(bundle.lastInjection.textLength, 4500);
  assert.equal(bundle.lastInjection.textPreview.length, 4000);
  assert.equal(bundle.recentExtractedItems.length, 1);
  assert.equal(bundle.recentRecalledItems.length, 1);
  assert.equal(bundle.performanceBaseline?.graphRevision, 9);
}

{
  const path = buildAuthorityDiagnosticsBundlePath("chat/main", "manual-export");
  assert.match(
    path,
    /^user\/files\/ST-BME_diagnostics_chat_main-manual-export-[a-z0-9]+-\d{8}-\d{6}\.json$/,
  );
}

{
  const manifestPath = buildAuthorityDiagnosticsManifestPath("chat/main");
  assert.match(
    manifestPath,
    /^user\/files\/ST-BME_diagnostics_manifest_chat_main-[a-z0-9]+\.json$/,
  );
}

{
  const adapter = createMockAdapter();
  const bundle = buildAuthorityDiagnosticsBundle({
    chatId: "chat-main",
    reason: "manual-export",
    settings: {},
  });
  const result = await writeAuthorityDiagnosticsBundle(adapter, bundle, {
    chatId: "chat-main",
    reason: "manual-export",
  });
  assert.equal(result.ok, true);
  assert.match(
    result.path,
    /^user\/files\/ST-BME_diagnostics_chat-main-manual-export-[a-z0-9]+-\d{8}-\d{6}\.json$/,
  );
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0][2]?.metadata?.kind, "diagnostics-bundle");
  assert.equal(adapter.calls[0][2]?.metadata?.chatId, "chat-main");
}

{
  const adapter = createMockAdapter();
  await upsertAuthorityDiagnosticsManifestEntry(adapter, {
    chatId: "chat-main",
    path: "user/files/diag-a.json",
    reason: "manual-export",
    size: 100,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await upsertAuthorityDiagnosticsManifestEntry(adapter, {
    chatId: "chat-main",
    path: "user/files/diag-b.json",
    reason: "scheduled-export",
    size: 120,
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  const readResult = await readAuthorityDiagnosticsManifest(adapter, {
    chatId: "chat-main",
  });
  assert.equal(readResult.exists, true);
  assert.equal(readResult.entries.length, 2);
  assert.equal(readResult.entries[0].path, "user/files/diag-b.json");
  assert.equal(readResult.entries[1].path, "user/files/diag-a.json");

  const removeResult = await removeAuthorityDiagnosticsManifestEntry(
    adapter,
    "user/files/diag-a.json",
    { chatId: "chat-main" },
  );
  assert.equal(removeResult.removed, true);
  assert.equal(removeResult.entries.length, 1);
  assert.equal(removeResult.entries[0].path, "user/files/diag-b.json");
}

console.log("authority-diagnostics-bundle tests passed");
