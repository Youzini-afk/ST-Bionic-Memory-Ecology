import assert from "node:assert/strict";

import { DEFAULT_NODE_SCHEMA } from "../../graph/schema.js";
import { ConversationEngine } from "../../src/core/conversation-engine.js";
import { getHistoryPrefixHash } from "../../src/core/history.js";
import { MemoryStateStore } from "../../src/core/memory-store.js";
import { DomainPipeline } from "../../src/domain/domain-pipeline.js";
import { materializeGraph, planGraphMutation } from "../../src/domain/graph-draft.js";
import { recallFromState } from "../../src/domain/recall-provider.js";
import { VectorJobWorker } from "../../src/vector/vector-job-worker.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });

function runtime() {
  let clock = 1000;
  let id = 0;
  const store = new MemoryStateStore({ now: () => ++clock, id: () => `domain-${++id}` });
  const engine = new ConversationEngine({ store });
  return { store, engine };
}

const messages = (assistant = "answer") => [
  { role: "user", speaker: "User", text: "question", hostIndex: 0 },
  { role: "assistant", speaker: "Assistant", text: assistant, hostIndex: 1 },
];

function fakeOperations(overrides = {}) {
  return {
    async extractMemories({ graph, endSeq }) {
      graph.nodes.push({
        id: "event-1",
        type: "event",
        fields: { summary: "answer" },
        seq: endSeq,
        seqRange: [endSeq, endSeq],
        archived: false,
        importance: 5,
        accessCount: 0,
        createdTime: 1,
        updatedAt: 1,
        lastAccessTime: 1,
      });
      return {
        success: true,
        newNodeIds: ["event-1"],
        changedNodeIds: ["event-1"],
        processedRange: [endSeq, endSeq],
      };
    },
    async analyzeAutoConsolidationGate() { return { triggered: false }; },
    async consolidateMemories({ graph }) {
      graph.nodes[0].fields.summary = "consolidated";
      return { merged: 1 };
    },
    async runHierarchicalSummaryPostProcess({ graph }) {
      graph.summaryState.entries.push({ id: "summary-1", status: "active", text: "summary" });
      graph.summaryState.activeEntryIds.push("summary-1");
      return { created: true };
    },
    async generateReflection({ graph }) {
      graph.nodes.push({
        id: "reflection-1",
        type: "reflection",
        fields: { insight: "insight" },
        seq: 1,
        seqRange: [1, 1],
        archived: false,
      });
      return "reflection-1";
    },
    sleepCycle(graph) {
      graph.nodes[0].archived = true;
      return { forgotten: 1 };
    },
    inspectAutoCompressionCandidates() { return { hasCandidates: true }; },
    async compressAll(graph) {
      graph.nodes.push({
        id: "compressed-1",
        type: "event",
        fields: { summary: "compressed" },
        seq: 1,
        seqRange: [1, 1],
        archived: false,
      });
      return { created: 1, archived: 0 };
    },
    validateVectorConfig() { return { valid: true }; },
    getVectorModelScope() { return "test:model"; },
    ...overrides,
  };
}

test("a local graph draft becomes normalized records without mutating the snapshot", async () => {
  const { store } = runtime();
  const state = await store.readConversation("draft");
  const planned = await planGraphMutation(state, (graph) => {
    graph.nodes.push({ id: "b", type: "event", fields: { summary: "b" } });
    graph.nodes.push({ id: "a", type: "event", fields: { summary: "a" } });
    graph.edges.push({ id: "e", fromId: "b", toId: "a", relation: "related" });
    graph.historyState.extractionCount = 1;
  });
  assert.equal(state.collections.nodes.size, 0);
  assert.deepEqual(planned.changeSet.changes.map(({ collection, id }) => `${collection}/${id}`).sort(), [
    "edges/e",
    "graphState/runtime",
    "nodes/a",
    "nodes/b",
  ]);

  await store.commit({
    chatKey: "draft",
    expectedRevision: 0,
    operation: "draft",
    basisHistoryLength: 0,
    basisHistoryHash: getHistoryPrefixHash([], 0),
    processedThroughAfter: -1,
    changeSet: planned.changeSet,
  });
  const graph = materializeGraph(await store.readConversation("draft"));
  const committedState = await store.readConversation("draft");
  assert.deepEqual(graph.nodes.map(({ id }) => id), ["b", "a"]);
  assert.equal(graph.edges[0].id, "e");
  assert.equal(graph.historyState.extractionCount, 1);
  assert.equal(graph.revision, committedState.head.graphRevision);
  assert.equal(Object.hasOwn(committedState.collections.graphState.get("runtime"), "revision"), false);
});

