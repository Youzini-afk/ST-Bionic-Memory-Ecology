import assert from "node:assert/strict";

import { MemoryStateStore } from "../../src/core/memory-store.js";
import {
  createPluginRuntime,
  GRAPH_TRANSFER_FORMAT,
  GRAPH_TRANSFER_VERSION,
} from "../../src/runtime/plugin-runtime.js";
import {
  createDefaultSettings,
  normalizeSettings,
} from "../../src/runtime/settings.js";
import { resolveRecallCandidateSelection } from "../../prompting/prompt-node-references.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });

function hostFixture() {
  const listeners = new Map();
  const state = {
    chatId: "runtime-chat",
    chat: [
      { is_user: true, name: "User", mes: "question" },
      { is_user: false, name: "Assistant", mes: "answer" },
    ],
  };
  const context = {
    get chatId() { return state.chatId; },
    get chat() { return state.chat; },
    name1: "User",
    name2: "Assistant",
    setExtensionPrompt() {},
    eventTypes: {},
    eventSource: {
      on(name, listener) { listeners.set(name, listener); },
      off(name) { listeners.delete(name); },
    },
  };
  const documentLike = {
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
  };
  return { state, context, documentLike };
}

function vectorApi() {
  return {
    getVectorConfigFromSettings: () => ({ mode: "direct", apiUrl: "test", model: "test" }),
    validateVectorConfig: () => ({ valid: true, error: "" }),
    getVectorModelScope: () => "test:scope",
    async syncGraphVectorIndex() { return { stats: { indexed: 0 } }; },
  };
}

test("recall LLM selection accepts only current candidate keys", () => {
  const candidateKeyToNodeId = { R1: "score-first", R2: "second" };
  const legacy = resolveRecallCandidateSelection(
    { selected_ids: ["second"] },
    candidateKeyToNodeId,
    1,
  );
  assert.equal(legacy.hasSelectedKeysField, false);
  assert.deepEqual(legacy.rawSelectedKeys, []);
  assert.deepEqual(legacy.resolvedSelectedNodeIds, []);

  const current = resolveRecallCandidateSelection(
    { selected_keys: ["R2", "NOPE", "R2"] },
    candidateKeyToNodeId,
    1,
  );
  assert.equal(current.hasSelectedKeysField, true);
  assert.equal(current.selectedKeysIsArray, true);
  assert.deepEqual(current.rawSelectedKeys, ["R2", "NOPE"]);
  assert.deepEqual(current.resolvedSelectedKeys, ["R2"]);
  assert.deepEqual(current.resolvedSelectedNodeIds, ["second"]);

  const invalid = resolveRecallCandidateSelection(
    { selected_keys: "R1" },
    candidateKeyToNodeId,
    1,
  );
  assert.equal(invalid.selectedKeysIsArray, false);
  assert.deepEqual(invalid.resolvedSelectedNodeIds, []);
});

test("v9 settings are a clean namespace and ENA defaults explicitly off", () => {
  const defaults = createDefaultSettings();
  assert.equal(defaults.primary, "indexeddb");
  assert.equal(defaults.ena.enabled, false);
  assert.ok(Object.values(defaults.taskProfiles).every(({ profiles }) =>
    profiles.every((profile) =>
      profile.blocks.every((block) => block.type !== "legacyPrompt") &&
      !Object.keys(profile.metadata).some((key) => /legacy|migrat/i.test(key)))));
  assert.throws(() => normalizeSettings({ st_bme: {} }), /unknown BME v9 setting/);
  assert.throws(() => normalizeSettings({ primary: "auto" }), /primary must be one of/);

  const legacyBlock = structuredClone(defaults.taskProfiles);
  legacyBlock.recall.profiles[0].blocks[0].type = "legacyPrompt";
  assert.throws(() => normalizeSettings({ taskProfiles: legacyBlock }), /type is unsupported/);
  assert.throws(() => normalizeSettings({
    globalTaskRegex: { ...defaults.globalTaskRegex, stages: { finalPrompt: true } },
  }), /unsupported regex stage/);
});

test("production runtime pins one Primary and writes graph changes through its outbox", async () => {
  const host = hostFixture();
  const store = new MemoryStateStore();
  let persisted = null;
  const runtime = await createPluginRuntime({
    settings: createDefaultSettings(),
    store,
    vectorApi: vectorApi(),
    getContext: () => host.context,
    getCurrentChatId: () => host.state.chatId,
    getHostContext: () => ({}),
    documentLike: host.documentLike,
    recall: async () => ({ selectedNodeIds: [], injectionText: "", tokenEstimate: 0 }),
    domains: { async processAssistant() { return { status: "idle" }; } },
    persistSettings(next) { persisted = next; },
    logger: { error() {}, warn() {} },
  });
  await runtime.start();
  assert.equal(runtime.activePrimary, "indexeddb");

  const changed = await runtime.saveSettings({ primary: "authority" });
  assert.equal(changed.reloadRequired, true);
  assert.equal(changed.settings.primary, "authority");
  assert.equal(persisted.primary, "authority");
  assert.equal(runtime.activePrimary, "indexeddb");

  const transfer = {
    format: GRAPH_TRANSFER_FORMAT,
    version: GRAPH_TRANSFER_VERSION,
    graph: {
      nodes: [{
        id: "node-1",
        type: "event",
        level: 0,
        parentId: null,
        childIds: [],
        prevId: null,
        nextId: null,
        fields: { summary: "memory" },
        importance: 5,
        archived: false,
      }],
      edges: [],
      historyContext: {},
    },
  };
  await runtime.importGraph(transfer);
  let snapshot = await runtime.snapshot();
  assert.equal(snapshot.graph.nodes[0].fields.summary, "memory");
  assert.equal(snapshot.vectorJobs.filter(({ status }) => status === "pending").length, 1);

  await runtime.updateNode("node-1", {
    fields: { summary: "edited" },
    importance: 7,
    archived: false,
  });
  snapshot = await runtime.snapshot();
  assert.equal(snapshot.graph.nodes[0].fields.summary, "edited");
  assert.equal(snapshot.graph.nodes[0].importance, 7);
  const exported = JSON.parse(await runtime.exportGraph());
  assert.equal(exported.format, GRAPH_TRANSFER_FORMAT);
  assert.equal(exported.graph.nodes[0].embedding, null);

  await runtime.deleteNode("node-1");
  snapshot = await runtime.snapshot();
  assert.equal(snapshot.graph.nodes.length, 0);
  assert.ok(snapshot.vectorJobs.filter(({ status }) => status === "pending").length >= 2);
  await runtime.dispose();
});

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`v9 runtime: ${passed}/${tests.length} passed`);
