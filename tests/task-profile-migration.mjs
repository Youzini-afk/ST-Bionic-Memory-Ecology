import assert from "node:assert/strict";
import {
  createDefaultTaskProfiles,
  ensureTaskProfiles,
  getActiveTaskProfile,
  migrateLegacyTaskProfiles,
} from "../prompt-profiles.js";

const legacySettings = {
  extractPrompt: "旧提取提示",
  recallPrompt: "旧召回提示",
  compressPrompt: "",
  synopsisPrompt: "",
  reflectionPrompt: "",
  consolidationPrompt: "",
};

const migrated = migrateLegacyTaskProfiles(legacySettings);
assert.equal(migrated.taskProfilesVersion, 3);
assert.ok(migrated.taskProfiles);
assert.ok(migrated.taskProfiles.extract);
assert.ok(migrated.taskProfiles.recall);

const extractProfile = getActiveTaskProfile(
  {
    ...legacySettings,
    taskProfiles: migrated.taskProfiles,
  },
  "extract",
);
assert.equal(extractProfile.taskType, "extract");
assert.equal(extractProfile.id, "default");
assert.ok(Array.isArray(extractProfile.blocks));
assert.equal(extractProfile.blocks.length, 12);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.name),
  [
    "抬头",
    "角色定义",
    "角色描述",
    "用户设定",
    "世界书前块",
    "世界书后块",
    "最近消息",
    "图统计",
    "Schema",
    "当前范围",
    "输出格式",
    "行为规则",
  ],
);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.type),
  [
    "custom",
    "custom",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "custom",
    "custom",
  ],
);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.role),
  [
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "user",
    "user",
  ],
);
assert.equal(
  extractProfile.metadata.legacyPromptField,
  "extractPrompt",
);
assert.equal(
  extractProfile.metadata.legacyPromptSnapshot,
  "旧提取提示",
);

const defaults = createDefaultTaskProfiles();
assert.ok(defaults.extract.profiles.length > 0);
assert.ok(defaults.recall.profiles.length > 0);
assert.ok(defaults.compress.profiles.length > 0);
assert.ok(defaults.synopsis.profiles.length > 0);
assert.ok(defaults.reflection.profiles.length > 0);
assert.deepEqual(
  defaults.recall.profiles[0].blocks.map((block) => block.sourceKey || block.id),
  [
    "default-heading",
    "default-role",
    "charDescription",
    "userPersona",
    "worldInfoBefore",
    "worldInfoAfter",
    "recentMessages",
    "userMessage",
    "candidateNodes",
    "graphStats",
    "default-format",
    "default-rules",
  ],
);
assert.deepEqual(
  defaults.synopsis.profiles[0].blocks.map((block) => block.sourceKey || block.id),
  [
    "default-heading",
    "default-role",
    "charDescription",
    "userPersona",
    "worldInfoBefore",
    "worldInfoAfter",
    "eventSummary",
    "characterSummary",
    "threadSummary",
    "graphStats",
    "default-format",
    "default-rules",
  ],
);

