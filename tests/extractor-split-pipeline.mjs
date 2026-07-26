import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return globalThis.__stBmeTestContext || {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '玩家',",
  "    name2: '艾琳',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
].join("\n");

const openAiShimSource = [
  "export const chat_completion_sources = {};",
  "export async function sendOpenAIRequest() {",
  "  throw new Error('sendOpenAIRequest should not be called in extractor-split-pipeline test');",
  "}",
].join("\n");

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
  {
    specifiers: [
      "../../../../openai.js",
      "../../../../../openai.js",
    ],
    url: toDataModuleUrl(openAiShimSource),
  },
]);

const { createEmptyGraph, createNode, addNode } = await import("../graph/graph.js");
const { DEFAULT_NODE_SCHEMA } = await import("../graph/schema.js");
const { extractMemories } = await import("../maintenance/extractor.js");
const { defaultSettings } = await import("../runtime/settings-defaults.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

globalThis.__stBmeTestContext = {
  chat: [],
  chatMetadata: {},
  extensionSettings: {},
  powerUserSettings: {},
  characters: {},
  characterId: null,
  name1: "玩家",
  name2: "艾琳",
  chatId: "test-chat",
};

function createGraphWithCharacter() {
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "艾琳" },
      seq: 1,
    }),
  );
  return graph;
}

const baseExtractParams = {
  messages: [
    { seq: 20, role: "user", content: "钟楼里传来第二次钟声。", name: "玩家", speaker: "玩家" },
    { seq: 21, role: "assistant", content: "艾琳记下钟声，怀疑暗道就在附近。", name: "艾琳", speaker: "艾琳" },
  ],
  startSeq: 20,
  endSeq: 21,
  schema: DEFAULT_NODE_SCHEMA,
  embeddingConfig: null,
};

function objectivePayload() {
  return {
    operations: [
      {
        action: "create",
        type: "event",
        ref: "evt-clock",
        fields: {
          title: "钟楼钟声",
          summary: "钟楼传来第二次钟声，暗示暗道线索仍在附近。",
          participants: "玩家,艾琳",
          status: "ongoing",
        },
        scope: { layer: "objective" },
      },
    ],
    cognitionUpdates: [
      {
        ownerType: "character",
        ownerName: "艾琳",
        knownRefs: ["evt-clock"],
      },
    ],
    regionUpdates: {},
  };
}

function subjectivePayload() {
  return {
    operations: [
      {
        action: "create",
        type: "pov_memory",
        fields: {
          summary: "艾琳把第二次钟声记成暗道仍在呼唤她的证据。",
          belief: "暗道就在钟楼附近",
          emotion: "警觉",
          certainty: "unsure",
          about: "evt-clock",
        },
        scope: {
          layer: "pov",
          ownerType: "character",
          ownerName: "艾琳",
          ownerId: "艾琳",
        },
      },
    ],
    cognitionUpdates: [
      {
        ownerType: "character",
        ownerName: "艾琳",
        knownRefs: ["evt-clock"],
      },
    ],
    regionUpdates: {},
  };
}

function activeNodes(graph, type) {
  return graph.nodes.filter((node) => node.type === type && node.archived !== true);
}

function hasActiveEdgeBetween(graph, leftId, rightId) {
  return graph.edges.some((edge) => {
    if (edge.invalidAt || edge.expiredAt) return false;
    return (
      (edge.fromId === leftId && edge.toId === rightId) ||
      (edge.fromId === rightId && edge.toId === leftId)
    );
  });
}

function characterKnowledgeEntries(graph) {
  return Object.values(graph.knowledgeState?.owners || {}).filter(
    (entry) =>
      String(entry?.ownerType || "") === "character" &&
      String(entry?.ownerName || "") === "艾琳",
  );
}

async function captureTaskTypesForExtract(settings, options = {}) {
  const graph = createGraphWithCharacter();
  const capturedTaskTypes = [];
  const capturedPayloads = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        capturedPayloads.push(payload);
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") return subjectivePayload();
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const params = {
      graph,
      ...baseExtractParams,
    };
    if (options.includeSettings !== false) {
      params.settings = settings;
    }
    const result = await extractMemories(params);
    return { graph, result, capturedTaskTypes, capturedPayloads };
  } finally {
    restore();
  }
}

