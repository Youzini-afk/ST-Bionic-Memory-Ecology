import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const extensionsShimSource = [
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(extensionsShimSource)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { buildTaskLlmPayload, buildTaskPrompt } = await import("../prompt-builder.js");
const { createDefaultTaskProfiles } = await import("../prompt-profiles.js");

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
  graphStats: "candidate_count=2",
});
const recallPayload = buildTaskLlmPayload(recallPromptBuild, "fallback-user");
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
    "graphStats",
  ],
);

console.log("prompt-builder-defaults tests passed");
