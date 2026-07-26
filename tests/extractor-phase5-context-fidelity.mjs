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
  "  throw new Error('sendOpenAIRequest should not be called in phase5 fidelity test');",
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
const { defaultSettings } = await import("../runtime/settings-defaults.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

function collectAllPromptContent(captured) {
  return [
    String(captured.systemPrompt || ""),
    String(captured.userPrompt || ""),
    ...(Array.isArray(captured.promptMessages) ? captured.promptMessages : []).map(
      (message) => String(message.content || ""),
    ),
    ...(Array.isArray(captured.additionalMessages)
      ? captured.additionalMessages
      : []
    ).map((message) => String(message.content || "")),
  ].join("\n");
}

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  enabled = true,
  keys = [],
  positionType = "before_character_definition",
  role = "system",
  depth = 0,
  order = 10,
  strategyType = keys.length > 0 ? "selective" : "constant",
}) {
  return {
    uid,
    name,
    comment,
    content,
    enabled,
    position: {
      type: positionType,
      role,
      depth,
      order,
    },
    strategy: {
      type: strategyType,
      keys,
      keys_secondary: { logic: "and_any", keys: [] },
    },
    probability: 100,
    extra: {},
  };
}

const originalSillyTavern = globalThis.SillyTavern;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;
const originalTestContext = globalThis.__stBmeTestContext;

const worldbooksByName = {
  "main-book": [
    createWorldbookEntry({
      uid: 1,
      name: "主书常驻设定",
      content: "主世界书：蓝钥匙线索。",
      order: 10,
    }),
    createWorldbookEntry({
      uid: 2,
      name: "蓝钥匙触发条目",
      content: "主世界书命中：调查蓝钥匙时应关注旧城区。",
      keys: ["蓝钥匙"],
      order: 20,
    }),
  ],
  "persona-book": [
    createWorldbookEntry({
      uid: 3,
      name: "人格设定",
      content: "人格世界书：保持谨慎，不要忽略路线细节。",
      order: 10,
    }),
  ],
  "chat-book": [
    createWorldbookEntry({
      uid: 4,
      name: "聊天绑定设定",
      content: "聊天世界书：当前会话已锁定旧城区雨夜调查。",
      order: 10,
    }),
  ],
};

const fidelityMessages = [
  {
    seq: 30,
    role: "assistant",
    content: "<think>先推断</think><action>举灯</action>艾琳说：去调查蓝钥匙。",
    name: "艾琳",
    speaker: "艾琳",
  },
  {
    seq: 31,
    role: "assistant",
    content: "旁白补充：<status mood='tense'>雨夜</status>巷子很安静。",
    name: "旁白",
    speaker: "旁白",
  },
  {
    seq: 32,
    role: "user",
    content: "<plan>先记路线</plan>我会继续调查蓝钥匙。",
    name: "玩家",
    speaker: "玩家",
  },
];

globalThis.__stBmeTestContext = {
  chat: [
    { is_user: false, mes: "艾琳说：去调查蓝钥匙。", name: "艾琳" },
    { is_user: false, mes: "旁白补充：雨夜巷子很安静。", name: "旁白" },
    { is_user: true, mes: "我会继续调查蓝钥匙。", name: "玩家" },
  ],
  chatMetadata: {
    world: "chat-book",
  },
  extensionSettings: {
    persona_description_lorebook: "persona-book",
  },
  powerUserSettings: {
    persona_description: "用户设定：谨慎调查者",
  },
  characters: {
    1: {
      name: "艾琳",
      description: "角色描述：夜巡调查员",
      data: {
        description: "角色描述：夜巡调查员",
        extensions: {
          world: "main-book",
        },
      },
      extensions: {
        world: "main-book",
      },
    },
  },
  characterId: 1,
  name1: "玩家",
  name2: "艾琳",
  chatId: "phase5-context-fidelity",
};

globalThis.SillyTavern = {
  getContext() {
    return globalThis.__stBmeTestContext;
  },
};

globalThis.getCharWorldbookNames = () => ({
  primary: "main-book",
  additional: [],
});
globalThis.getWorldbook = async (worldbookName) =>
  worldbooksByName[String(worldbookName || "").trim()] || [];
globalThis.getLorebookEntries = async (worldbookName) =>
  (worldbooksByName[String(worldbookName || "").trim()] || []).map((entry) => ({
    uid: entry.uid,
    comment: entry.comment,
  }));