// Phase 4 default switch: omitting settings should use the split pipeline by default.
{
  const { result, capturedTaskTypes } = await captureTaskTypesForExtract(undefined, {
    includeSettings: false,
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    capturedTaskTypes,
    ["extract_objective", "extract_subjective"],
    "extractMemories without explicit settings should default to split objective+subjective extraction",
  );
}

// The default settings object should always use objective+subjective split extraction.
{
  const { result, capturedTaskTypes, capturedPayloads } = await captureTaskTypesForExtract({
    ...defaultSettings,
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    capturedTaskTypes,
    ["extract_objective", "extract_subjective"],
    "defaultSettings should call split objective+subjective extraction",
  );
  const subjectivePayloadText = JSON.stringify(
    capturedPayloads.find((payload) => payload.taskType === "extract_subjective") || {},
  );
  const subjectivePayload = capturedPayloads.find(
    (payload) => payload.taskType === "extract_subjective",
  );
  assert.doesNotMatch(
    subjectivePayloadText,
    /objectiveRefMap/,
    "subjective extraction prompt should NOT receive objective draft/ref context (decoupled)",
  );
  assert.doesNotMatch(
    subjectivePayloadText,
    /objectiveExtractionDraft/,
    "subjective extraction prompt should NOT receive raw objective draft",
  );
  assert.match(
    subjectivePayloadText,
    /activeCharacterOwner/,
    "subjective extraction prompt should receive independently built ownerContext",
  );
}

// Removed legacy knobs are ignored and must not revive the old single extract task.
for (const legacyPatch of [
  { extractPrompt: "CUSTOM LEGACY EXTRACT PROMPT" },
  { extractPipelineVersion: "legacy-single" },
  {
    taskProfiles: {
      ...defaultSettings.taskProfiles,
      extract: {
        activeProfileId: "legacy-custom",
        profiles: [
          {
            id: "legacy-custom",
            taskType: "extract",
            builtin: false,
            blocks: [],
          },
        ],
      },
    },
  },
]) {
  const { result, capturedTaskTypes } = await captureTaskTypesForExtract({
    ...defaultSettings,
    ...legacyPatch,
  });

  assert.equal(result.success, true);
  assert.deepEqual(capturedTaskTypes, ["extract_objective", "extract_subjective"]);
  assert.equal(capturedTaskTypes.includes("extract"), false);
}

// split-v1 calls objective and subjective, merges both stage outputs, and commits once.
{
  const graph = createGraphWithCharacter();
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") return subjectivePayload();
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: defaultSettings,
    });

    assert.deepEqual(
      capturedTaskTypes,
      ["extract_objective", "extract_subjective"],
      "split-v1 should call the LLM once for objective extraction and once for subjective extraction",
    );
    assert.equal(result.success, true);
    assert.equal(result.newNodes, 2, "objective event and subjective POV memory should be committed together");

    const [eventNode] = activeNodes(graph, "event");
    const [povNode] = activeNodes(graph, "pov_memory");
    assert.ok(eventNode, "objective event operation should be committed");
    assert.ok(povNode, "subjective pov_memory operation should be committed");
    assert.equal(povNode.scope?.ownerType, "character");
    assert.equal(povNode.scope?.ownerName, "艾琳");
    assert.equal(graph.lastProcessedSeq, 21);
    assert.ok(
      hasActiveEdgeBetween(graph, eventNode.id, povNode.id),
      "merged split stages should be committed as one batch so default batch edges see both nodes",
    );

    const knowledgeEntry = characterKnowledgeEntries(graph).find((entry) =>
      Array.isArray(entry.knownNodeIds) && entry.knownNodeIds.includes(eventNode.id),
    );
    assert.ok(
      knowledgeEntry,
      "subjective cognitionUpdates should apply through the merged ref map",
    );
  } finally {
    restore();
  }
}

// Invalid subjective output fails the split extraction before any objective-only commit mutates the graph.
{
  const graph = createGraphWithCharacter();
  const initialNodeCount = graph.nodes.length;
  const initialEdgeCount = graph.edges.length;
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") return { thought: "missing operations" };
        return { thought: "legacy path should not be used for split-v1" };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: defaultSettings,
    });

    assert.deepEqual(
      capturedTaskTypes,
      ["extract_objective", "extract_subjective"],
      "split-v1 should validate both objective and subjective payloads before commit",
    );
    assert.equal(result.success, false);
    assert.equal(graph.nodes.length, initialNodeCount, "invalid subjective payload should not commit objective nodes");
    assert.equal(graph.edges.length, initialEdgeCount, "invalid subjective payload should not create edges");
    assert.equal(graph.lastProcessedSeq ?? -1, -1, "invalid split extraction should not advance extraction progress");
  } finally {
    restore();
  }
}

