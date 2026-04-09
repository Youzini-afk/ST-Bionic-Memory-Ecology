import assert from "node:assert/strict";
import {
  createDefaultTaskProfiles,
  ensureTaskProfiles,
  getActiveTaskProfile,
  migrateLegacyProfileRegexToGlobal,
  migrateLegacyTaskProfiles,
  migratePerTaskRegexToGlobal,
  normalizeTaskProfile,
} from "../prompting/prompt-profiles.js";

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
    "sceneOwnerCandidates",
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
    "recentMessages",
    "candidateText",
    "currentRange",
    "graphStats",
    "default-format",
    "default-rules",
  ],
);
assert.ok(defaults.summary_rollup.profiles.length > 0);

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
assert.equal(
  refreshedDefaultExtract.metadata.defaultTemplateFingerprint,
  currentDefaultExtract.metadata.defaultTemplateFingerprint,
);
assert.match(
  refreshedDefaultExtract.blocks.find((block) => block.id === "default-format")
    ?.content || "",
  /cognitionUpdates/,
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

const sameTimestampButChangedTemplateDefaults = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "老模板内容但时间戳没变" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
            defaultTemplateFingerprint: "fnv1a-deadbeef",
          },
        },
      ],
    },
  },
});
const fingerprintRefreshedDefault =
  sameTimestampButChangedTemplateDefaults.extract.profiles.find(
    (profile) => profile.id === "default",
  );
assert.equal(
  fingerprintRefreshedDefault.blocks.find(
    (block) => block.id === "default-role",
  )?.content,
  currentDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
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

const legacyRegexSettings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};
legacyRegexSettings.taskProfiles.extract.activeProfileId = "default";
legacyRegexSettings.taskProfiles.extract.profiles.push(
  normalizeTaskProfile("extract", {
    id: "extract-legacy-regex",
    taskType: "extract",
    name: "旧正则副本",
    builtin: false,
    regex: {
      enabled: true,
      inheritStRegex: true,
      localRules: [
        {
          id: "legacy-rule-1",
          script_name: "隐藏规则",
          enabled: true,
          find_regex: "/SECRET/g",
          replace_string: "MASK",
        },
      ],
    },
  }),
);
const migratedLegacyRegex = migratePerTaskRegexToGlobal(legacyRegexSettings);
assert.equal(migratedLegacyRegex.changed, true);
assert.equal(migratedLegacyRegex.settings.globalTaskRegex.enabled, false);
assert.deepEqual(
  migratedLegacyRegex.settings.globalTaskRegex.localRules.map((rule) => rule.script_name),
  ["隐藏规则"],
);
assert.deepEqual(
  migratedLegacyRegex.settings.taskProfiles.extract.profiles.find(
    (profile) => profile.id === "extract-legacy-regex",
  )?.regex?.localRules || [],
  [],
);

const existingGlobalRegexSettings = {
  taskProfilesVersion: 3,
  globalTaskRegex: {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      "input.userMessage": true,
      "input.recentMessages": true,
    },
    localRules: [
      {
        id: "existing-global-rule",
        script_name: "现有通用规则",
        enabled: true,
        find_regex: "/GLOBAL/g",
        replace_string: "KEEP",
      },
    ],
  },
  taskProfiles: createDefaultTaskProfiles(),
};
existingGlobalRegexSettings.taskProfiles.extract.profiles.push(
  normalizeTaskProfile("extract", {
    id: "extract-legacy-extra",
    taskType: "extract",
    name: "旧规则补充",
    builtin: false,
    regex: {
      localRules: [
        {
          id: "legacy-extra-rule",
          script_name: "额外旧规则",
          enabled: true,
          find_regex: "/EXTRA/g",
          replace_string: "ADD",
        },
      ],
    },
  }),
);
const migratedWithExistingGlobal = migratePerTaskRegexToGlobal(
  existingGlobalRegexSettings,
);
assert.equal(migratedWithExistingGlobal.settings.globalTaskRegex.enabled, true);
assert.deepEqual(
  migratedWithExistingGlobal.settings.globalTaskRegex.localRules.map(
    (rule) => rule.script_name,
  ),
  ["现有通用规则", "额外旧规则"],
);

const importedLegacyProfileMigration = migrateLegacyProfileRegexToGlobal(
  {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      "input.userMessage": true,
      "input.recentMessages": true,
    },
    localRules: [],
  },
  {
    taskType: "extract",
    regex: {
      enabled: false,
      inheritStRegex: false,
      sources: {
        global: false,
        preset: false,
        character: false,
      },
      stages: {
        "input.userMessage": false,
      },
      localRules: [
        {
          id: "legacy-import-rule",
          script_name: "旧导入规则",
          enabled: true,
          find_regex: "/A/g",
          replace_string: "B",
        },
      ],
    },
  },
  {
    applyLegacyConfig: true,
  },
);
assert.equal(importedLegacyProfileMigration.appliedLegacyConfig, true);
assert.equal(importedLegacyProfileMigration.globalTaskRegex.enabled, false);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.inheritStRegex,
  false,
);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.sources.global,
  false,
);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.stages["input.userMessage"],
  false,
);
assert.deepEqual(
  importedLegacyProfileMigration.globalTaskRegex.localRules.map(
    (rule) => rule.script_name,
  ),
  ["旧导入规则"],
);
assert.deepEqual(
  importedLegacyProfileMigration.profile?.regex || {},
  {},
);

console.log("task-profile-migration tests passed");