test("extraction and every maintenance phase commit separately and roll back as one suffix", async () => {
  const { store, engine } = runtime();
  const lease = engine.activate("chat-a");
  const snapshot = { chatKey: "chat-a", messages: messages() };
  await engine.reconcile(lease, snapshot.messages);
  const pipeline = new DomainPipeline({
    engine,
    operations: fakeOperations(),
    getSettings: () => ({
      enabled: true,
      extractAutoEnabled: true,
      extractEvery: 1,
      enableConsolidation: true,
      consolidationAutoMinNewNodes: 1,
      enableHierarchicalSummary: true,
      enableReflection: true,
      reflectEveryN: 1,
      enableSleepCycle: true,
      sleepEveryN: 1,
      enableAutoCompression: true,
      compressionEveryN: 1,
    }),
    getEmbeddingConfig: () => ({ mode: "direct" }),
  });
  const result = await pipeline.processAssistant({ lease, snapshot, messageId: 1 });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.stages.map(({ name, status }) => [name, status]), [
    ["extract", "committed"],
    ["consolidate", "committed"],
    ["summary", "committed"],
    ["reflection", "committed"],
    ["sleep", "committed"],
    ["compress", "committed"],
  ]);

  let state = await store.readConversation("chat-a");
  assert.deepEqual(state.transactions.map(({ operation }) => operation), [
    "extract", "consolidate", "summary", "reflection", "sleep", "compress",
  ]);
  assert.equal(state.head.processedThrough, 1);
  assert.equal((await store.listVectorJobs("chat-a")).length, 5);

  const reconciliation = await engine.reconcile(lease, [snapshot.messages[0]]);
  assert.deepEqual(reconciliation.rolledBackTransactions.map(({ operation }) => operation), [
    "extract", "consolidate", "summary", "reflection", "sleep", "compress",
  ]);
  state = await store.readConversation("chat-a");
  assert.equal(state.collections.nodes.size, 0);
  assert.equal(state.collections.graphState.size, 0);
  assert.equal(state.head.processedThrough, -1);
  assert.equal((await store.listVectorJobs("chat-a")).length, 6);
});

test("an assistant edit while extraction is running rejects the late draft", async () => {
  const { store, engine } = runtime();
  const lease = engine.activate("chat-a");
  const snapshot = { chatKey: "chat-a", messages: messages() };
  await engine.reconcile(lease, snapshot.messages);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const base = fakeOperations();
  const pipeline = new DomainPipeline({
    engine,
    operations: fakeOperations({
      async extractMemories(args) {
        started();
        await new Promise((resolve) => { release = resolve; });
        return base.extractMemories(args);
      },
    }),
    getSettings: () => ({
      enabled: true,
      extractAutoEnabled: true,
      extractEvery: 1,
      enableHierarchicalSummary: false,
      enableAutoCompression: false,
    }),
    getEmbeddingConfig: () => ({ mode: "direct" }),
  });
  const pending = pipeline.processAssistant({ lease, snapshot, messageId: 1 });
  await startedPromise;
  await engine.reconcile(lease, messages("edited"));
  release();
  await assert.rejects(pending, /history basis changed/);
  assert.equal((await store.readConversation("chat-a")).collections.nodes.size, 0);
});

test("switching chats rejects a late extraction even when its history did not change", async () => {
  const { store, engine } = runtime();
  const lease = engine.activate("chat-a");
  const snapshot = { chatKey: "chat-a", messages: messages() };
  await engine.reconcile(lease, snapshot.messages);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const base = fakeOperations();
  const pipeline = new DomainPipeline({
    engine,
    operations: fakeOperations({
      async extractMemories(args) {
        started();
        await new Promise((resolve) => { release = resolve; });
        return base.extractMemories(args);
      },
    }),
    getSettings: () => ({
      enabled: true,
      extractAutoEnabled: true,
      extractEvery: 1,
      enableHierarchicalSummary: false,
      enableAutoCompression: false,
    }),
    getEmbeddingConfig: () => ({ mode: "direct" }),
  });
  const pending = pipeline.processAssistant({ lease, snapshot, messageId: 1 });
  await startedPromise;
  engine.activate("chat-b");
  release();
  await assert.rejects(pending, { name: "LeaseExpiredError" });
  assert.equal((await store.readConversation("chat-a")).collections.nodes.size, 0);
});

