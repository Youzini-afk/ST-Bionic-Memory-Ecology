// ST-BME: 任务正则兼容层（Phase 1）
// 目标：在任务预设中复用 Tavern 正则来源（global/preset/character），
// 同时叠加任务本地规则，并按任务阶段执行。

import { extension_settings, getContext } from "../../../extensions.js";
import { debugDebug } from "./debug-logging.js";
import { getHostAdapter } from "./host-adapter/index.js";
import {
  getActiveTaskProfile,
  isTaskRegexStageEnabled,
  normalizeTaskRegexStages,
} from "./prompt-profiles.js";

const HTML_TAG_PATTERN = /<\/?[a-z][\w:-]*\b/i;
const HTML_ATTR_PATTERN = /\b(?:style|class|id|href|src|data-)\s*=/i;
const TAVERN_REGEX_PLACEMENT = Object.freeze({
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
});
const TAVERN_REGEX_PLACEMENT_LABELS = Object.freeze({
  [TAVERN_REGEX_PLACEMENT.USER_INPUT]: "用户输入",
  [TAVERN_REGEX_PLACEMENT.AI_OUTPUT]: "AI 输出",
  [TAVERN_REGEX_PLACEMENT.SLASH_COMMAND]: "斜杠命令",
  [TAVERN_REGEX_PLACEMENT.WORLD_INFO]: "世界书",
  [TAVERN_REGEX_PLACEMENT.REASONING]: "推理/思维",
});

const PROMPT_STAGES = new Set([
  "finalPrompt",
  "input.userMessage",
  "input.recentMessages",
  "input.candidateText",
  "input.finalPrompt",
]);

const OUTPUT_STAGES = new Set([
  "rawResponse",
  "beforeParse",
  "output.rawResponse",
  "output.beforeParse",
]);

function isBeautificationReplace(text = "") {
  const normalized = String(text || "");
  return (
    HTML_TAG_PATTERN.test(normalized) || HTML_ATTR_PATTERN.test(normalized)
  );
}

function parseRegexFromString(regexStr = "") {
  const input = String(regexStr || "").trim();
  if (!input) return null;

  const slashFormat = input.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
  if (slashFormat) {
    try {
      return new RegExp(slashFormat[1], slashFormat[2]);
    } catch {
      return null;
    }
  }

  try {
    return new RegExp(input, "g");
  } catch {
    return null;
  }
}

