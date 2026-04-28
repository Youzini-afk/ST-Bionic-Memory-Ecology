import assert from "node:assert/strict";

import { probeAuthorityCapabilities } from "../../runtime/authority-capabilities.js";
import { AuthorityGraphStore } from "../../sync/authority-graph-store.js";
import {
  deleteAuthorityTriviumNodes,
  filterAuthorityTriviumNodes,
  normalizeAuthorityVectorConfig,
  purgeAuthorityTriviumNamespace,
  queryAuthorityTriviumNeighbors,
  searchAuthorityTriviumNodes,
  syncAuthorityTriviumLinks,
  upsertAuthorityTriviumEntries,
} from "../../vector/authority-vector-primary-adapter.js";
import {
  buildAuthorityJobIdempotencyKey,
  createAuthorityJobAdapter,
} from "../../maintenance/authority-job-adapter.js";
import { createAuthorityBlobAdapter } from "../../maintenance/authority-blob-adapter.js";
import {
  buildAuthorityE2eVectorEntries,
  createAuthorityE2eContext,
  createAuthorityE2eContractGraph,
  createAuthorityE2eContractNode,
  runAuthorityE2eStep,
} from "../helpers/authority-e2e-context.mjs";

const context = createAuthorityE2eContext({
  skipMessage:
    "authority-server-primary E2E skipped: set AUTHORITY_E2E_BASE_URL to run against a real Authority server",
});

if (context.skip) {
  console.log(context.skipMessage);
  process.exit(0);
}
const resolvedBaseUrl = context.baseUrl;
const { chatId, namespace, collectionId, blobPath, fetchImpl, headerProvider, runId } = context;
const graph = createAuthorityE2eContractGraph(chatId, runId);

const runContext = {
  baseUrl: resolvedBaseUrl,
  chatId,
  namespace,
  collectionId,
  blobPath,
};

console.log(`authority-server-primary E2E started: ${JSON.stringify(runContext)}`);

await runAuthorityE2eStep("probe", async () => {
  const state = await probeAuthorityCapabilities({
    settings: { authorityBaseUrl: resolvedBaseUrl },
    fetchImpl,
    headerProvider,
    allowRelativeUrl: false,
  });
  assert.equal(state.installed, true);
  assert.equal(state.healthy, true);
  return {
    endpoint: state.endpoint,
    features: state.features,
    missingFeatures: state.missingFeatures,
  };
});

await runAuthorityE2eStep("sql", async () => {
  const store = new AuthorityGraphStore(chatId, {
    baseUrl: resolvedBaseUrl,
    fetchImpl,
    headerProvider,
  });
  try {
    await store.open();
    const importResult = await store.importSnapshot(graph, {
      mode: "replace",
      preserveRevision: true,
      markSyncDirty: false,
    });
    assert.equal(importResult.imported.nodes, graph.nodes.length);
    assert.equal(importResult.imported.edges, graph.edges.length);

    const commitResult = await store.commitDelta(
      {
        upsertNodes: [createAuthorityE2eContractNode(`${runId}-node-c`, "Authority E2E Gamma", Date.now())],
        runtimeMetaPatch: { authorityE2eRunId: runId },
      },
      { reason: "authority-e2e-contract", markSyncDirty: false },
    );
    assert.ok(commitResult.revision >= importResult.revision);

    const snapshot = await store.exportSnapshot({ includeTombstones: false });
    assert.equal(snapshot.meta.chatId, chatId);
    assert.ok(snapshot.nodes.some((node) => node.id === graph.nodes[0].id));
    assert.ok(snapshot.nodes.some((node) => node.id === `${runId}-node-c`));
    return {
      revision: snapshot.meta.revision,
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
    };
  } finally {
    await store.clearAll().catch(() => null);
    await store.close().catch(() => null);
  }
});

