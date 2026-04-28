import assert from "node:assert/strict";

import {
  buildAuthorityDiagnosticsBundle,
  buildAuthorityDiagnosticsBundlePath,
  sanitizeDiagnosticsSettings,
  writeAuthorityDiagnosticsBundle,
} from "../maintenance/authority-diagnostics-bundle.js";

function createMockAdapter() {
  const calls = [];
  return {
    calls,
    async writeJson(path, payload, options = {}) {
      calls.push([path, payload, options]);
      return {
        ok: true,
        path,
        size: JSON.stringify(payload).length,
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
}

{
  const path = buildAuthorityDiagnosticsBundlePath("chat/main", "manual-export");
  assert.match(
    path,
    /^user\/files\/ST-BME_diagnostics_chat_main-manual-export-[a-z0-9]+-\d{8}-\d{6}\.json$/,
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

console.log("authority-diagnostics-bundle tests passed");