function normalizeTrimStrings(rawTrim) {
  if (Array.isArray(rawTrim)) {
    return rawTrim.map((item) => String(item || "")).filter(Boolean);
  }
  if (typeof rawTrim === "string") {
    return rawTrim
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeRulePlacement(rawPlacement) {
  const placement = Array.isArray(rawPlacement) ? rawPlacement : [];
  return placement
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function derivePlacementLabelsFromSourceFlags(sourceFlags = {}) {
  const labels = [];
  if (sourceFlags.user) {
    labels.push(TAVERN_REGEX_PLACEMENT_LABELS[TAVERN_REGEX_PLACEMENT.USER_INPUT]);
  }
  if (sourceFlags.assistant) {
    labels.push(TAVERN_REGEX_PLACEMENT_LABELS[TAVERN_REGEX_PLACEMENT.AI_OUTPUT]);
  }
  if (sourceFlags.system && !sourceFlags.assistant) {
    labels.push("系统/世界书");
  }
  return labels;
}

function isTavernRuleShape(raw = {}) {
  return (
    Array.isArray(raw?.placement) ||
    Object.prototype.hasOwnProperty.call(raw || {}, "promptOnly") ||
    Object.prototype.hasOwnProperty.call(raw || {}, "markdownOnly") ||
    Object.prototype.hasOwnProperty.call(raw || {}, "scriptName") ||
    Object.prototype.hasOwnProperty.call(raw || {}, "findRegex") ||
    Object.prototype.hasOwnProperty.call(raw || {}, "replaceString")
  );
}

function buildRuleSourceFlags(source, placement, isTavernRule) {
  if (source && typeof source === "object") {
    return {
      user: Boolean(source.user_input),
      assistant: Boolean(source.ai_output),
      system: Boolean(source.ai_output),
    };
  }

  if (isTavernRule && placement.length > 0) {
    return {
      user: placement.includes(TAVERN_REGEX_PLACEMENT.USER_INPUT),
      assistant: placement.includes(TAVERN_REGEX_PLACEMENT.AI_OUTPUT),
      system: placement.some((item) =>
        [
          TAVERN_REGEX_PLACEMENT.WORLD_INFO,
          TAVERN_REGEX_PLACEMENT.REASONING,
        ].includes(item),
      ),
    };
  }

  return {
    user: true,
    assistant: true,
    system: true,
  };
}

function normalizeRule(raw = {}, fallbackSource = "local", index = 0) {
  const destination =
    raw?.destination && typeof raw.destination === "object"
      ? raw.destination
      : null;
  const source =
    raw?.source && typeof raw.source === "object" ? raw.source : null;
  const placement = normalizeRulePlacement(raw?.placement);
  const isTavernRule = isTavernRuleShape(raw);
  const replaceString = String(
    raw.replace_string ?? raw.replaceString ?? raw.replace ?? "",
  );
  const beautificationReplace = isBeautificationReplace(replaceString);
  const sourceFlags = buildRuleSourceFlags(source, placement, isTavernRule);

  return {
    id: String(raw.id || `${fallbackSource}-${index + 1}`),
    scriptName: String(raw.script_name || raw.scriptName || ""),
    enabled: raw.enabled !== false && raw.disabled !== true,
    findRegex: String(raw.find_regex || raw.findRegex || raw.find || "").trim(),
    replaceString,
    trimStrings: normalizeTrimStrings(raw.trim_strings ?? raw.trimStrings),
    sourceFlags,
    destinationFlags: {
      prompt: destination
        ? isTavernRule && (raw.markdownOnly === true || beautificationReplace)
          ? true
          : Boolean(destination.prompt)
        : isTavernRule && raw.markdownOnly === true
          ? true
          : raw.markdownOnly !== true,
      display: destination
        ? Boolean(destination.display)
        : Boolean(raw.markdownOnly),
    },
    beautificationReplace,
    promptOnly: Boolean(raw.promptOnly),
    markdownOnly: Boolean(raw.markdownOnly),
    placement,
    minDepth: Number.isFinite(Number(raw.min_depth ?? raw.minDepth))
      ? Number(raw.min_depth ?? raw.minDepth)
      : null,
    maxDepth: Number.isFinite(Number(raw.max_depth ?? raw.maxDepth))
      ? Number(raw.max_depth ?? raw.maxDepth)
      : null,
    isTavernRule,
    sourceType: fallbackSource,
    raw,
  };
}

function readArrayPath(root, paths = []) {
  for (const path of paths) {
    let current = root;
    let valid = true;
    for (const segment of path) {
      if (!current || typeof current !== "object") {
        valid = false;
        break;
      }
      current = current[segment];
    }
    if (valid && Array.isArray(current)) {
      return current;
    }
  }
  return [];
}

function getLegacyRegexApi(name) {
  const fn = globalThis?.[name];
  return typeof fn === "function" ? fn : null;
}

function getRegexHost() {
  const legacyGetTavernRegexes = getLegacyRegexApi("getTavernRegexes");
  const legacyIsCharacterTavernRegexesEnabled = getLegacyRegexApi(
    "isCharacterTavernRegexesEnabled",
  );

  try {
    const regexHost = getHostAdapter?.()?.regex || null;
    if (typeof regexHost?.getTavernRegexes === "function") {
      const capabilitySupport = regexHost.readCapabilitySupport?.() || {};
      const supplementedCapabilities = [];
      const missingCapabilities = [];
      const resolvedCharacterToggle =
        typeof regexHost.isCharacterTavernRegexesEnabled === "function"
          ? regexHost.isCharacterTavernRegexesEnabled
          : legacyIsCharacterTavernRegexesEnabled;

      if (typeof regexHost.isCharacterTavernRegexesEnabled !== "function") {
        if (resolvedCharacterToggle) {
          supplementedCapabilities.push("isCharacterTavernRegexesEnabled");
        } else {
          missingCapabilities.push("isCharacterTavernRegexesEnabled");
        }
      }

      return {
        getTavernRegexes: regexHost.getTavernRegexes,
        isCharacterTavernRegexesEnabled: resolvedCharacterToggle,
        sourceLabel: capabilitySupport.sourceLabel || "host-adapter.regex",
        fallback:
          Boolean(capabilitySupport.fallback) ||
          supplementedCapabilities.length > 0,
        capabilityStatus: Object.freeze({
          mode: capabilitySupport.mode || "unknown",
          supplementedCapabilities: Object.freeze(supplementedCapabilities),
          missingCapabilities: Object.freeze(missingCapabilities),
        }),
      };
    }
  } catch (error) {
    debugDebug(
      "[ST-BME] task-regex 读取 regex bridge 失败，回退到 legacy 宿主接口",
      error,
    );
  }

  const missingCapabilities = [];
  if (typeof legacyGetTavernRegexes !== "function") {
    missingCapabilities.push("getTavernRegexes");
  }
  if (typeof legacyIsCharacterTavernRegexesEnabled !== "function") {
    missingCapabilities.push("isCharacterTavernRegexesEnabled");
  }

  return {
    getTavernRegexes: legacyGetTavernRegexes,
    isCharacterTavernRegexesEnabled: legacyIsCharacterTavernRegexesEnabled,
    sourceLabel: "legacy.globalThis",
    fallback: true,
    capabilityStatus: Object.freeze({
      mode: "legacy",
      supplementedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze(missingCapabilities),
    }),
  };
}

function getPresetManagerFromContext(context = {}) {
  if (typeof context?.getPresetManager !== "function") {
    return null;
  }

  try {
    const manager = context.getPresetManager();
    return manager && typeof manager === "object" ? manager : null;
  } catch {
    return null;
  }
}

function getCurrentPresetInfo(context = {}) {
  const presetManager = getPresetManagerFromContext(context);
  const apiId = String(presetManager?.apiId || "").trim();
  const presetName =
    typeof presetManager?.getSelectedPresetName === "function"
      ? String(presetManager.getSelectedPresetName() || "").trim()
      : "";

  return {
    presetManager,
    apiId,
    presetName,
  };
}

function isPresetRegexAllowed(extSettings = {}, apiId = "", presetName = "") {
  if (!apiId || !presetName) {
    return false;
  }
  return Boolean(extSettings?.preset_allowed_regex?.[apiId]?.includes?.(presetName));
}

function getCurrentCharacterInfo(context = {}) {
  const rawCharacterId = context?.characterId;
  const characterId = Number(rawCharacterId);
  if (!Number.isFinite(characterId) || characterId < 0) {
    return {
      characterId: null,
      character: null,
      avatar: "",
    };
  }

  const characters = Array.isArray(context?.characters) ? context.characters : [];
  const character = characters[characterId] || null;

  return {
    characterId,
    character,
    avatar: String(character?.avatar || ""),
  };
}

function isCharacterRegexAllowed(extSettings = {}, avatar = "") {
  if (!avatar) {
    return false;
  }
  return Boolean(extSettings?.character_allowed_regex?.includes?.(avatar));
}

function readGlobalFallbackRules(extSettings = {}) {
  return readArrayPath(extSettings, [
    ["regex"],
    ["regex_scripts"],
    ["regex", "regex_scripts"],
  ]);
}

function readPresetFallbackRules(context = {}, oaiSettings = {}) {
  const { presetManager } = getCurrentPresetInfo(context);
  if (typeof presetManager?.readPresetExtensionField === "function") {
    try {
      const scripts = presetManager.readPresetExtensionField({
        path: "regex_scripts",
      });
      if (Array.isArray(scripts)) {
        return scripts;
      }
    } catch {
      // ignore and continue to legacy paths
    }
  }

  return readArrayPath(oaiSettings, [
    ["regex_scripts"],
    ["extensions", "regex_scripts"],
  ]);
}

function readCharacterFallbackRules(context = {}) {
  const { character } = getCurrentCharacterInfo(context);
  if (!character) {
    return [];
  }

  return readArrayPath(character, [
    ["data", "extensions", "regex_scripts"],
    ["extensions", "regex_scripts"],
  ]);
}

function getPlacementLabels(placement = []) {
  return (Array.isArray(placement) ? placement : []).map(
    (item) => TAVERN_REGEX_PLACEMENT_LABELS[item] || `#${item}`,
  );
}

function summarizeRule(rule, reason = "") {
  const normalized = rule && typeof rule === "object" ? rule : {};
  const promptReplaceAsEmpty =
    Boolean(normalized.markdownOnly) || Boolean(normalized.beautificationReplace);
  const sourceFlags =
    normalized.sourceFlags && typeof normalized.sourceFlags === "object"
      ? normalized.sourceFlags
      : {};
  const placementLabels = getPlacementLabels(normalized.placement);
  const effectivePlacementLabels =
    placementLabels.length > 0
      ? placementLabels
      : derivePlacementLabelsFromSourceFlags(sourceFlags);
  return {
    id: String(normalized.id || ""),
    name: String(normalized.scriptName || normalized.id || ""),
    findRegex: String(normalized.findRegex || ""),
    replaceString: String(normalized.replaceString || ""),
    effectivePromptReplaceString: promptReplaceAsEmpty
      ? ""
      : String(normalized.replaceString || ""),
    promptReplaceAsEmpty,
    sourceType: String(normalized.sourceType || ""),
    promptOnly: Boolean(normalized.promptOnly),
    markdownOnly: Boolean(normalized.markdownOnly),
    sourceFlags: {
      user: sourceFlags.user !== false,
      assistant: sourceFlags.assistant !== false,
      system: sourceFlags.system !== false,
    },
    placement: Array.isArray(normalized.placement) ? [...normalized.placement] : [],
    placementLabels: effectivePlacementLabels,
    minDepth:
      normalized.minDepth == null ? null : Number(normalized.minDepth),
    maxDepth:
      normalized.maxDepth == null ? null : Number(normalized.maxDepth),
    reason: String(reason || ""),
  };
}

function summarizeRuleForPromptPreview(rule, stageConfig = {}, reason = "") {
  const summary = summarizeRule(rule, reason);
  const promptStageApplies = shouldApplyRuleForStage(
    rule,
    "input.finalPrompt",
    stageConfig,
  );
  return {
    ...summary,
    promptStageApplies,
    promptStageMode: promptStageApplies
      ? summary.promptReplaceAsEmpty
        ? "clear"
        : "replace"
      : "skip",
  };
}

function collectViaApi(sourceType, regexHost = null) {
  const getter = regexHost?.getTavernRegexes;
  if (typeof getter !== "function") {
    return { supported: false, items: [] };
  }

  const success = (items) => ({
    supported: true,
    items: Array.isArray(items) ? items : [],
  });

  const unsupported = () => ({ supported: false, items: [] });

  try {
    if (sourceType === "global") {
      return success(getter({ type: "global" }));
    }
    if (sourceType === "preset") {
      return success(getter({ type: "preset", name: "in_use" }));
    }
    if (sourceType === "character") {
      const checkEnabled = regexHost?.isCharacterTavernRegexesEnabled;
      if (
        typeof checkEnabled !== "function" &&
        regexHost?.capabilityStatus?.mode === "partial"
      ) {
        return unsupported();
      }
      if (typeof checkEnabled === "function" && !checkEnabled()) {
        return success([]);
      }
      return success(getter({ type: "character", name: "current" }));
    }
  } catch {
    return unsupported();
  }
  return unsupported();
}

function collectTavernRulesDetailed(regexConfig = {}) {
  const shouldReuse = regexConfig.inheritStRegex !== false;
  const sourceConfig = regexConfig.sources || {};
  const enabledSources = {
    global: shouldReuse && sourceConfig.global !== false,
    preset: shouldReuse && sourceConfig.preset !== false,
    character: shouldReuse && sourceConfig.character !== false,
  };

  const context = getContext?.() || {};
  const extSettings = context?.extensionSettings || extension_settings || {};
  const oaiSettings =
    context?.chatCompletionSettings || globalThis?.oai_settings || {};
  const regexHost = getRegexHost();
  const collected = [];
  const seen = new Set();
  const sources = [];

  const appendSourceSnapshot = ({
    type,
    label,
    enabled,
    supported,
    resolvedVia,
    allowed = true,
    reason = "",
    rawItems = [],
  }) => {
    const effectiveItems =
      enabled && allowed ? (Array.isArray(rawItems) ? rawItems : []) : [];
    const activeRules = [];
    const ignoredRules = [];
    const ignoredPreviewRules = [];
    const previewRules = [];

    if (!enabled) {
      sources.push({
        type,
        label,
        enabled,
        supported,
        resolvedVia,
        allowed,
        reason:
          reason || (shouldReuse ? "当前任务已关闭该来源" : "当前任务未启用复用酒馆正则"),
        rawRuleCount: Array.isArray(rawItems) ? rawItems.length : 0,
        activeRuleCount: 0,
        previewRules: Array.isArray(rawItems)
          ? rawItems.map((item, index) => normalizeRule(item, type, index))
          : [],
        ignoredPreviewRules: [],
        rules: [],
        ignoredRules: [],
      });
      return;
    }

    if (!allowed && Array.isArray(rawItems)) {
      for (let index = 0; index < rawItems.length; index++) {
        const normalized = normalizeRule(rawItems[index], type, index);
        previewRules.push(normalized);
        ignoredPreviewRules.push({ ...normalized, reason: "not-allowed" });
        ignoredRules.push(
          summarizeRule(normalized, "not-allowed"),
        );
      }
    }

    for (let index = 0; index < effectiveItems.length; index++) {
      const normalized = normalizeRule(effectiveItems[index], type, index);
      previewRules.push(normalized);
      if (!normalized.enabled) {
        ignoredPreviewRules.push({ ...normalized, reason: "disabled" });
        ignoredRules.push(summarizeRule(normalized, "disabled"));
        continue;
      }
      if (!normalized.findRegex) {
        ignoredPreviewRules.push({ ...normalized, reason: "missing-find-regex" });
        ignoredRules.push(summarizeRule(normalized, "missing-find-regex"));
        continue;
      }
      const key = `${type}:${normalized.id}:${normalized.findRegex}`;
      if (seen.has(key)) {
        ignoredPreviewRules.push({ ...normalized, reason: "duplicate" });
        ignoredRules.push(summarizeRule(normalized, "duplicate"));
        continue;
      }
      seen.add(key);
      collected.push(normalized);
      activeRules.push(summarizeRule(normalized));
    }

    sources.push({
      type,
      label,
      enabled,
      supported,
      resolvedVia,
      allowed,
      reason,
      rawRuleCount: Array.isArray(rawItems) ? rawItems.length : 0,
      activeRuleCount: activeRules.length,
      previewRules,
      ignoredPreviewRules,
      rules: activeRules,
      ignoredRules,
    });
  };

  const globalViaApi = collectViaApi("global", regexHost);
  appendSourceSnapshot({
    type: "global",
    label: "全局",
    enabled: enabledSources.global,
    supported: true,
    resolvedVia: globalViaApi.supported ? "bridge" : "fallback",
    rawItems: globalViaApi.supported
      ? globalViaApi.items
      : readGlobalFallbackRules(extSettings),
  });

  const presetViaApi = collectViaApi("preset", regexHost);
  if (presetViaApi.supported) {
    appendSourceSnapshot({
      type: "preset",
      label: "当前预设",
      enabled: enabledSources.preset,
      supported: true,
      resolvedVia: "bridge",
      rawItems: presetViaApi.items,
    });
  } else {
    const { apiId, presetName } = getCurrentPresetInfo(context);
    const rawItems = readPresetFallbackRules(context, oaiSettings);
    const allowed = isPresetRegexAllowed(extSettings, apiId, presetName);
    appendSourceSnapshot({
      type: "preset",
      label: "当前预设",
      enabled: enabledSources.preset,
      supported: true,
      resolvedVia: "fallback",
      allowed,
      reason: allowed
        ? ""
        : apiId && presetName
          ? `酒馆当前未允许预设 "${presetName}" 的正则参与运行`
          : "未识别到酒馆当前生效的预设",
      rawItems,
    });
  }

  const characterViaApi = collectViaApi("character", regexHost);
  if (characterViaApi.supported) {
    appendSourceSnapshot({
      type: "character",
      label: "角色卡",
      enabled: enabledSources.character,
      supported: true,
      resolvedVia: "bridge",
      rawItems: characterViaApi.items,
    });
  } else {
    const { avatar } = getCurrentCharacterInfo(context);
    const rawItems = readCharacterFallbackRules(context);
    const allowed = isCharacterRegexAllowed(extSettings, avatar);
    appendSourceSnapshot({
      type: "character",
      label: "角色卡",
      enabled: enabledSources.character,
      supported: true,
      resolvedVia: "fallback",
      allowed,
      reason: allowed
        ? ""
        : avatar
          ? "酒馆当前未允许该角色卡的 scoped regex 参与运行"
          : "当前没有可用的角色卡上下文",
      rawItems,
    });
  }

  return {
    shouldReuse,
    host: {
      sourceLabel: regexHost.sourceLabel,
      fallback: Boolean(regexHost.fallback),
      capabilityStatus: regexHost.capabilityStatus || null,
    },
    sources,
    rules: collected,
  };
}

function collectTavernRules(regexConfig = {}) {
  return collectTavernRulesDetailed(regexConfig).rules;
}

function collectLocalRules(regexConfig = {}) {
  const localRules = Array.isArray(regexConfig.localRules)
    ? regexConfig.localRules
    : [];
  return localRules
    .map((rule, index) => normalizeRule(rule, "local", index))
    .filter((rule) => rule.enabled && rule.findRegex);
}

function shouldApplyRuleForTaskContext(rule, stage = "") {
  if (!rule?.isTavernRule) {
    return true;
  }

  const normalizedStage = String(stage || "").trim();
  const isPromptStage = PROMPT_STAGES.has(normalizedStage);
  const isFinalPromptStage =
    normalizedStage === "finalPrompt" || normalizedStage === "input.finalPrompt";
  const isOutputStage = OUTPUT_STAGES.has(normalizedStage);

  if (rule.markdownOnly) {
    return isPromptStage;
  }

  if (isFinalPromptStage) {
    return rule.promptOnly === true;
  }

  if (isOutputStage) {
    return rule.promptOnly !== true;
  }

  return rule.promptOnly !== true;
}

function shouldApplyRuleForStage(rule, stage = "", stagesConfig = {}) {
  const normalizedStage = String(stage || "").trim();
  if (rule.destinationFlags.prompt === false) {
    return false;
  }
  if (!shouldApplyRuleForTaskContext(rule, normalizedStage)) {
    return false;
  }

  if (!normalizedStage) {
    return isTaskRegexStageEnabled(stagesConfig, "input");
  }

  if (PROMPT_STAGES.has(normalizedStage) || OUTPUT_STAGES.has(normalizedStage)) {
    return isTaskRegexStageEnabled(stagesConfig, normalizedStage);
  }

  return isTaskRegexStageEnabled(stagesConfig, normalizedStage);
}

function shouldApplyRuleForRole(rule, role = "system") {
  if (role === "mixed") {
    return rule.sourceFlags.user !== false || rule.sourceFlags.assistant !== false;
  }
  if (role === "user") return rule.sourceFlags.user !== false;
  if (role === "assistant") return rule.sourceFlags.assistant !== false;
  return rule.sourceFlags.system !== false;
}

function applyOneRule(input, rule, stage = "") {
  const regex = parseRegexFromString(rule.findRegex);
  if (!regex) return { output: input, changed: false, error: "invalid_regex" };

  let replacement = rule.replaceString || "";
  if (
    PROMPT_STAGES.has(stage) &&
    (rule.markdownOnly || rule.beautificationReplace)
  ) {
    replacement = "";
  }

  let output = input.replace(regex, replacement);
  if (rule.trimStrings.length > 0) {
    for (const trimText of rule.trimStrings) {
      if (!trimText) continue;
      output = output.split(trimText).join("");
    }
  }

  return { output, changed: output !== input, error: "" };
}

function pushDebug(collector, entry) {
  if (collector && Array.isArray(collector.entries)) {
    collector.entries.push(entry);
  }
}

export function applyTaskRegex(
  settings = {},
  taskType,
  stage,
  text,
  debugCollector = null,
  role = "system",
) {
  const profile = getActiveTaskProfile(settings, taskType);
  const regexConfig = profile?.regex || {};
  const input = typeof text === "string" ? text : "";

  if (!regexConfig.enabled) {
    pushDebug(debugCollector, {
      taskType,
      stage,
      enabled: false,
      appliedRules: [],
      sourceCount: { tavern: 0, local: 0 },
    });
    return input;
  }

  // 阶段检查已移到 shouldApplyRuleForStage 中，无需单独 gate
  const stagesConfig = normalizeTaskRegexStages(regexConfig?.stages || {});

  const tavernRules = collectTavernRules(regexConfig);
  const localRules = collectLocalRules(regexConfig);
  const orderedRules = [...tavernRules, ...localRules];
  const appliedRules = [];
  let output = input;

  for (const rule of orderedRules) {
    if (!shouldApplyRuleForStage(rule, stage, stagesConfig)) continue;
    if (!shouldApplyRuleForRole(rule, role)) continue;

    const result = applyOneRule(output, rule, stage);
    if (result.error) {
      appliedRules.push({
        id: rule.id,
        source: rule.sourceType,
        error: result.error,
      });
      continue;
    }
    if (result.changed) {
      appliedRules.push({
        id: rule.id,
        source: rule.sourceType,
      });
      output = result.output;
    }
  }

  pushDebug(debugCollector, {
    taskType,
    stage,
    enabled: true,
    appliedRules,
    sourceCount: {
      tavern: tavernRules.length,
      local: localRules.length,
    },
  });

  return output;
}

export function inspectTaskRegexReuse(settings = {}, taskType = "") {
  const profile = getActiveTaskProfile(settings, taskType);
  const regexConfig = profile?.regex || {};
  const detailed = collectTavernRulesDetailed(regexConfig);
  const stageConfig = normalizeTaskRegexStages(regexConfig.stages || {});

  const mapPreviewRules = (rules = []) =>
    (Array.isArray(rules) ? rules : []).map((rule) =>
      summarizeRuleForPromptPreview(rule, stageConfig, rule?.reason || ""),
    );

  return {
    taskType: String(taskType || ""),
    profileId: String(profile?.id || ""),
    profileName: String(profile?.name || ""),
    regexEnabled: regexConfig.enabled !== false,
    inheritStRegex: regexConfig.inheritStRegex !== false,
    stageConfig: normalizeTaskRegexStages(regexConfig.stages || {}),
    sourceConfig: {
      global: regexConfig.sources?.global !== false,
      preset: regexConfig.sources?.preset !== false,
      character: regexConfig.sources?.character !== false,
    },
    localRuleCount: Array.isArray(regexConfig.localRules)
      ? regexConfig.localRules.length
      : 0,
    sources: detailed.sources.map((source) => ({
      ...source,
      previewRules: mapPreviewRules(source.previewRules),
      rules: mapPreviewRules(source.previewRules),
      ignoredRules: mapPreviewRules(source.ignoredPreviewRules),
    })),
    host: detailed.host,
    activeRuleCount: detailed.rules.length,
    activeRules: detailed.rules.map((rule) =>
      summarizeRuleForPromptPreview(rule, stageConfig),
    ),
  };
}
