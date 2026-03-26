// ST-BME: 任务正则兼容层（Phase 1）
// 目标：在任务预设中复用 Tavern 正则来源（global/preset/character），
// 同时叠加任务本地规则，并按任务阶段执行。

import { extension_settings, getContext } from "../../../extensions.js";
import { getHostAdapter } from "./host-adapter/index.js";
import { getActiveTaskProfile } from "./prompt-profiles.js";

const HTML_TAG_PATTERN =
  /<\/?(?:div|span|p|br|hr|img|details|summary|section|article|aside|header|footer|nav|ul|ol|li|table|tr|td|th|h[1-6]|a|em|strong|blockquote|pre|code|svg|path)\b/i;
const HTML_ATTR_PATTERN = /\b(?:style|class|id|href|src|data-)\s*=/i;

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

function normalizeRule(raw = {}, fallbackSource = "local", index = 0) {
  const destination =
    raw?.destination && typeof raw.destination === "object"
      ? raw.destination
      : null;
  const source =
    raw?.source && typeof raw.source === "object" ? raw.source : null;

  return {
    id: String(raw.id || `${fallbackSource}-${index + 1}`),
    scriptName: String(raw.script_name || raw.scriptName || ""),
    enabled: raw.enabled !== false && raw.disabled !== true,
    findRegex: String(raw.find_regex || raw.findRegex || raw.find || "").trim(),
    replaceString: String(
      raw.replace_string ?? raw.replaceString ?? raw.replace ?? "",
    ),
    trimStrings: normalizeTrimStrings(raw.trim_strings ?? raw.trimStrings),
    sourceFlags: {
      user: source ? Boolean(source.user_input) : true,
      assistant: source ? Boolean(source.ai_output) : true,
      system: source ? Boolean(source.ai_output) : true,
    },
    destinationFlags: {
      prompt: destination
        ? Boolean(destination.prompt)
        : raw.promptOnly !== true,
      display: destination
        ? Boolean(destination.display)
        : Boolean(raw.markdownOnly),
    },
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
    console.debug(
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

function collectTavernRules(regexConfig = {}) {
  const shouldReuse = regexConfig.inheritStRegex !== false;
  if (!shouldReuse) return [];

  const sourceConfig = regexConfig.sources || {};
  const enabledSources = {
    global: sourceConfig.global !== false,
    preset: sourceConfig.preset !== false,
    character: sourceConfig.character !== false,
  };

  const context = getContext?.() || {};
  const extSettings = context?.extensionSettings || extension_settings || {};
  const oaiSettings =
    context?.chatCompletionSettings || globalThis?.oai_settings || {};
  const regexHost = getRegexHost();
  const collected = [];
  const seen = new Set();

  const pushRules = (items, sourceType) => {
    for (let index = 0; index < items.length; index++) {
      const normalized = normalizeRule(items[index], sourceType, index);
      if (!normalized.enabled || !normalized.findRegex) continue;
      const key = `${sourceType}:${normalized.id}:${normalized.findRegex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(normalized);
    }
  };

  if (enabledSources.global) {
    const viaApi = collectViaApi("global", regexHost);
    if (viaApi.supported) {
      pushRules(viaApi.items, "global");
    } else {
      pushRules(
        readArrayPath(extSettings, [["regex"], ["regex", "regex_scripts"]]),
        "global",
      );
    }
  }

  if (enabledSources.preset) {
    const viaApi = collectViaApi("preset", regexHost);
    if (viaApi.supported) {
      pushRules(viaApi.items, "preset");
    } else {
      pushRules(
        readArrayPath(oaiSettings, [
          ["regex_scripts"],
          ["extensions", "regex_scripts"],
        ]),
        "preset",
      );
    }
  }

  if (enabledSources.character) {
    const viaApi = collectViaApi("character", regexHost);
    if (viaApi.supported) {
      pushRules(viaApi.items, "character");
    } else {
      const charId = context?.characterId;
      const characters = context?.characters;
      if (charId !== undefined && characters) {
        const character = characters[Number(charId)];
        pushRules(
          readArrayPath(character, [
            ["extensions", "regex_scripts"],
            ["data", "extensions", "regex_scripts"],
          ]),
          "character",
        );
      }
    }
  }

  return collected;
}

function collectLocalRules(regexConfig = {}) {
  const localRules = Array.isArray(regexConfig.localRules)
    ? regexConfig.localRules
    : [];
  return localRules
    .map((rule, index) => normalizeRule(rule, "local", index))
    .filter((rule) => rule.enabled && rule.findRegex);
}

function shouldApplyRuleForStage(rule, stage = "", stagesConfig = {}) {
  const normalizedStage = String(stage || "").trim();
  if (
    normalizedStage &&
    Object.prototype.hasOwnProperty.call(stagesConfig, normalizedStage)
  ) {
    return (
      stagesConfig[normalizedStage] !== false &&
      rule.destinationFlags.prompt !== false
    );
  }
  if (PROMPT_STAGES.has(normalizedStage)) {
    return (
      stagesConfig.input !== false && rule.destinationFlags.prompt !== false
    );
  }
  if (OUTPUT_STAGES.has(normalizedStage)) {
    return (
      stagesConfig.output !== false && rule.destinationFlags.prompt !== false
    );
  }
  return stagesConfig.input !== false && rule.destinationFlags.prompt !== false;
}

function shouldApplyRuleForRole(rule, role = "system") {
  if (role === "user") return rule.sourceFlags.user !== false;
  if (role === "assistant") return rule.sourceFlags.assistant !== false;
  return rule.sourceFlags.system !== false;
}

function applyOneRule(input, rule, stage = "") {
  const regex = parseRegexFromString(rule.findRegex);
  if (!regex) return { output: input, changed: false, error: "invalid_regex" };

  let replacement = rule.replaceString || "";
  if (PROMPT_STAGES.has(stage) && isBeautificationReplace(replacement)) {
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
  const stagesConfig = regexConfig?.stages || {};

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
