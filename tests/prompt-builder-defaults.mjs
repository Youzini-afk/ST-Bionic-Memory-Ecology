import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

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
]);

const { buildTaskLlmPayload, buildTaskPrompt } = await import("../prompting/prompt-builder.js");
const {
  createBuiltinPromptBlock,
  createDefaultGlobalTaskRegex,
  createDefaultTaskProfiles,
} = await import("../prompting/prompt-profiles.js");
const { initializeHostAdapter } = await import("../host/adapter/index.js");

const settings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};

await assert.rejects(
  () => buildTaskPrompt(settings, "extract", { taskName: "extract" }),
  /Unsupported task type: extract/,
);

const extractPromptBuild = await buildTaskPrompt(settings, "extract_objective", {
  taskName: "extract_objective",
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
assert.deepEqual(
  extractPayload.promptMessages
    .filter((message) => message.role === "user")
    .map((message) => message.blockName),
  ["输出格式", "行为规则"],
);
assert.deepEqual(
  extractPayload.promptMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.blockName),
  ["身份确认", "信息确认", "规则确认"],
);
const extractFormatBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "输出格式",
);
const extractRulesBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "行为规则",
);
assert.doesNotMatch(String(extractFormatBlock?.content || ""), /cognitionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /regionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /batchStoryTime/);
assert.match(String(extractFormatBlock?.content || ""), /storyTime/);
assert.match(String(extractRulesBlock?.content || ""), /HARD GATE/);
assert.match(String(extractRulesBlock?.content || ""), /常见错误/);
assert.match(String(extractRulesBlock?.content || ""), /batchStoryTime/);
assert.deepEqual(
  extractPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "graphStats",
    "schema",
    "currentRange",
    "recentMessages",
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
assert.deepEqual(
  recallPayload.promptMessages
    .filter((message) => message.role === "user")
    .map((message) => message.blockName),
  ["输出格式", "行为规则"],
);
assert.deepEqual(
  recallPayload.promptMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.blockName),
  ["身份确认", "信息确认", "规则确认"],
);
assert.deepEqual(
  recallPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "graphStats",
    "sceneOwnerCandidates",
    "candidateNodes",
    "recentMessages",
    "userMessage",
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
assert.match(String(recallFormatBlock?.content || ""), /selected_keys/);
assert.match(String(recallRulesBlock?.content || ""), /剧情时间/);
assert.match(String(recallRulesBlock?.content || ""), /评分召回/);

const globalRegexPromptBuild = await buildTaskPrompt(
  {
    taskProfilesVersion: 3,
    taskProfiles: createDefaultTaskProfiles(),
    globalTaskRegex: createDefaultGlobalTaskRegex(),
  },
  "recall",
  {
    taskName: "recall",
    recentMessages:
      "最近消息 <thinking>隐藏思维</thinking> <choice>1. 隐藏选项</choice>",
    userMessage:
      "用户输入 <updatevariable>secret</updatevariable> <status_current_variable>hp=3</status_current_variable>",
    candidateNodes:
      "候选节点 <StatusPlaceHolderImpl/> <analysis>隐藏分析</analysis>",
  },
);
assert.doesNotMatch(
  JSON.stringify(globalRegexPromptBuild),
  /<thinking|<choice|<updatevariable|<status_current_variable|<StatusPlaceHolderImpl|<analysis/i,
);

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

const regexAwarePromptBuild = await buildTaskPrompt(settings, "extract_objective", {
  taskName: "extract_objective",
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

const splitContextTaskProfiles = createDefaultTaskProfiles();
const subjectiveProfile = splitContextTaskProfiles.extract_subjective.profiles[0];
subjectiveProfile.blocks = [
  createBuiltinPromptBlock("extract_subjective", "relevantPovMemories", {
    name: "相关主观记忆",
    order: 0,
  }),
  createBuiltinPromptBlock("extract_subjective", "cognitionStateDigest", {
    name: "认知状态摘要",
    order: 1,
  }),
];

const splitContextPromptBuild = await buildTaskPrompt(
  {
    taskProfilesVersion: 3,
    taskProfiles: splitContextTaskProfiles,
  },
  "extract_subjective",
  {
    objectiveExtractionDraft: { operations: [{ ref: "evt1", type: "event" }] },
    objectiveRefMap: { evt1: "node-evt1" },
    ownerContext: { ownerType: "character", ownerName: "艾琳" },
    batchStoryTime: { label: "第二天清晨", confidence: "high" },
    relevantPovMemories: ["旧 POV 记忆"],
    cognitionStateDigest: "艾琳知道 evt1",
  },
);
const splitContextPayload = buildTaskLlmPayload(
  splitContextPromptBuild,
  "fallback-user",
);
const splitContextSourceKeys = splitContextPayload.promptMessages
  .map((message) => message.sourceKey)
  .filter(Boolean);
for (const sourceKey of [
  "ownerContext",
  "relevantPovMemories",
  "cognitionStateDigest",
]) {
  assert.ok(
    splitContextSourceKeys.includes(sourceKey),
    `subjective prompt should include ${sourceKey}`,
  );
}
for (const removedKey of [
  "objectiveExtractionDraft",
  "objectiveRefMap",
  "batchStoryTime",
]) {
  assert.ok(
    !splitContextSourceKeys.includes(removedKey),
    `subjective prompt should NOT include ${removedKey}`,
  );
}
assert.match(
  String(
    splitContextPayload.promptMessages.find(
      (message) => message.sourceKey === "ownerContext",
    )?.content || "",
  ),
  /"ownerName": "艾琳"/,
);
assert.match(
  String(
    splitContextPayload.promptMessages.find(
      (message) => message.sourceKey === "relevantPovMemories",
    )?.content || "",
  ),
  /旧 POV 记忆/,
);

// Verify objective template: no pov_memory or cognitionUpdates in format/rules blocks
const objPromptBuild = await buildTaskPrompt(settings, "extract_objective", {
  taskName: "extract_objective",
  charDescription: "角色描述",
  recentMessages: "A: 你好\nB: 世界",
  graphStats: "node_count=3",
  schema: "event(title, summary)",
  currentRange: "1 ~ 2",
});
const objPayload = buildTaskLlmPayload(objPromptBuild, "fallback-user");
const objFormatBlock = objPayload.promptMessages.find((m) => m.blockName === "输出格式");
const objRulesBlock = objPayload.promptMessages.find((m) => m.blockName === "行为规则");
assert.equal(
  (objPayload.promptMessages || [])
    .filter((m) => m.role === "user")
    .map((m) => m.blockName)
    .join(","),
  "输出格式,行为规则",
  "extract_objective should have format + rules user blocks",
);
assert.match(String(objFormatBlock?.content || ""), /batchStoryTime/);
assert.match(String(objFormatBlock?.content || ""), /regionUpdates/);
assert.match(String(objFormatBlock?.content || ""), /\"type\": \"event\"/);
assert.match(String(objFormatBlock?.content || ""), /\"region\": \"钟楼\"/);
assert.match(String(objFormatBlock?.content || ""), /\"adjacent\": \[\"旧城区\", \"内廷\"\]/);
assert.doesNotMatch(String(objFormatBlock?.content || ""), /\\\"region\\\"/);
assert.doesNotMatch(String(objFormatBlock?.content || ""), /\\n\s*\{\\\"region/);
assert.doesNotMatch(String(objFormatBlock?.content || ""), /pov_memory/);
assert.doesNotMatch(String(objFormatBlock?.content || ""), /cognitionUpdates/);
assert.match(String(objRulesBlock?.content || ""), /HARD GATE/);
assert.match(String(objRulesBlock?.content || ""), /常见错误/);
assert.doesNotMatch(String(objRulesBlock?.content || ""), /POV 记忆字段/);

// Verify subjective template: no objective types in format block
const subPromptBuild = await buildTaskPrompt(settings, "extract_subjective", {
  taskName: "extract_subjective",
  charDescription: "角色描述",
  recentMessages: "A: 你好\nB: 世界",
  graphStats: "node_count=3",
  schema: "event(title, summary)",
  currentRange: "1 ~ 2",
});
const subPayload = buildTaskLlmPayload(subPromptBuild, "fallback-user");
const subFormatBlock = subPayload.promptMessages.find((m) => m.blockName === "输出格式");
const subRulesBlock = subPayload.promptMessages.find((m) => m.blockName === "行为规则");
assert.match(String(subFormatBlock?.content || ""), /pov_memory/);
assert.match(String(subFormatBlock?.content || ""), /cognitionUpdates/);
assert.doesNotMatch(String(subFormatBlock?.content || ""), /\"type\": \"event\"/);
assert.doesNotMatch(String(subFormatBlock?.content || ""), /\\\"type\\\"/);
assert.match(String(subRulesBlock?.content || ""), /POV HARD GATE/);
assert.match(String(subRulesBlock?.content || ""), /反锚定/);
assert.match(String(subRulesBlock?.content || ""), /常见错误/);

console.log("prompt-builder-defaults tests passed");
