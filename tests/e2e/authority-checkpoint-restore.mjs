import assert from "node:assert/strict";

import { buildLukerGraphCheckpointV2 } from "../../graph/graph-persistence.js";
import {
  applyAuthorityCheckpointToStore,
  buildAuthorityConsistencyAudit,
  buildAuthorityCheckpointImportSnapshot,
} from "../../maintenance/authority-consistency.js";
import { createAuthorityBlobAdapter } from "../../maintenance/authority-blob-adapter.js";
import { AuthorityGraphStore } from "../../sync/authority-graph-store.js";
import {
  createAuthorityE2eContext,
  createAuthorityE2eContractGraph,
  runAuthorityE2eStep,
} from "../helpers/authority-e2e-context.mjs";

const context = createAuthorityE2eContext({
  skipMessage:
    "authority checkpoint restore E2E skipped: set AUTHORITY_E2E_BASE_URL to run against a real Authority server",
});

if (context.skip) {
  console.log(context.skipMessage);
  process.exit(0);
}

const checkpointPath = String(
  context.env.AUTHORITY_E2E_CHECKPOINT_PATH ||
    `user/files/ST-BME_luker_checkpoint_${context.runId}-restore.json`,
);
const graph = createAuthorityE2eContractGraph(context.chatId, `${context.runId}-restore`, {
  revision: 5,
});
const checkpoint = buildLukerGraphCheckpointV2(graph, {
  revision: graph.meta.revision,
  chatId: context.chatId,
  integrity: `${context.runId}-integrity`,
  reason: "authority-e2e-checkpoint-restore",
  storageTier: "authority-e2e",
});

console.log(
  `authority-checkpoint-restore E2E started: ${JSON.stringify({
    baseUrl: context.baseUrl,
    chatId: context.chatId,
    checkpointPath,
  })}`,
);

await runAuthorityE2eStep("checkpoint-restore-roundtrip", async () => {
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
  const store = new AuthorityGraphStore(context.chatId, {
    baseUrl: context.baseUrl,
    fetchImpl: context.fetchImpl,
    headerProvider: context.headerProvider,
  });
  let deleteResult = null;
  try {
    const prepared = buildAuthorityCheckpointImportSnapshot(checkpoint, {
      chatId: context.chatId,
      path: checkpointPath,
      source: "authority-e2e-checkpoint-restore",
    });
    assert.equal(prepared.ok, true);

    const writeResult = await adapter.writeJson(checkpointPath, checkpoint, {
      metadata: {
        chatId: context.chatId,
        revision: graph.meta.revision,
        reason: "authority-e2e-checkpoint-restore",
        kind: "luker-checkpoint",
      },
    });
    assert.equal(writeResult.ok, true);

    await store.open();
    await store.clearAll();
    const restoreResult = await applyAuthorityCheckpointToStore(store, checkpoint, {
      chatId: context.chatId,
      path: checkpointPath,
      source: "authority-e2e-checkpoint-restore",
      markSyncDirty: false,
    });
    assert.equal(restoreResult.ok, true);
    assert.equal(restoreResult.restored, true);

    const snapshot = await store.exportSnapshot({ includeTombstones: false });
    assert.equal(snapshot.meta.chatId, context.chatId);
    assert.equal(snapshot.meta.revision, graph.meta.revision);
    assert.equal(snapshot.nodes.length, graph.nodes.length);
    assert.ok(snapshot.nodes.some((node) => node.id === graph.nodes[0].id));

    const blobRead = await adapter.readJson(checkpointPath);
    assert.equal(blobRead.exists, true);
    const audit = buildAuthorityConsistencyAudit({
      chatId: context.chatId,
      collectionId: context.collectionId,
      capability: {
        blobReady: true,
      },
      runtimeGraph: {
        meta: { revision: graph.meta.revision },
        nodes: graph.nodes,
        edges: graph.edges,
        vectorIndexState: {
          collectionId: context.collectionId,
          dirty: false,
        },
      },
      graphPersistenceState: {
        chatId: context.chatId,
        revision: graph.meta.revision,
        authorityBlobCheckpointPath: checkpointPath,
        authorityBlobCheckpointRevision: graph.meta.revision,
      },
      sqlSnapshot: snapshot,
      blobResult: {
        ok: true,
        exists: true,
        path: checkpointPath,
        checkpoint: blobRead.payload,
      },
      triviumStat: {
        revision: graph.meta.revision,
        namespace: context.collectionId,
        itemCount: graph.nodes.length,
        linkCount: graph.edges.length,
      },
    });
    assert.equal(audit.summary.level, "success");
    assert.equal(audit.drift.checkpointRestorable, true);
    return {
      revision: snapshot.meta.revision,
      nodes: snapshot.nodes.length,
      actions: audit.actions,
    };
  } finally {
    await store.clearAll().catch(() => null);
    await store.close().catch(() => null);
    deleteResult = await adapter.delete(checkpointPath).catch(() => null);
    if (deleteResult) {
      assert.equal(deleteResult.ok, true);
    }
  }
});

console.log("authority-checkpoint-restore E2E passed");
