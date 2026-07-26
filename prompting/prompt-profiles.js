import { DEFAULT_TASK_PROFILE_TEMPLATES } from "./default-task-profile-templates.js";
import {
  PLANNER_ASSISTANT_SEED,
  PLANNER_FORMAT,
  PLANNER_HEADING,
  PLANNER_IDENTITY_ACK,
  PLANNER_INFO_ACK,
  PLANNER_ROLE,
  PLANNER_RULES,
} from "../ena-planner/ena-planner-presets.js";

const TASK_TYPES = Object.freeze([
  "extract_objective",
  "extract_subjective",
  "recall",
  "consolidation",
  "compress",
  "synopsis",
  "reflection",
  "summary_rollup",
  "planner",
]);
const TASK_TYPE_SET = new Set(TASK_TYPES);
const ROLES = new Set(["system", "user", "assistant"]);
const BLOCK_TYPES = new Set(["custom", "builtin"]);
const STAGE_KEYS = Object.freeze([
  "input.userMessage",
  "input.recentMessages",
  "input.candidateText",
  "input.finalPrompt",
  "output.rawResponse",
  "output.beforeParse",
  "input",
  "output",
]);
const DEFAULT_STAGES = Object.freeze({
  "input.userMessage": true,
  "input.recentMessages": true,
  "input.candidateText": true,
  "input.finalPrompt": false,
  "output.rawResponse": false,
  "output.beforeParse": false,
  input: true,
  output: false,
});
const DEFAULT_INPUT = Object.freeze({
  rawChatContextFloors: 0,
  rawChatSourceMode: "ignore_bme_hide",
});

