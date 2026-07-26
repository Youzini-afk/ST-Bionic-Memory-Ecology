import assert from "node:assert/strict";
import {
  cloneTaskProfile,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createDefaultTaskProfile,
  createDefaultTaskProfiles,
  createLocalRegexRule,
  exportTaskProfile,
  getActiveTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeMeta,
  getTaskTypeOptions,
  getTaskTypes,
  importTaskProfile,
  restoreDefaultTaskProfile,
  upsertTaskProfile,
} from "../prompting/prompt-profiles.js";

const taskProfiles = createDefaultTaskProfiles();
const baseProfile = taskProfiles.extract_objective.profiles[0];
assert.equal(baseProfile.generation.llm_preset, "");

const clonedProfile = cloneTaskProfile(baseProfile, {
  taskType: "extract_objective",
  name: "激进提取",
});
clonedProfile.generation.llm_preset = "Recall-API";
clonedProfile.blocks = [
  ...clonedProfile.blocks,
  createBuiltinPromptBlock("extract_objective", "userMessage", {
    name: "用户消息块",
    injectionMode: "prepend",
    order: 1,
  }),
  createCustomPromptBlock("extract_objective", {
    name: "补充说明",
    content: "请关注 {{userMessage}}",
    role: "user",
    order: 2,
  }),
];
clonedProfile.regex.localRules = [
  createLocalRegexRule("extract_objective", {
    script_name: "裁边",
    find_regex: "/^foo/g",
    replace_string: "bar",
  }),
];

const updatedProfiles = upsertTaskProfile(taskProfiles, "extract_objective", clonedProfile, {
  setActive: true,
});

const activeProfile = getActiveTaskProfile(
  { taskProfiles: updatedProfiles },
  "extract_objective",
);
assert.equal(activeProfile.name, "激进提取");
assert.equal(activeProfile.blocks.length, 19);
const builtinBlock = activeProfile.blocks.find(
  (block) => block.type === "builtin" && block.sourceKey === "userMessage",
);
const customBlock = activeProfile.blocks.find(
  (block) => block.type === "custom" && block.name === "补充说明",
);
assert.ok(builtinBlock);
assert.equal(builtinBlock.injectionMode, "prepend");
assert.equal(builtinBlock.role, "system");
assert.ok(customBlock);
assert.equal(customBlock.role, "user");
assert.equal(activeProfile.regex.localRules.length, 1);
assert.equal(activeProfile.regex.localRules[0].script_name, "裁边");
assert.equal(activeProfile.generation.llm_preset, "Recall-API");

const exported = exportTaskProfile(
  updatedProfiles,
  "extract_objective",
  clonedProfile.id,
);
assert.equal(exported.format, "st-bme-task-profile");
assert.equal(exported.taskType, "extract_objective");
assert.equal(exported.profile.name, "激进提取");
assert.equal(exported.profile.generation.llm_preset, "Recall-API");

const imported = importTaskProfile(updatedProfiles, JSON.stringify(exported));
assert.equal(imported.taskType, "extract_objective");
assert.notEqual(imported.profile.id, clonedProfile.id);
assert.equal(imported.profile.generation.llm_preset, "Recall-API");
assert.ok(
  imported.profile.blocks.some(
    (block) => block.type === "builtin" && block.sourceKey === "userMessage",
  ),
);

const restoredProfiles = restoreDefaultTaskProfile(imported.taskProfiles, "extract_objective");
const restoredActive = getActiveTaskProfile(
  { taskProfiles: restoredProfiles },
  "extract_objective",
);
assert.equal(restoredActive.id, "default");
assert.equal(getLegacyPromptFieldForTask("extract"), "");
assert.equal(getTaskTypeMeta("extract").label, "extract");
assert.equal(createDefaultTaskProfile("extract"), null);
assert.equal(getActiveTaskProfile({ taskProfiles }, "extract"), null);
assert.throws(
  () => importTaskProfile(taskProfiles, JSON.stringify({
    format: "st-bme-task-profile",
    taskType: "extract",
    profile: { id: "legacy-extract", taskType: "extract", blocks: [] },
  })),
  /Unsupported task type: extract/,
);
assert.equal(
  getTaskTypeOptions().some((option) => option.id === "extract"),
  false,
);
assert.equal(getTaskTypes().includes("extract"), false);

assert.ok(getTaskTypes().includes("extract_objective"));
assert.ok(getTaskTypes().includes("extract_subjective"));
assert.equal(
  getTaskTypeOptions().some((option) => option.id === "extract_objective"),
  true,
);
assert.equal(
  getTaskTypeOptions().some((option) => option.id === "extract_subjective"),
  true,
);
assert.deepEqual(
  {
    objective: getTaskTypeMeta("extract_objective"),
    subjective: getTaskTypeMeta("extract_subjective"),
  },
  {
    objective: {
      id: "extract_objective",
      label: "客观提取",
      description: "从当前对话批次中抽取客观层结构化记忆。",
      hidden: false,
    },
    subjective: {
      id: "extract_subjective",
      label: "主观提取",
      description: "从客观提取草稿与视角上下文中抽取主观记忆。",
      hidden: false,
    },
  },
);
assert.ok(taskProfiles.extract_objective?.profiles?.length > 0);
assert.ok(taskProfiles.extract_subjective?.profiles?.length > 0);
assert.equal(
  taskProfiles.extract_objective.profiles[0].metadata.legacyPromptField,
  "extractObjectivePrompt",
);
assert.equal(
  taskProfiles.extract_subjective.profiles[0].metadata.legacyPromptField,
  "extractSubjectivePrompt",
);
assert.ok(
  taskProfiles.extract_objective.profiles[0].blocks.find((block) => block.id === "default-role")?.content?.includes("客观事实提取师"),
  "extract_objective role block should identify as objective-only extractor",
);
assert.ok(
  taskProfiles.extract_subjective.profiles[0].blocks.find((block) => block.id === "default-rules")?.content?.includes("POV HARD GATE"),
  "extract_subjective rules block should contain POV HARD GATE",
);
assert.deepEqual(
  getBuiltinBlockDefinitions("extract_subjective")
    .map((definition) => definition.sourceKey)
    .filter((sourceKey) =>
      [
        "ownerContext",
        "relevantPovMemories",
        "cognitionStateDigest",
      ].includes(sourceKey),
    ),
  [
    "ownerContext",
    "relevantPovMemories",
    "cognitionStateDigest",
  ],
);

console.log("task-profile-storage tests passed");
