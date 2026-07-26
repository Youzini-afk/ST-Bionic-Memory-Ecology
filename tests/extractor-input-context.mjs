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
  "  throw new Error('sendOpenAIRequest should not be called in extractor-input-context test');",
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

const { createEmptyGraph } = await import("../graph/graph.js");
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
  name2: "艾琳",
  chatId: "test-chat",
};

const graph = createEmptyGraph();
let captured = null;
const restore = setTestOverrides({
  llm: {
    async callLLMForJSON(payload) {
      captured = payload;
      return {
        operations: [],
        cognitionUpdates: [],
        regionUpdates: {},
      };
    },
  },
});

try {
  const result = await extractMemories({
    graph,
    messages: [
      {
        seq: 10,
        role: "assistant",
        content: "<think>隐式思维</think>继续说明",
        name: "艾琳",
        speaker: "艾琳",
      },
      {
        seq: 11,
        role: "user",
        content: "用户输入",
        name: "玩家",
        speaker: "玩家",
      },
    ],
    startSeq: 10,
    endSeq: 11,
    schema: DEFAULT_NODE_SCHEMA,
    embeddingConfig: null,
    settings: {
      extractAssistantExcludeTags: "think",
    },
  });

  assert.equal(result.success, true);
  assert.ok(captured);
  assert.ok(captured.debugContext);
  assert.ok(captured.debugContext.inputContext);
  assert.equal(captured.debugContext.inputContext.rawMessageCount, 2);
  assert.equal(captured.debugContext.inputContext.filteredMessageCount, 2);
  assert.equal(captured.debugContext.inputContext.changedAssistantMessageCount, 1);
  assert.equal(captured.debugContext.inputContext.excludedAssistantMessageCount, 1);

  const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
    (message) => message.sourceKey === "recentMessages",
  );
  assert.ok(recentBlock);
  assert.match(String(recentBlock?.content || ""), /#10 \[assistant\]: 继续说明/);
  assert.match(String(recentBlock?.content || ""), /#11 \[user\|玩家\]: 用户输入/);
  assert.doesNotMatch(String(recentBlock?.content || ""), /#10 \[assistant\|艾琳\]:/);
  assert.doesNotMatch(String(recentBlock?.content || ""), /隐式思维|<think>/);
} finally {
  restore();
}

console.log("extractor-input-context tests passed");