test("the full recall adapter formats output and returns access reinforcement as a ChangeSet", async () => {
  const { store } = runtime();
  await store.commit({
    chatKey: "recall",
    expectedRevision: 0,
    operation: "seed",
    basisHistoryLength: 0,
    basisHistoryHash: getHistoryPrefixHash([], 0),
    processedThroughAfter: -1,
    vectorModelScope: "pending-scope",
    enqueueVectorJob: true,
    changeSet: {
      changes: [{
        collection: "nodes",
        id: "event-1",
        before: null,
        after: {
          id: "event-1",
          type: "event",
          fields: { summary: "remember this" },
          seq: 1,
          seqRange: [1, 1],
          archived: false,
          accessCount: 0,
          importance: 5,
          createdTime: 1,
        },
      }],
    },
  });
  const state = await store.readConversation("recall");
  const result = await recallFromState({
    state,
    input: "remember",
    history: messages(),
    settings: { recallEnabled: true, recallLlmContextMessages: 4 },
    schema: DEFAULT_NODE_SCHEMA,
    retrieveFn: async ({ graph, recentMessages, options, settings }) => {
      assert.deepEqual(recentMessages, ["[user]: question", "[assistant]: answer"]);
      assert.equal(options.enableVectorPrefilter, false);
      assert.equal(settings.authorityGraphQueryEnabled, false);
      const node = graph.nodes[0];
      node.accessCount += 1;
      return {
        summaryEntries: [],
        coreNodes: [],
        recallNodes: [node],
        groupedRecallNodes: { state: [], episodic: [node], reflective: [], rule: [], other: [] },
        scopeBuckets: null,
        selectedNodeIds: [node.id],
        meta: {},
        stats: { coreCount: 0, recallCount: 1 },
      };
    },
  });
  assert.deepEqual(result.selectedNodeIds, ["event-1"]);
  assert.match(result.injectionText, /remember this/);
  assert.equal(result.changeSet.changes.find(({ id }) => id === "event-1").after.accessCount, 1);
});

test("a persisted vector job rebuilds current scope and replay stays idempotent", async () => {
  const { store, engine } = runtime();
  const lease = engine.activate("vector-chat");
  const history = messages();
  const reconciled = await engine.reconcile(lease, history);
  await engine.commit(lease, {
    expectedRevision: reconciled.head.revision,
    operation: "extract",
    basisHistoryLength: 2,
    basisHistoryHash: getHistoryPrefixHash(reconciled.head.history),
    processedThroughAfter: 1,
    vectorModelScope: "old-scope",
    enqueueVectorJob: true,
    changeSet: {
      changes: [{
        collection: "nodes",
        id: "vector-node",
        before: null,
        after: { id: "vector-node", type: "event", fields: { summary: "vector" } },
      }],
    },
  });

  let syncCalls = 0;
  const worker = new VectorJobWorker({
    engine,
    store,
    getEmbeddingConfig: () => ({ mode: "direct", model: "new" }),
    vectorApi: {
      validateVectorConfig: () => ({ valid: true }),
      getVectorModelScope: () => "new-scope",
      async syncGraph(graph) {
        syncCalls += 1;
        graph.nodes[0].embedding = [0.25, 0.75];
        graph.vectorIndexState.modelScope = "new-scope";
        graph.vectorIndexState.dirty = false;
        return { stats: { indexed: 1 } };
      },
    },
  });
  let result = await worker.drain("vector-chat");
  assert.equal(result.status, "completed");
  assert.equal(result.processed, 1);
  assert.equal(syncCalls, 1);
  let state = await store.readConversation("vector-chat");
  assert.deepEqual(state.collections.nodes.get("vector-node").embedding, [0.25, 0.75]);
  assert.deepEqual(state.transactions.map(({ operation }) => operation), ["extract", "vector-sync"]);
  const completed = await store.listVectorJobs("vector-chat", { status: "completed" });
  assert.equal(completed[0].outcome, "rebuilt-current-scope");

  await store.settleVectorJobs({
    chatKey: "vector-chat",
    ids: completed.map(({ id }) => id),
    status: "pending",
    outcome: "replay",
  });
  result = await worker.drain("vector-chat");
  assert.equal(result.status, "completed");
  assert.equal(syncCalls, 2);
  state = await store.readConversation("vector-chat");
  assert.equal(state.collections.nodes.size, 1);
  assert.equal(state.transactions.length, 2);
});

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`vNext domain: ${passed}/${tests.length} passed`);
