import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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
  "    name2: '',",
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
  "  throw new Error('sendOpenAIRequest should not be called in extractor-owner-scope test');",
  "}",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js" ||
      specifier === "../../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(extensionsShimSource)}`,
      };
    }
    if (
      specifier === "../../../../script.js" ||
      specifier === "../../../../../script.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(scriptShimSource)}`,
      };
    }
    if (
      specifier === "../../../../openai.js" ||
      specifier === "../../../../../openai.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(openAiShimSource)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createEmptyGraph, createNode, addNode } = await import("../graph/graph.js");
const { DEFAULT_NODE_SCHEMA } = await import("../graph/schema.js");
const { extractMemories } = await import("../maintenance/extractor.js");

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
  name2: "",
  chatId: "test-chat",
};

{
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "艾琳" },
      seq: 1,
    }),
  );
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "露西亚" },
      seq: 1,
    }),
  );
  globalThis.__stBmeTestContext.name2 = "群像卡";
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              action: "create",
              type: "pov_memory",
              fields: { summary: "有人觉得钟楼里还有问题" },
            },
          ],
          cognitionUpdates: [
            {
              knownRefs: ["evt-missing"],
            },
          ],
          regionUpdates: {},
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 3, role: "assistant", content: "多人场景测试" }],
      startSeq: 3,
      endSeq: 3,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    assert.equal(
      graph.nodes.filter((node) => !node.archived && node.type === "pov_memory").length,
      0,
    );
    assert.ok(Array.isArray(result.ownerWarnings));
    assert.ok(
      result.ownerWarnings.some((warning) => warning.kind === "invalid-owner-scope"),
    );
  } finally {
    restore();
  }
}

{
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "艾琳" },
      seq: 1,
    }),
  );
  globalThis.__stBmeTestContext.name2 = "艾琳";
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              action: "create",
              type: "pov_memory",
              fields: { summary: "艾琳觉得钟楼里藏着第二条暗道" },
            },
          ],
          cognitionUpdates: [],
          regionUpdates: {},
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 5, role: "assistant", content: "单角色场景测试" }],
      startSeq: 5,
      endSeq: 5,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    const povNode = graph.nodes.find(
      (node) => !node.archived && node.type === "pov_memory",
    );
    assert.ok(povNode);
    assert.equal(povNode.scope?.ownerType, "character");
    assert.equal(povNode.scope?.ownerName, "艾琳");
  } finally {
    restore();
  }
}

console.log("extractor-owner-scope tests passed");
