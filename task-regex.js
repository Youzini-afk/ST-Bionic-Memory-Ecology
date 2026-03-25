// ST-BME: 任务正则兼容层（Phase 1）
// 目标：在任务预设中复用 Tavern 正则来源（global/preset/character），
// 同时叠加任务本地规则，并按任务阶段执行。

import { extension_settings, getContext } from "../../../extensions.js";
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
  return HTML_TAG_PATTERN.test(normalized) || HTML_ATTR_PATTERN.test(normalized);
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
      display: destination ? Boolean(destination.display) : Boolean(raw.markdownOnly),
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

function collectViaApi(sourceType) {
  const getter = globalThis?.getTavernRegexes;
  if (typeof getter !== "function") return [];
  try {
    if (sourceType === "global") return getter({ type: "global" }) || [];
    if (sourceType === "preset") return getter({ type: "preset", name: "in_use" }) || [];
    if (sourceType === "character") {
      const checkEnabled = globalThis?.isCharacterTavernRegexesEnabled;
      if (typeof checkEnabled === "function" && !checkEnabled()) return [];
      return getter({ type: "character", name: "current" }) || [];
    }
  } catch {
    return [];
  }
  return [];
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
    const viaApi = collectViaApi("global");
    if (viaApi.length > 0) {
      pushRules(viaApi, "global");
    } else {
      pushRules(
        readArrayPath(extSettings, [["regex"], ["regex", "regex_scripts"]]),
        "global",
      );
    }
  }

  if (enabledSources.preset) {
    const viaApi = collectViaApi("preset");
    if (viaApi.length > 0) {
      pushRules(viaApi, "preset");
    } else {
      pushRules(
        readArrayPath(oaiSettings, [["regex_scripts"], ["extensions", "regex_scripts"]]),
        "preset",
      );
    }
  }

  if (enabledSources.character) {
    const viaApi = collectViaApi("character");
    if (viaApi.length > 0) {
      pushRules(viaApi, "character");
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
  // 将细粒度的 stage 名映射到 input / output 两大类
  if (PROMPT_STAGES.has(stage)) {
    return stagesConfig.input !== false && rule.destinationFlags.prompt !== false;
  }
  if (OUTPUT_STAGES.has(stage)) {
    return stagesConfig.output !== false;
  }
  // 未知 stage 回退到 input
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
