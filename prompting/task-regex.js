import {
  getScriptsByType,
  regex_placement,
  runRegexScript,
  SCRIPT_TYPES,
} from "../../../regex/engine.js";
import {
  getActiveTaskProfile,
  isTaskRegexStageEnabled,
  normalizeGlobalTaskRegex,
} from "./prompt-profiles.js";

const HOST_SOURCES = Object.freeze([
  ["global", SCRIPT_TYPES.GLOBAL],
  ["preset", SCRIPT_TYPES.PRESET],
  ["character", SCRIPT_TYPES.SCOPED],
]);
const PLACEMENTS = Object.freeze({
  user_input: regex_placement.USER_INPUT,
  ai_output: regex_placement.AI_OUTPUT,
  world_info: regex_placement.WORLD_INFO,
  reasoning: regex_placement.REASONING,
});

function configFor(settings, taskType) {
  const profile = getActiveTaskProfile(settings, taskType);
  return normalizeGlobalTaskRegex(
    settings.globalTaskRegex ?? profile?.regex ?? {},
    settings.globalTaskRegex ? "global" : taskType,
  );
}

function pushDebug(collector, entry) {
  if (Array.isArray(collector?.entries)) collector.entries.push(entry);
}

function trimStrings(value) {
  return Array.isArray(value)
    ? value
    : String(value || "").split("\n").map((entry) => entry.trim()).filter(Boolean);
}

function localRuleApplies(rule, stage, role) {
  if (rule.enabled === false || rule.destination?.prompt === false) return false;
  if (role === "user") return rule.source?.user_input !== false;
  if (role === "mixed") {
    return rule.source?.user_input !== false || rule.source?.ai_output !== false;
  }
  return rule.source?.ai_output !== false;
}

function runRule(rule, input) {
  return runRegexScript({
    disabled: rule.enabled === false,
    findRegex: rule.find_regex,
    replaceString: rule.replace_string,
    trimStrings: trimStrings(rule.trim_strings),
    substituteRegex: 0,
  }, input);
}

function hostScriptApplies(script, placement, options) {
  if (script?.disabled || !script?.findRegex || !script?.placement?.includes(placement)) return false;
  if (options.isEdit && !script.runOnEdit) return false;
  const depth = Number(options.depth);
  if (Number.isFinite(depth)) {
    if (Number.isFinite(Number(script.minDepth)) && Number(script.minDepth) >= -1 && depth < Number(script.minDepth)) return false;
    if (Number.isFinite(Number(script.maxDepth)) && Number(script.maxDepth) >= 0 && depth > Number(script.maxDepth)) return false;
  }
  return options.isPrompt ? script.promptOnly === true : options.isMarkdown
    ? script.markdownOnly === true
    : script.promptOnly !== true && script.markdownOnly !== true;
}

export function applyHostRegexReuse(
  settings = {},
  taskType,
  text,
  { sourceType = "", debugCollector = null, formatterOptions = null } = {},
) {
  const input = typeof text === "string" ? text : "";
  const regex = configFor(settings, taskType);
  const placement = PLACEMENTS[String(sourceType || "").trim().toLowerCase()];
  const options = {
    isPrompt: formatterOptions?.isPrompt !== false,
    isMarkdown: formatterOptions?.isMarkdown === true,
    isEdit: formatterOptions?.isEdit === true,
    depth: formatterOptions?.depth,
    characterOverride: formatterOptions?.characterOverride,
  };
  if (!regex.enabled || !regex.inheritStRegex || placement === undefined) {
    return {
      text: input,
      changed: false,
      executionMode: "host-current",
      formatterAvailable: true,
      formatterSource: "SillyTavern regex engine",
      fallbackReason: "",
      skippedDisplayOnlyRuleCount: 0,
    };
  }

  let output = input;
  const appliedRules = [];
  let skippedDisplayOnlyRuleCount = 0;
  for (const [name, type] of HOST_SOURCES) {
    if (regex.sources[name] === false) continue;
    for (const script of getScriptsByType(type, { allowedOnly: true })) {
      if (!hostScriptApplies(script, placement, options)) {
        if (script?.markdownOnly && !script?.promptOnly) skippedDisplayOnlyRuleCount += 1;
        continue;
      }
      try {
        const next = runRegexScript(script, output, {
          characterOverride: options.characterOverride,
        });
        if (next !== output) appliedRules.push({ id: script.id || script.scriptName || "", source: name });
        output = next;
      } catch (error) {
        appliedRules.push({ id: script?.id || script?.scriptName || "", source: name, error: String(error?.message || error) });
      }
    }
  }
  pushDebug(debugCollector, {
    kind: "host-reuse",
    taskType,
    stage: `host:${sourceType}`,
    enabled: true,
    executionMode: "host-current",
    appliedRules,
  });
  return {
    text: output,
    changed: output !== input,
    executionMode: "host-current",
    formatterAvailable: true,
    formatterSource: "SillyTavern regex engine",
    fallbackReason: "",
    skippedDisplayOnlyRuleCount,
  };
}

export function applyTaskRegex(
  settings = {},
  taskType,
  stage,
  text,
  debugCollector = null,
  role = "system",
) {
  const input = typeof text === "string" ? text : "";
  const regex = configFor(settings, taskType);
  if (!regex.enabled || !isTaskRegexStageEnabled(regex.stages, stage)) return input;

  let output = input;
  const appliedRules = [];
  for (const rule of regex.localRules) {
    if (!localRuleApplies(rule, stage, role)) continue;
    try {
      const next = runRule(rule, output);
      if (next !== output) appliedRules.push({ id: rule.id, source: "local" });
      output = next;
    } catch (error) {
      appliedRules.push({ id: rule.id, source: "local", error: String(error?.message || error) });
    }
  }
  pushDebug(debugCollector, {
    taskType,
    stage,
    enabled: true,
    appliedRules,
    sourceCount: { tavern: 0, local: regex.localRules.length },
  });
  return output;
}