try {
  {
    const graph = createEmptyGraph();
    let captured = null;
    const restore = setTestOverrides({
      llm: {
        async callLLMForJSON(payload) {
          captured = payload;
          return { operations: [], cognitionUpdates: [], regionUpdates: {} };
        },
      },
    });

    try {
      const result = await extractMemories({
        graph,
        messages: fidelityMessages,
        startSeq: 30,
        endSeq: 32,
        schema: DEFAULT_NODE_SCHEMA,
        embeddingConfig: null,
        settings: {
          ...defaultSettings,
          extractAssistantExcludeTags: "think,action",
          extractWorldbookMode: "active",
        },
      });

      assert.equal(result.success, true);
      assert.ok(captured);

      const allContent = collectAllPromptContent(captured);
      assert.match(allContent, /角色描述：夜巡调查员/);
      assert.match(allContent, /用户设定：谨慎调查者/);
      assert.match(allContent, /主世界书：蓝钥匙线索。/);
      assert.match(allContent, /主世界书命中：调查蓝钥匙时应关注旧城区。/);
      assert.match(allContent, /人格世界书：保持谨慎，不要忽略路线细节。/);
      assert.match(allContent, /聊天世界书：当前会话已锁定旧城区雨夜调查。/);

      const recentBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "recentMessages");
      assert.ok(recentBlock, "recentMessages block should exist");
      const recentContent = String(recentBlock?.content || "");
      assert.match(recentContent, /#30 \[assistant\]: 艾琳说：去调查蓝钥匙。/);
      assert.match(
        recentContent,
        /#31 \[assistant\|旁白\]: 旁白补充：<status mood='tense'>雨夜<\/status>巷子很安静。/,
      );
      assert.match(
        recentContent,
        /#32 \[user\|玩家\]: <plan>先记路线<\/plan>我会继续调查蓝钥匙。/,
      );
      assert.doesNotMatch(recentContent, /<think>|<action>/);

      const worldInfoBeforeBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "worldInfoBefore");
      assert.ok(worldInfoBeforeBlock, "worldInfoBefore block should exist when worldbook is active");
      assert.match(String(worldInfoBeforeBlock?.content || ""), /蓝钥匙线索/);
    } finally {
      restore();
    }
  }

  {
    const graph = createEmptyGraph();
    let captured = null;
    const restore = setTestOverrides({
      llm: {
        async callLLMForJSON(payload) {
          captured = payload;
          return { operations: [], cognitionUpdates: [], regionUpdates: {} };
        },
      },
    });

    try {
      const result = await extractMemories({
        graph,
        messages: fidelityMessages,
        startSeq: 30,
        endSeq: 32,
        schema: DEFAULT_NODE_SCHEMA,
        embeddingConfig: null,
        settings: {
          ...defaultSettings,
          extractAssistantExcludeTags: "think,action",
          extractWorldbookMode: "none",
        },
      });

      assert.equal(result.success, true);
      assert.ok(captured);

      const allContent = collectAllPromptContent(captured);
      assert.match(allContent, /角色描述：夜巡调查员/);
      assert.match(allContent, /用户设定：谨慎调查者/);
      assert.doesNotMatch(allContent, /主世界书：蓝钥匙线索。/);
      assert.doesNotMatch(allContent, /主世界书命中：调查蓝钥匙时应关注旧城区。/);
      assert.doesNotMatch(allContent, /人格世界书：保持谨慎，不要忽略路线细节。/);
      assert.doesNotMatch(allContent, /聊天世界书：当前会话已锁定旧城区雨夜调查。/);

      const recentBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "recentMessages");
      assert.ok(recentBlock, "recentMessages block should still exist when worldbook is disabled");
      assert.match(String(recentBlock?.content || ""), /#30 \[assistant\]: 艾琳说：去调查蓝钥匙。/);
    } finally {
      restore();
    }
  }
} finally {
  if (originalSillyTavern === undefined) {
    delete globalThis.SillyTavern;
  } else {
    globalThis.SillyTavern = originalSillyTavern;
  }
  if (originalGetCharWorldbookNames === undefined) {
    delete globalThis.getCharWorldbookNames;
  } else {
    globalThis.getCharWorldbookNames = originalGetCharWorldbookNames;
  }
  if (originalGetWorldbook === undefined) {
    delete globalThis.getWorldbook;
  } else {
    globalThis.getWorldbook = originalGetWorldbook;
  }
  if (originalGetLorebookEntries === undefined) {
    delete globalThis.getLorebookEntries;
  } else {
    globalThis.getLorebookEntries = originalGetLorebookEntries;
  }
  if (originalTestContext === undefined) {
    delete globalThis.__stBmeTestContext;
  } else {
    globalThis.__stBmeTestContext = originalTestContext;
  }
}

console.log("extractor-phase5-context-fidelity tests passed");