await runAuthorityE2eStep("trivium", async () => {
  const config = normalizeAuthorityVectorConfig({ authorityBaseUrl: resolvedBaseUrl });
  const entries = buildAuthorityE2eVectorEntries(graph);
  await purgeAuthorityTriviumNamespace(config, {
    namespace,
    collectionId,
    chatId,
    fetchImpl,
    headerProvider,
  }).catch(() => null);

  try {
    const upsertResult = await upsertAuthorityTriviumEntries(graph, config, entries, {
      namespace,
      collectionId,
      chatId,
      modelScope: "authority-e2e",
      revision: 1,
      fetchImpl,
      headerProvider,
    });
    assert.equal(upsertResult.upserted, entries.length);

    const linkResult = await syncAuthorityTriviumLinks(graph, config, {
      namespace,
      collectionId,
      chatId,
      revision: 1,
      fetchImpl,
      headerProvider,
    });
    assert.equal(linkResult.linked, graph.edges.length);

    const searchResults = await searchAuthorityTriviumNodes(graph, "Authority E2E Alpha", config, {
      namespace,
      collectionId,
      chatId,
      topK: 5,
      fetchImpl,
      headerProvider,
    });
    assert.ok(Array.isArray(searchResults));

    const filteredIds = await filterAuthorityTriviumNodes(config, {
      namespace,
      collectionId,
      chatId,
      topK: 10,
      where: { chatId, archived: false },
      searchText: "Authority E2E",
      fetchImpl,
      headerProvider,
    });
    assert.ok(Array.isArray(filteredIds));

    const neighborIds = await queryAuthorityTriviumNeighbors(config, [graph.nodes[0].id], {
      namespace,
      collectionId,
      chatId,
      topK: 5,
      fetchImpl,
      headerProvider,
    });
    assert.ok(Array.isArray(neighborIds));

    return {
      upserted: upsertResult.upserted,
      linked: linkResult.linked,
      searchResults: searchResults.length,
      filteredIds: filteredIds.length,
      neighborIds: neighborIds.length,
    };
  } finally {
    await deleteAuthorityTriviumNodes(config, graph.nodes.map((node) => node.id), {
      namespace,
      collectionId,
      chatId,
      fetchImpl,
      headerProvider,
    }).catch(() => null);
    await purgeAuthorityTriviumNamespace(config, {
      namespace,
      collectionId,
      chatId,
      fetchImpl,
      headerProvider,
    }).catch(() => null);
  }
});

await runAuthorityE2eStep("jobs", async () => {
  const adapter = createAuthorityJobAdapter(
    {
      authorityBaseUrl: resolvedBaseUrl,
      pollIntervalMs: 500,
      waitTimeoutMs: context.jobWaitTimeoutMs,
    },
    {
      fetchImpl,
      headerProvider,
    },
  );
  const listBefore = await adapter.listPage({ limit: 5 });
  assert.ok(Array.isArray(listBefore.jobs));

  const kind = String(context.env.AUTHORITY_E2E_JOB_KIND || "authority.vector.rebuild");
  const idempotencyKey = buildAuthorityJobIdempotencyKey({
    kind,
    chatId,
    collectionId,
    revision: 1,
  });
  const submitted = await adapter.submit(
    kind,
    {
      chatId,
      collectionId,
      namespace,
      modelScope: "authority-e2e",
      source: "authority-e2e-contract",
      purge: false,
      dryRun: true,
      contractSmoke: true,
      idempotencyKey,
    },
    { idempotencyKey },
  );
  assert.ok(submitted.id);

  const waited = await adapter.waitForCompletion(submitted.id, {
    timeoutMs: context.jobWaitTimeoutMs,
    pollIntervalMs: 500,
  });
  assert.ok(waited.id || waited.status);

  const requeued = await adapter.requeue(submitted.id, { safe: true });
  assert.ok(requeued.id || requeued.status);

  const listAfter = await adapter.listPage({ limit: 5 });
  assert.ok(Array.isArray(listAfter.jobs));
  return {
    listBefore: listBefore.jobs.length,
    submitted: submitted.id,
    waitedStatus: waited.status,
    requeuedStatus: requeued.status,
    listAfter: listAfter.jobs.length,
  };
});

await runAuthorityE2eStep("blob", async () => {
  const adapter = createAuthorityBlobAdapter(
    { authorityBaseUrl: resolvedBaseUrl, authorityBlobNamespace: namespace },
    { fetchImpl, headerProvider },
  );
  const payload = {
    runId,
    chatId,
    collectionId,
    createdAt: new Date().toISOString(),
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    },
  };
  try {
    const writeResult = await adapter.writeJson(blobPath, payload, {
      metadata: { chatId, runId, purpose: "authority-e2e-contract" },
    });
    assert.equal(writeResult.ok, true);

    const statResult = await adapter.stat(blobPath);
    assert.equal(statResult.exists, true);

    const readResult = await adapter.readJson(blobPath);
    assert.equal(readResult.exists, true);
    assert.equal(readResult.payload.runId, runId);
    return {
      path: writeResult.path,
      size: writeResult.size,
      etag: writeResult.etag,
    };
  } finally {
    const deleteResult = await adapter.delete(blobPath).catch(() => null);
    if (deleteResult) assert.equal(deleteResult.ok, true);
  }
});

console.log("authority-server-primary E2E passed");
