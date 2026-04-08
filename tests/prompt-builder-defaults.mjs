import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '',",
  "    name2: '',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
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
    return nextResolve(specifier, context);
  },
});

const { buildTaskLlmPayload, buildTaskPrompt } = await import("../prompting/prompt-builder.js");
const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
const { initializeHostAdapter } = await import("../host/adapter/index.js");

const settings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};

const extractPromptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "角色描述",
  userPersona: "用户设定",
  recentMessages: "A: 你好\nB: 世界",
  graphStats: "node_count=3",
  schema: "event(title, summary)",
  currentRange: "1 ~ 2",
});
const extractPayload = buildTaskLlmPayload(extractPromptBuild, "fallback-user");
assert.equal(extractPayload.systemPrompt, "");
assert.equal(extractPayload.userPrompt, "");
assert.equal(
  extractPayload.promptMessages.filter((message) => message.role === "user").length,
  2,
);
assert.deepEqual(
  extractPayload.promptMessages
    .filter((message) => message.role === "user")
    .map((message) => message.blockName),
  ["输出格式", "行为规则"],
);
const extractFormatBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "输出格式",
);
const extractRulesBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "行为规则",
);
assert.match(String(extractFormatBlock?.content || ""), /cognitionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /regionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /batchStoryTime/);
assert.match(String(extractFormatBlock?.content || ""), /storyTime/);
assert.match(String(extractRulesBlock?.content || ""), /涉及到的角色都尽量尝试补 cognitionUpdates/);
assert.match(String(extractRulesBlock?.content || ""), /batchStoryTime/);
assert.deepEqual(
  extractPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "recentMessages",
    "graphStats",
    "schema",
    "currentRange",
  ],
);

const recallPromptBuild = await buildTaskPrompt(settings, "recall", {
  taskName: "recall",
  charDescription: "角色描述",
  userPersona: "用户设定",
  recentMessages: "上下文",
  userMessage: "用户最新发言",
  candidateNodes: "候选 1\n候选 2",
  sceneOwnerCandidates: "character:alice\ncharacter:bob",
  graphStats: "candidate_count=2",
});
const recallPayload = buildTaskLlmPayload(recallPromptBuild, "fallback-user");
assert.equal(recallPayload.systemPrompt, "");
assert.equal(recallPayload.userPrompt, "");
assert.equal(
  recallPayload.promptMessages.filter((message) => message.role === "user").length,
  2,
);
assert.deepEqual(
  recallPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "recentMessages",
    "userMessage",
    "candidateNodes",
    "sceneOwnerCandidates",
    "graphStats",
  ],
);
const recallFormatBlock = recallPayload.promptMessages.find(
  (message) => message.blockName === "输出格式",
);
const recallRulesBlock = recallPayload.promptMessages.find(
  (message) => message.blockName === "行为规则",
);
assert.match(String(recallFormatBlock?.content || ""), /active_owner_keys/);
assert.match(String(recallFormatBlock?.content || ""), /active_owner_scores/);
assert.match(String(recallRulesBlock?.content || ""), /剧情时间/);

const formatterCalls = [];
initializeHostAdapter({
  regexProvider: {
    getTavernRegexes() {
      return [];
    },
    isCharacterTavernRegexesEnabled() {
      return true;
    },
    formatAsTavernRegexedString(text, source, destination, options) {
      formatterCalls.push({ text, source, destination, options });
      if (source === "ai_output") {
        return String(text || "").replace(/<action>.*?<\/action>/g, "");
      }
      if (source === "user_input") {
        return String(text || "").replace(/<u>|<\/u>/g, "");
      }
      return String(text || "");
    },
  },
});

const regexAwarePromptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "",
  userPersona: "",
  recentMessages: "这里会被 chatMessages 回填",
  chatMessages: [
    {
      seq: 36,
      role: "assistant",
      content: "<action>挥手</action>继续说明",
    },
    {
      seq: 37,
      role: "user",
      content: "用户<u>输入</u>",
    },
  ],
  graphStats: "node_count=1",
  schema: "event(title, summary)",
  currentRange: "36 ~ 37",
});
const regexAwarePayload = buildTaskLlmPayload(
  regexAwarePromptBuild,
  "fallback-user",
);
const regexAwareRecentBlock = regexAwarePayload.promptMessages.find(
  (message) => message.sourceKey === "recentMessages",
);
assert.match(String(regexAwareRecentBlock?.content || ""), /#36 \[assistant\]: 继续说明/);
assert.match(String(regexAwareRecentBlock?.content || ""), /#37 \[user\]: 用户输入/);
assert.doesNotMatch(String(regexAwareRecentBlock?.content || ""), /action|<u>|<\/u>/i);
assert.equal(
  formatterCalls.some(
    (call) =>
      call.source === "ai_output" &&
      call.destination === "prompt" &&
      call.options?.depth === 1 &&
      call.options?.isPrompt === true,
  ),
  true,
);
assert.equal(
  formatterCalls.some(
    (call) =>
      call.source === "user_input" &&
      call.destination === "prompt" &&
      call.options?.depth === 0 &&
      call.options?.isPrompt === true,
  ),
  true,
);

initializeHostAdapter({});

console.log("prompt-builder-defaults tests passed");