const upgradedLegacyDefault = getActiveTaskProfile(
  {
    taskProfilesVersion: 1,
    taskProfiles: {
      extract: {
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            taskType: "extract",
            builtin: true,
            blocks: [
              {
                id: "default-role",
                name: "角色定义",
                type: "custom",
                role: "system",
                content: "保留我自己的角色定义",
                order: 0,
              },
              {
                id: "default-char-desc",
                name: "角色描述",
                type: "builtin",
                role: "system",
                sourceKey: "charDescription",
                order: 1,
              },
              {
                id: "default-user-persona",
                name: "用户设定",
                type: "builtin",
                role: "system",
                sourceKey: "userPersona",
                order: 2,
              },
              {
                id: "default-wi-before",
                name: "世界书前块",
                type: "builtin",
                role: "system",
                sourceKey: "worldInfoBefore",
                order: 3,
              },
              {
                id: "default-wi-after",
                name: "世界书后块",
                type: "builtin",
                role: "system",
                sourceKey: "worldInfoAfter",
                order: 4,
              },
              {
                id: "default-format",
                name: "输出格式",
                type: "custom",
                role: "system",
                content: "保留我自己的输出格式",
                order: 5,
              },
              {
                id: "default-rules",
                name: "行为规则",
                type: "custom",
                role: "system",
                content: "保留我自己的行为规则",
                order: 6,
              },
            ],
          },
        ],
      },
    },
  },
  "extract",
);
assert.equal(upgradedLegacyDefault.blocks.length, 12);
assert.equal(upgradedLegacyDefault.blocks[0].name, "抬头");
assert.match(upgradedLegacyDefault.blocks[0].content, /虚拟的世界/);
assert.equal(upgradedLegacyDefault.blocks[0].role, "system");
assert.equal(upgradedLegacyDefault.blocks[0].injectionMode, "relative");
assert.equal(upgradedLegacyDefault.blocks[1].content, "保留我自己的角色定义");
assert.equal(upgradedLegacyDefault.blocks[10].content, "保留我自己的输出格式");
assert.equal(upgradedLegacyDefault.blocks[11].content, "保留我自己的行为规则");
assert.equal(upgradedLegacyDefault.blocks[10].role, "user");
assert.equal(upgradedLegacyDefault.blocks[11].role, "user");

const currentDefaults = createDefaultTaskProfiles();
const currentDefaultExtract = currentDefaults.extract.profiles[0];

const staleBuiltinDefaults = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          updatedAt: "2000-01-01T00:00:00.000Z",
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "这是过期的默认角色定义" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
            defaultTemplateVersion:
              Number(currentDefaultExtract.metadata?.defaultTemplateVersion || 3),
            defaultTemplateUpdatedAt: "2000-01-01T00:00:00.000Z",
          },
        },
        {
          id: "extract-custom-1",
          taskType: "extract",
          builtin: false,
          name: "我的自定义预设",
          promptMode: "block-based",
          enabled: true,
          updatedAt: "2026-04-05T00:00:00.000Z",
          blocks: [
            {
              id: "custom-block-1",
              name: "自定义块",
              type: "custom",
              enabled: true,
              role: "system",
              sourceKey: "",
              sourceField: "",
              content: "保留我的自定义内容",
              injectionMode: "append",
              order: 0,
            },
          ],
          generation: { ...(currentDefaultExtract.generation || {}) },
          regex: {
            ...(currentDefaultExtract.regex || {}),
            localRules: [],
          },
          metadata: {
            note: "custom-profile-should-stay",
          },
        },
      ],
    },
  },
});
const refreshedDefaultExtract = staleBuiltinDefaults.extract.profiles.find(
  (profile) => profile.id === "default",
);
const preservedCustomExtract = staleBuiltinDefaults.extract.profiles.find(
  (profile) => profile.id === "extract-custom-1",
);

assert.ok(refreshedDefaultExtract);
assert.equal(
  refreshedDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
  currentDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
);
assert.equal(
  refreshedDefaultExtract.metadata.defaultTemplateUpdatedAt,
  currentDefaultExtract.metadata.defaultTemplateUpdatedAt,
);
assert.ok(preservedCustomExtract);
assert.equal(
  preservedCustomExtract.blocks[0].content,
  "保留我的自定义内容",
);

const sameStampBuiltinDefault = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "同版本下保留我的默认预设修改" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
          },
        },
      ],
    },
  },
});
const sameStampDefaultExtract = sameStampBuiltinDefault.extract.profiles.find(
  (profile) => profile.id === "default",
);
assert.equal(
  sameStampDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
  "同版本下保留我的默认预设修改",
);
assert.deepEqual(
  upgradedLegacyDefault.blocks
    .slice(6, 10)
    .map((block) => block.sourceKey),
  ["recentMessages", "graphStats", "schema", "currentRange"],
);
assert.ok(
  upgradedLegacyDefault.blocks
    .slice(0, 10)
    .every((block) => block.role === "system"),
);

console.log("task-profile-migration tests passed");
