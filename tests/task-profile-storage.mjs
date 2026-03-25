import assert from "node:assert/strict";
import {
  cloneTaskProfile,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createDefaultTaskProfiles,
  createLocalRegexRule,
  exportTaskProfile,
  getActiveTaskProfile,
  getLegacyPromptFieldForTask,
  importTaskProfile,
  restoreDefaultTaskProfile,
  upsertTaskProfile,
} from "../prompt-profiles.js";

const taskProfiles = createDefaultTaskProfiles();
const baseProfile = taskProfiles.extract.profiles[0];

const clonedProfile = cloneTaskProfile(baseProfile, {
  taskType: "extract",
  name: "激进提取",
});
clonedProfile.blocks = [
  ...clonedProfile.blocks,
  createBuiltinPromptBlock("extract", "userMessage", {
    name: "用户消息块",
    injectionMode: "prepend",
    order: 1,
  }),
  createCustomPromptBlock("extract", {
    name: "补充说明",
    content: "请关注 {{userMessage}}",
    role: "user",
    order: 2,
  }),
];
clonedProfile.regex.localRules = [
  createLocalRegexRule("extract", {
    script_name: "裁边",
    find_regex: "/^foo/g",
    replace_string: "bar",
  }),
];

const updatedProfiles = upsertTaskProfile(taskProfiles, "extract", clonedProfile, {
  setActive: true,
});

const activeProfile = getActiveTaskProfile(
  { taskProfiles: updatedProfiles },
  "extract",
);
assert.equal(activeProfile.name, "激进提取");
assert.equal(activeProfile.blocks.length, 3);
assert.equal(activeProfile.blocks[1].type, "builtin");
assert.equal(activeProfile.blocks[1].sourceKey, "userMessage");
assert.equal(activeProfile.blocks[1].injectionMode, "prepend");
assert.equal(activeProfile.blocks[2].type, "custom");
assert.equal(activeProfile.blocks[2].role, "user");
assert.equal(activeProfile.regex.localRules.length, 1);
assert.equal(activeProfile.regex.localRules[0].script_name, "裁边");

const exported = exportTaskProfile(
  updatedProfiles,
  "extract",
  clonedProfile.id,
);
assert.equal(exported.format, "st-bme-task-profile");
assert.equal(exported.taskType, "extract");
assert.equal(exported.profile.name, "激进提取");

const imported = importTaskProfile(updatedProfiles, JSON.stringify(exported));
assert.equal(imported.taskType, "extract");
assert.notEqual(imported.profile.id, clonedProfile.id);
assert.equal(imported.profile.blocks[1].sourceKey, "userMessage");

const restoredProfiles = restoreDefaultTaskProfile(imported.taskProfiles, "extract");
const restoredActive = getActiveTaskProfile(
  { taskProfiles: restoredProfiles },
  "extract",
);
assert.equal(restoredActive.id, "default");
assert.equal(getLegacyPromptFieldForTask("extract"), "extractPrompt");

console.log("task-profile-storage tests passed");
