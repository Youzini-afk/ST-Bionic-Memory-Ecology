import assert from "node:assert/strict";
import {
  createDefaultTaskProfiles,
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
assert.equal(migrated.taskProfilesVersion, 1);
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
assert.equal(extractProfile.blocks.length, 7);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.name),
  [
    "角色定义",
    "角色描述",
    "用户设定",
    "世界书前块",
    "世界书后块",
    "输出格式",
    "行为规则",
  ],
);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.type),
  ["custom", "builtin", "builtin", "builtin", "builtin", "custom", "custom"],
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

console.log("task-profile-migration tests passed");