const DEFAULT_GLOBAL_RULES = Object.freeze([
  {
    id: "default-contamination-thinking-blocks",
    script_name: "默认清理：thinking/analysis/reasoning",
    find_regex: "/<(think|thinking|analysis|reasoning)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi",
  },
  {
    id: "default-contamination-choice-blocks",
    script_name: "默认清理：choice",
    find_regex: "/(?:<choice\\b[^>]*>[\\s\\S]*?<\\/choice>|<choice\\b[^>]*\\/?>)/gi",
  },
  {
    id: "default-contamination-updatevariable-tags",
    script_name: "默认清理：UpdateVariable",
    find_regex: "/(?:<updatevariable\\b[^>]*>[\\s\\S]*?<\\/updatevariable>|<updatevariable\\b[^>]*\\/?>)/gi",
  },
  {
    id: "default-contamination-status-current-variable-tags",
    script_name: "默认清理：status_current_variable",
    find_regex: "/(?:<status_current_variable\\b[^>]*>[\\s\\S]*?<\\/status_current_variable>|<status_current_variable\\b[^>]*\\/?>)/gi",
  },
  {
    id: "default-contamination-status-placeholder-tags",
    script_name: "默认清理：StatusPlaceHolderImpl",
    find_regex: "/<StatusPlaceHolderImpl\\b[^>]*\\/?>/gi",
  },
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function string(value, label, { empty = true } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new TypeError(`${label} must be ${empty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function boolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function plannerProfile() {
  const custom = (id, name, role, content, order) => ({
    id,
    name,
    type: "custom",
    enabled: true,
    role,
    sourceKey: "",
    sourceField: "",
    content,
    injectionMode: "relative",
    order,
  });
  const builtin = (id, name, role, sourceKey, order) => ({
    id,
    name,
    type: "builtin",
    enabled: true,
    role,
    sourceKey,
    sourceField: "",
    content: "",
    injectionMode: "relative",
    order,
  });
  return {
    id: "default",
    name: "默认预设",
    taskType: "planner",
    version: 1,
    builtin: true,
    enabled: true,
    description: "为下一轮回复生成剧情规划与写作提示。",
    promptMode: "block-based",
    updatedAt: "2026-07-26T00:00:00.000Z",
    blocks: [
      custom("planner-default-heading", "抬头", "system", PLANNER_HEADING, 0),
      custom("planner-default-role", "角色定义", "system", PLANNER_ROLE, 1),
      custom("planner-default-identity-ack", "身份确认", "assistant", PLANNER_IDENTITY_ACK, 2),
      builtin("planner-default-character-card", "角色卡", "system", "plannerCharacterCard", 3),
      builtin("planner-default-worldbook", "世界书", "system", "plannerWorldbook", 4),
      builtin("planner-default-memory", "BME 记忆", "system", "plannerMemory", 5),
      builtin("planner-default-previous-plots", "历史 plot", "system", "plannerPreviousPlots", 6),
      builtin("planner-default-recent-chat", "最近聊天", "system", "plannerRecentChat", 7),
      builtin("planner-default-user-input", "玩家输入", "user", "plannerUserInput", 8),
      custom("planner-default-info-ack", "信息确认", "assistant", PLANNER_INFO_ACK, 9),
      custom("planner-default-format", "输出格式", "user", PLANNER_FORMAT, 10),
      custom("planner-default-rules", "行为规则", "user", PLANNER_RULES, 11),
      custom("planner-default-assistant-seed", "Assistant Seed", "assistant", PLANNER_ASSISTANT_SEED, 12),
    ],
    generation: {
      llm_preset: "",
      max_context_tokens: null,
      max_completion_tokens: null,
      reply_count: null,
      stream: true,
      temperature: 1,
      top_p: 1,
      top_k: 0,
      top_a: null,
      min_p: null,
      seed: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
      squash_system_messages: null,
      reasoning_effort: null,
      request_thoughts: null,
      enable_function_calling: null,
      enable_web_search: null,
      character_name_prefix: null,
      wrap_user_messages_in_quotes: null,
    },
    input: DEFAULT_INPUT,
    regex: createDefaultGlobalTaskRegex({ localRules: [] }),
  };
}

function defaultProfile(taskType) {
  const template = taskType === "planner"
    ? plannerProfile()
    : structuredClone(DEFAULT_TASK_PROFILE_TEMPLATES[taskType]);
  return normalizeProfile(taskType, template);
}

function normalizeBlock(block, taskType, index) {
  const source = object(block, `${taskType}.blocks[${index}]`);
  const type = string(source.type, `${taskType}.blocks[${index}].type`, { empty: false });
  if (!BLOCK_TYPES.has(type)) throw new TypeError(`${taskType}.blocks[${index}].type is unsupported`);
  const role = string(source.role, `${taskType}.blocks[${index}].role`, { empty: false });
  if (!ROLES.has(role)) throw new TypeError(`${taskType}.blocks[${index}].role is unsupported`);
  const injectionMode = source.injectionMode ?? "relative";
  if (injectionMode !== "relative") {
    throw new TypeError(`${taskType}.blocks[${index}].injectionMode must be relative`);
  }
  const order = source.order === undefined ? index : Number(source.order);
  if (!Number.isFinite(order)) throw new TypeError(`${taskType}.blocks[${index}].order must be finite`);
  const content = source.content ?? "";
  const sourceKey = source.sourceKey ?? "";
  string(content, `${taskType}.blocks[${index}].content`);
  string(sourceKey, `${taskType}.blocks[${index}].sourceKey`);
  if (type === "builtin" && !content && !sourceKey) {
    throw new TypeError(`${taskType}.blocks[${index}] needs content or sourceKey`);
  }
  return {
    id: string(source.id, `${taskType}.blocks[${index}].id`, { empty: false }),
    name: string(source.name ?? "", `${taskType}.blocks[${index}].name`),
    type,
    enabled: boolean(source.enabled, true, `${taskType}.blocks[${index}].enabled`),
    role,
    sourceKey,
    sourceField: string(source.sourceField ?? "", `${taskType}.blocks[${index}].sourceField`),
    content,
    injectionMode,
    order,
  };
}

function normalizeInput(input = DEFAULT_INPUT, label = "input") {
  const source = object(input, label);
  const floors = Number(source.rawChatContextFloors ?? DEFAULT_INPUT.rawChatContextFloors);
  if (!Number.isSafeInteger(floors) || floors < 0 || floors > 200) {
    throw new TypeError(`${label}.rawChatContextFloors must be an integer between 0 and 200`);
  }
  if ((source.rawChatSourceMode ?? DEFAULT_INPUT.rawChatSourceMode) !== "ignore_bme_hide") {
    throw new TypeError(`${label}.rawChatSourceMode is unsupported`);
  }
  return { rawChatContextFloors: floors, rawChatSourceMode: "ignore_bme_hide" };
}

function normalizeProfile(taskType, profile) {
  const source = object(profile, `${taskType} profile`);
  if (source.taskType !== taskType) throw new TypeError(`${taskType} profile.taskType must match its bucket`);
  const blocks = objectArray(source.blocks, `${taskType} profile.blocks`).map((block, index) =>
    normalizeBlock(block, taskType, index));
  if (!blocks.length) throw new TypeError(`${taskType} profile.blocks must not be empty`);
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    throw new TypeError(`${taskType} profile block ids must be unique`);
  }
  const generation = source.generation === undefined ? {} : structuredClone(object(source.generation, `${taskType} profile.generation`));
  const metadata = source.metadata === undefined ? {} : object(source.metadata, `${taskType} profile.metadata`);
  return {
    id: string(source.id, `${taskType} profile.id`, { empty: false }),
    name: string(source.name, `${taskType} profile.name`, { empty: false }),
    taskType,
    version: Number.isSafeInteger(source.version) && source.version > 0 ? source.version : 1,
    builtin: boolean(source.builtin, false, `${taskType} profile.builtin`),
    enabled: boolean(source.enabled, true, `${taskType} profile.enabled`),
    description: string(source.description ?? "", `${taskType} profile.description`),
    promptMode: "block-based",
    updatedAt: string(source.updatedAt ?? "", `${taskType} profile.updatedAt`),
    blocks,
    generation,
    input: normalizeInput(source.input ?? DEFAULT_INPUT, `${taskType} profile.input`),
    regex: normalizeGlobalTaskRegex(source.regex ?? {}, taskType),
    ...(source.worldInfo === false ? { worldInfo: false } : {}),
    metadata: metadata.disableWorldInfo === true ? { disableWorldInfo: true } : {},
  };
}

function objectArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function normalizeRule(rule, index, label) {
  const source = object(rule, `${label}.localRules[${index}]`);
  const minDepth = Number(source.min_depth ?? 0);
  const maxDepth = Number(source.max_depth ?? 9999);
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || minDepth > maxDepth) {
    throw new TypeError(`${label}.localRules[${index}] has an invalid depth range`);
  }
  return {
    id: string(source.id, `${label}.localRules[${index}].id`, { empty: false }),
    script_name: string(source.script_name ?? "", `${label}.localRules[${index}].script_name`),
    enabled: boolean(source.enabled, true, `${label}.localRules[${index}].enabled`),
    find_regex: string(source.find_regex, `${label}.localRules[${index}].find_regex`, { empty: false }),
    replace_string: string(source.replace_string ?? "", `${label}.localRules[${index}].replace_string`),
    trim_strings: Array.isArray(source.trim_strings)
      ? source.trim_strings.map((entry, trimIndex) => string(entry, `${label}.localRules[${index}].trim_strings[${trimIndex}]`))
      : string(source.trim_strings ?? "", `${label}.localRules[${index}].trim_strings`),
    source: {
      user_input: boolean(source.source?.user_input, true, `${label}.localRules[${index}].source.user_input`),
      ai_output: boolean(source.source?.ai_output, true, `${label}.localRules[${index}].source.ai_output`),
    },
    destination: {
      prompt: boolean(source.destination?.prompt, true, `${label}.localRules[${index}].destination.prompt`),
      display: boolean(source.destination?.display, false, `${label}.localRules[${index}].destination.display`),
    },
    min_depth: minDepth,
    max_depth: maxDepth,
  };
}

export function normalizeTaskRegexStages(stages = {}) {
  const source = object(stages, "regex.stages");
  const unknown = Object.keys(source).find((key) => !STAGE_KEYS.includes(key));
  if (unknown) throw new TypeError(`unsupported regex stage: ${unknown}`);
  return Object.fromEntries(STAGE_KEYS.map((key) => [key, boolean(source[key], DEFAULT_STAGES[key], `regex.stages.${key}`)]));
}

export function createDefaultGlobalTaskRegex({ localRules = DEFAULT_GLOBAL_RULES } = {}) {
  return normalizeGlobalTaskRegex({
    enabled: true,
    inheritStRegex: true,
    sources: { global: true, preset: true, character: true },
    stages: DEFAULT_STAGES,
    localRules: structuredClone(localRules),
  });
}

export function normalizeGlobalTaskRegex(config = {}, taskType = "global") {
  const source = object(config, `${taskType} regex`);
  const sources = source.sources === undefined ? {} : object(source.sources, `${taskType} regex.sources`);
  const unknownSource = Object.keys(sources).find((key) => !["global", "preset", "character"].includes(key));
  if (unknownSource) throw new TypeError(`unsupported regex source: ${unknownSource}`);
  const rules = source.localRules === undefined ? [] : objectArray(source.localRules, `${taskType} regex.localRules`)
    .map((rule, index) => normalizeRule(rule, index, `${taskType} regex`));
  const seen = new Set();
  return {
    enabled: boolean(source.enabled, true, `${taskType} regex.enabled`),
    inheritStRegex: boolean(source.inheritStRegex, true, `${taskType} regex.inheritStRegex`),
    sources: {
      global: boolean(sources.global, true, `${taskType} regex.sources.global`),
      preset: boolean(sources.preset, true, `${taskType} regex.sources.preset`),
      character: boolean(sources.character, true, `${taskType} regex.sources.character`),
    },
    stages: normalizeTaskRegexStages(source.stages ?? {}),
    localRules: rules.filter((rule) => {
      const signature = JSON.stringify({ ...rule, id: undefined, script_name: undefined });
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    }),
  };
}

export function isTaskRegexStageEnabled(stages = {}, stageKey = "") {
  if (!STAGE_KEYS.includes(stageKey)) return false;
  const normalized = normalizeTaskRegexStages(stages);
  return normalized[stageKey] && (stageKey.startsWith("input.") ? normalized.input : stageKey.startsWith("output.") ? normalized.output : true);
}

export function createDefaultTaskProfiles() {
  return Object.fromEntries(TASK_TYPES.map((taskType) => [taskType, {
    activeProfileId: "default",
    profiles: [defaultProfile(taskType)],
  }]));
}

export function ensureTaskProfiles(settings = {}) {
  const existing = settings.taskProfiles;
  if (existing === undefined || existing === null) return createDefaultTaskProfiles();
  const source = object(existing, "taskProfiles");
  const unknown = Object.keys(source).find((taskType) => !TASK_TYPE_SET.has(taskType));
  if (unknown) throw new TypeError(`unsupported task profile bucket: ${unknown}`);
  const defaults = createDefaultTaskProfiles();
  return Object.fromEntries(TASK_TYPES.map((taskType) => {
    if (source[taskType] === undefined) return [taskType, defaults[taskType]];
    const bucket = object(source[taskType], `taskProfiles.${taskType}`);
    const profiles = objectArray(bucket.profiles, `taskProfiles.${taskType}.profiles`)
      .map((profile) => normalizeProfile(taskType, profile));
    if (!profiles.length) throw new TypeError(`taskProfiles.${taskType}.profiles must not be empty`);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new TypeError(`taskProfiles.${taskType} profile ids must be unique`);
    }
    const activeProfileId = string(bucket.activeProfileId, `taskProfiles.${taskType}.activeProfileId`, { empty: false });
    if (!profiles.some((profile) => profile.id === activeProfileId)) {
      throw new TypeError(`taskProfiles.${taskType}.activeProfileId does not exist`);
    }
    return [taskType, { activeProfileId, profiles }];
  }));
}

export function getActiveTaskProfile(settings = {}, taskType) {
  if (!TASK_TYPE_SET.has(taskType)) return null;
  const bucket = settings.taskProfiles?.[taskType];
  if (!bucket) return defaultProfile(taskType);
  return bucket.profiles.find((profile) => profile.id === bucket.activeProfileId) ?? null;
}