// Parallel mode (default): objective and subjective start before either resolves.
{
  let objectiveStarted = false;
  let subjectiveStarted = false;
  let objectiveResolve;
  const objectivePromise = new Promise((resolve) => { objectiveResolve = resolve; });
  let subjectiveResolve;
  const subjectivePromise = new Promise((resolve) => { subjectiveResolve = resolve; });

  const startOrder = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        if (payload.taskType === "extract_objective") {
          objectiveStarted = true;
          startOrder.push("objective_start");
          await objectivePromise;
          return objectivePayload();
        }
        if (payload.taskType === "extract_subjective") {
          subjectiveStarted = true;
          startOrder.push("subjective_start");
          await subjectivePromise;
          return subjectivePayload();
        }
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const graph = createGraphWithCharacter();
    const extractPromise = extractMemories({
      graph,
      ...baseExtractParams,
      settings: { ...defaultSettings, extractSplitExecutionMode: "parallel" },
    });

    // Let the event loop turn so both stages can start.
    await new Promise((r) => setTimeout(r, 0));

    // Both should have started before we resolve either.
    assert.ok(objectiveStarted, "parallel: objective should have started");
    assert.ok(subjectiveStarted, "parallel: subjective should have started before objective resolved");
    assert.ok(
      startOrder.includes("objective_start") && startOrder.includes("subjective_start"),
      "parallel: both stages should have started concurrently",
    );

    // Now resolve both to let extraction finish.
    objectiveResolve();
    subjectiveResolve();
    const result = await extractPromise;
    assert.equal(result.success, true, "parallel extraction should succeed after both stages complete");
  } finally {
    restore();
  }
}

// Serial mode preserves the old escape behavior: invalid objective output does not start subjective.
{
  const graph = createGraphWithCharacter();
  const initialNodeCount = graph.nodes.length;
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        if (payload.taskType === "extract_objective") return { thought: "missing operations" };
        if (payload.taskType === "extract_subjective") return subjectivePayload();
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: { ...defaultSettings, extractSplitExecutionMode: "serial" },
    });

    assert.deepEqual(
      capturedTaskTypes,
      ["extract_objective"],
      "serial: invalid objective output should not start subjective extraction",
    );
    assert.equal(result.success, false);
    assert.equal(graph.nodes.length, initialNodeCount, "serial objective failure should not commit nodes");
  } finally {
    restore();
  }
}

// Serial mode: subjective does not start until objective resolves.
{
  let objectiveStarted = false;
  let subjectiveStarted = false;
  let objectiveResolve;
  const objectivePromise = new Promise((resolve) => { objectiveResolve = resolve; });

  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        if (payload.taskType === "extract_objective") {
          objectiveStarted = true;
          await objectivePromise;
          return objectivePayload();
        }
        if (payload.taskType === "extract_subjective") {
          subjectiveStarted = true;
          return subjectivePayload();
        }
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const graph = createGraphWithCharacter();
    const extractPromise = extractMemories({
      graph,
      ...baseExtractParams,
      settings: { ...defaultSettings, extractSplitExecutionMode: "serial" },
    });

    // Let the event loop turn.
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(objectiveStarted, "serial: objective should have started");
    assert.ok(!subjectiveStarted, "serial: subjective should NOT have started while objective is pending");

    // Resolve objective so subjective can proceed.
    objectiveResolve();
    const result = await extractPromise;
    assert.equal(result.success, true, "serial extraction should succeed after both stages complete sequentially");
    assert.ok(subjectiveStarted, "serial: subjective should have started after objective resolved");
  } finally {
    restore();
  }
}

// Invalid subjective operation action must fail before any valid objective operation mutates the graph.
{
  const graph = createGraphWithCharacter();
  const initialNodeCount = graph.nodes.length;
  const initialEdgeCount = graph.edges.length;
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") {
          return {
            operations: [
              {
                action: "nonsense",
                type: "pov_memory",
                fields: { summary: "非法主观操作不应让客观节点先写入" },
              },
            ],
            cognitionUpdates: [],
            regionUpdates: {},
          };
        }
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: { ...defaultSettings, extractSplitExecutionMode: "parallel" },
    });

    assert.equal(result.success, false);
    assert.match(result.error, /未知操作类型/);
    assert.equal(graph.nodes.length, initialNodeCount, "invalid merged action should not partially create objective nodes");
    assert.equal(graph.edges.length, initialEdgeCount, "invalid merged action should not partially create edges");
    assert.equal(graph.lastProcessedSeq ?? -1, -1, "invalid merged action should not advance extraction progress");
  } finally {
    restore();
  }
}

console.log("extractor-split-pipeline tests passed");
