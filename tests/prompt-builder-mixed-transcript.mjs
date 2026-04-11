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
const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
const { initializeHostAdapter } = await import("../host/adapter/index.js");

initializeHostAdapter({});

const settings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};
const extractProfile = settings.taskProfiles.extract.profiles[0];
extractProfile.regex = {
  ...(extractProfile.regex || {}),
  enabled: true,
  inheritStRegex: false,
  sources: {
    global: false,
    preset: false,
    character: false,
  },
  stages: {
    ...(extractProfile.regex?.stages || {}),
    input: true,
    "input.recentMessages": true,
    "input.finalPrompt": false,
  },
  localRules: [
    {
      id: "assistant-local-role-aware",
      script_name: "assistant-local-role-aware",
      enabled: true,
      find_regex: "/继续说明/g",
      replace_string: "助手已净化",
      source: {
        user_input: false,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
    },
    {
      id: "user-local-role-aware",
      script_name: "user-local-role-aware",
      enabled: true,
      find_regex: "/用户输入/g",
      replace_string: "用户已净化",
      source: {
        user_input: true,
        ai_output: false,
      },
      destination: {
        prompt: true,
        display: false,
      },
    },
  ],
};

const promptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "",
  userPersona: "",
  recentMessages: "这里会被 chatMessages 回填",
  chatMessages: [
    {
      seq: 41,
      role: "assistant",
      content: "继续说明",
      name: "艾琳",
      speaker: "艾琳",
    },
    {
      seq: 42,
      role: "user",
      content: "用户输入",
      name: "玩家",
      speaker: "玩家",
    },
  ],
  graphStats: "node_count=1",
  schema: "event(title, summary)",
  currentRange: "41 ~ 42",
});
const payload = buildTaskLlmPayload(promptBuild, "fallback-user");
const recentBlock = payload.promptMessages.find(
  (message) => message.sourceKey === "recentMessages",
);
assert.match(String(recentBlock?.content || ""), /#41 \[assistant\|艾琳\]: 助手已净化/);
assert.match(String(recentBlock?.content || ""), /#42 \[user\|玩家\]: 用户已净化/);
assert.doesNotMatch(
  String(recentBlock?.content || ""),
  /#41 \[assistant\|艾琳\]: 用户已净化/,
);
assert.doesNotMatch(
  String(recentBlock?.content || ""),
  /#42 \[user\|玩家\]: 助手已净化/,
);

console.log("prompt-builder-mixed-transcript tests passed");
