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
assert.equal(extractProfile.blocks[0].type, "legacyPrompt");

const defaults = createDefaultTaskProfiles();
assert.ok(defaults.extract.profiles.length > 0);
assert.ok(defaults.recall.profiles.length > 0);
assert.ok(defaults.compress.profiles.length > 0);
assert.ok(defaults.synopsis.profiles.length > 0);
assert.ok(defaults.reflection.profiles.length > 0);

console.log("task-profile-migration tests passed");
