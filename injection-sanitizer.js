import { sanitizeMvuContent } from "./mvu-compat.js";
import { applyHostRegexReuse } from "./task-regex.js";

export const PROMPT_CONTENT_ORIGIN = Object.freeze({
  TEMPLATE_OWNED: "template-owned",
  HOST_INJECTED: "host-injected",
  WORLD_INFO_RENDERED: "world-info-rendered",
});

function normalizeSanitizerMode(mode = "injection-safe") {
  return String(mode || "").trim() === "final-injection-safe"
    ? "final-safe"
    : "aggressive";
}

function isSanitizationEligible(options = {}) {
  if (options?.sanitizationEligible === false) {
    return false;
  }
  return String(options?.contentOrigin || "") !== PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
}

function normalizeReasons(reasons = []) {
  return Array.isArray(reasons)
    ? reasons.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function pushUnique(target = [], value = "") {
  const normalized = String(value || "").trim();
  if (!normalized || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

export function createEmptyInjectionSanitizerDebug() {
  return {
    sanitizedFieldCount: 0,
    sanitizedFields: [],
    finalMessageStripCount: 0,
    worldInfoBlockedContentHits: 0,
    sanitizerAppliedFields: [],
    sanitizerHitKinds: [],
    hostReuseAppliedFields: [],
    hostReuseSkippedDisplayOnlyRules: 0,
    regexExecutionMode: "host-unavailable",
    hostFormatterAvailable: false,
    hostFormatterSource: "",
    fallbackReason: "",
  };
}

function recordSanitizerDebug(debugState, path, result = {}, stage = "") {
  if (!debugState || (!result.changed && !result.dropped)) {
    return;
  }

  const reasons = normalizeReasons(result.reasons);
  debugState.sanitizedFields.push({
    name: String(path || ""),
    stage: String(stage || ""),
    changed: Boolean(result.changed),
    dropped: Boolean(result.dropped),
    reasons,
    blockedHitCount: Number(result.blockedHitCount || 0),
  });
  debugState.sanitizedFieldCount = debugState.sanitizedFields.length;
  pushUnique(debugState.sanitizerAppliedFields, path);
  for (const reason of reasons) {
    pushUnique(debugState.sanitizerHitKinds, reason);
  }
}

function recordHostReuseDebug(debugState, path, result = {}) {
  if (!debugState || !result || typeof result !== "object") {
    return;
  }
  debugState.regexExecutionMode = String(
    result.executionMode || debugState.regexExecutionMode || "host-unavailable",
  );
  debugState.hostFormatterAvailable = Boolean(result.formatterAvailable);
  debugState.hostFormatterSource = String(result.formatterSource || "");
  debugState.fallbackReason = String(result.fallbackReason || "");
  debugState.hostReuseSkippedDisplayOnlyRules = Math.max(
    Number(debugState.hostReuseSkippedDisplayOnlyRules || 0),
    Number(result.skippedDisplayOnlyRuleCount || 0),
  );
  if (result.changed) {
    pushUnique(debugState.hostReuseAppliedFields, path);
  }
}

export function sanitizeInjectionText(
  settings = {},
  taskType,
  text,
  {
    mode = "injection-safe",
    blockedContents = [],
    contentOrigin = PROMPT_CONTENT_ORIGIN.HOST_INJECTED,
    sanitizationEligible = true,
    regexSourceType = "",
    role = "system",
    formatterOptions = null,
    debugState = null,
    regexCollector = null,
    applySanitizer = true,
    applyHostRegex = true,
    path = "",
    stage = "",
  } = {},
) {
  const originalText = typeof text === "string" ? text : "";
  const eligible = sanitizationEligible && isSanitizationEligible({
    sanitizationEligible,
    contentOrigin,
  });

  const sanitizerResult = eligible && applySanitizer
    ? sanitizeMvuContent(originalText, {
        mode: normalizeSanitizerMode(mode),
        blockedContents,
      })
    : {
        text: originalText,
        changed: false,
        dropped: false,
        reasons: [],
        blockedHitCount: 0,
        artifactRemovedCount: 0,
      };

  recordSanitizerDebug(debugState, path, sanitizerResult, stage);

  const afterSanitizer = String(sanitizerResult.text || "");
  const hostReuseResult = eligible && applyHostRegex && regexSourceType
    ? applyHostRegexReuse(settings, taskType, afterSanitizer, {
        sourceType: regexSourceType,
        role,
        debugCollector: regexCollector,
        formatterOptions,
      })
    : {
        text: afterSanitizer,
        changed: false,
        executionMode: "host-unavailable",
        formatterAvailable: false,
        formatterSource: "",
        fallbackReason: "",
        skippedDisplayOnlyRuleCount: 0,
      };

  recordHostReuseDebug(debugState, path, hostReuseResult);

  const finalText = String(hostReuseResult.text || "");
  return {
    text: finalText,
    changed: finalText !== originalText,
    dropped: Boolean(sanitizerResult.dropped),
    reasons: normalizeReasons(sanitizerResult.reasons),
    blockedHitCount: Number(sanitizerResult.blockedHitCount || 0),
    artifactRemovedCount: Number(sanitizerResult.artifactRemovedCount || 0),
    hostReuseChanged: Boolean(hostReuseResult.changed),
    executionMode: String(hostReuseResult.executionMode || "host-unavailable"),
    formatterAvailable: Boolean(hostReuseResult.formatterAvailable),
    formatterSource: String(hostReuseResult.formatterSource || ""),
    fallbackReason: String(hostReuseResult.fallbackReason || ""),
    skippedDisplayOnlyRuleCount: Number(
      hostReuseResult.skippedDisplayOnlyRuleCount || 0,
    ),
  };
}

function looksLikeMvuStateContainer(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => looksLikeMvuStateContainer(item, seen));
  }

  const keys = Object.keys(value).map((key) =>
    String(key || "").trim().toLowerCase(),
  );
  if (
    keys.some((key) =>
      ["stat_data", "display_data", "delta_data", "$internal"].includes(key),
    )
  ) {
    return true;
  }

  return Object.values(value).some((item) => looksLikeMvuStateContainer(item, seen));
}

function getMvuObjectKeyStripReason(key, value) {
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (
    ["stat_data", "display_data", "delta_data", "$internal"].includes(
      normalizedKey,
    )
  ) {
    return "mvu_state_key_removed";
  }
  if (
    ["variables", "message_variables", "chat_variables"].includes(normalizedKey) &&
    looksLikeMvuStateContainer(value)
  ) {
    return "mvu_variables_container_removed";
  }
  return "";
}

function joinStructuredPath(basePath = "", segment = "") {
  const normalizedSegment = String(segment || "");
  if (!normalizedSegment) {
    return basePath;
  }
  if (!basePath) {
    return normalizedSegment.startsWith("[")
      ? normalizedSegment.slice(1, -1)
      : normalizedSegment;
  }
  return normalizedSegment.startsWith("[")
    ? `${basePath}${normalizedSegment}`
    : `${basePath}.${normalizedSegment}`;
}

export function sanitizeInjectionStructuredValue(
  settings = {},
  taskType,
  value,
  {
    fieldName = "",
    path = fieldName,
    mode = "injection-safe",
    blockedContents = [],
    contentOrigin = PROMPT_CONTENT_ORIGIN.HOST_INJECTED,
    sanitizationEligible = true,
    regexSourceType = "",
    role = "system",
    formatterOptions = null,
    debugState = null,
    regexCollector = null,
    applySanitizer = true,
    applyHostRegex = true,
    stripMvuContainers = true,
    seen = new WeakSet(),
  } = {},
) {
  if (typeof value === "string") {
    const sanitized = sanitizeInjectionText(settings, taskType, value, {
      mode,
      blockedContents,
      contentOrigin,
      sanitizationEligible,
      regexSourceType,
      role,
      formatterOptions,
      debugState,
      regexCollector,
      applySanitizer,
      applyHostRegex,
      path,
      stage: mode,
    });
    return {
      value: sanitized.text,
      changed: Boolean(sanitized.changed || sanitized.dropped),
      omit:
        !String(sanitized.text || "").trim() &&
        String(value || "").trim().length > 0,
      details: sanitized,
    };
  }

  if (Array.isArray(value)) {
    const sanitizedArray = [];
    let changed = false;
    for (let index = 0; index < value.length; index += 1) {
      const childResult = sanitizeInjectionStructuredValue(
        settings,
        taskType,
        value[index],
        {
          fieldName,
          path: joinStructuredPath(path, `[${index}]`),
          mode,
          blockedContents,
          contentOrigin,
          sanitizationEligible,
          regexSourceType,
          role,
          formatterOptions,
          debugState,
          regexCollector,
          applySanitizer,
          applyHostRegex,
          stripMvuContainers,
          seen,
        },
      );
      if (childResult.omit) {
        changed = true;
        continue;
      }
      sanitizedArray.push(childResult.value);
      if (childResult.changed) {
        changed = true;
      }
    }
    return {
      value: sanitizedArray,
      changed: changed || sanitizedArray.length !== value.length,
      omit: value.length > 0 && sanitizedArray.length === 0,
      details: null,
    };
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return {
        value,
        changed: false,
        omit: false,
        details: null,
      };
    }
    seen.add(value);

    const originalLooksMvuContainer = looksLikeMvuStateContainer(value);
    const sanitizedObject = {};
    let changed = false;
    let keptEntries = 0;

    for (const [key, entryValue] of Object.entries(value)) {
      const stripReason = stripMvuContainers
        ? getMvuObjectKeyStripReason(key, entryValue)
        : "";
      if (stripReason) {
        changed = true;
        recordSanitizerDebug(
          debugState,
          joinStructuredPath(path, key),
          {
            changed: true,
            dropped: true,
            reasons: [stripReason],
            blockedHitCount: 0,
          },
          mode,
        );
        continue;
      }

      const childResult = sanitizeInjectionStructuredValue(
        settings,
        taskType,
        entryValue,
        {
          fieldName,
          path: joinStructuredPath(path, key),
          mode,
          blockedContents,
          contentOrigin,
          sanitizationEligible,
          regexSourceType,
          role,
          formatterOptions,
          debugState,
          regexCollector,
          applySanitizer,
          applyHostRegex,
          stripMvuContainers,
          seen,
        },
      );
      if (childResult.omit) {
        changed = true;
        continue;
      }
      sanitizedObject[key] = childResult.value;
      keptEntries += 1;
      if (childResult.changed) {
        changed = true;
      }
    }

    return {
      value: sanitizedObject,
      changed,
      omit: originalLooksMvuContainer && keptEntries === 0,
      details: null,
    };
  }

  return {
    value,
    changed: false,
    omit: false,
    details: null,
  };
}

export function sanitizeInjectionMessages(
  settings = {},
  taskType,
  messages = [],
  {
    blockedContents = [],
    debugState = null,
    regexCollector = null,
  } = {},
) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const contentOrigin = String(message?.contentOrigin || "").trim() ||
        PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
      const sanitizationEligible =
        message?.sanitizationEligible === true &&
        contentOrigin !== PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
      if (!sanitizationEligible) {
        return message;
      }

      const sanitized = sanitizeInjectionText(
        settings,
        taskType,
        String(message?.content || ""),
        {
          mode: "final-injection-safe",
          blockedContents,
          contentOrigin,
          sanitizationEligible,
          regexSourceType: String(message?.regexSourceType || ""),
          role: message?.role || "system",
          debugState,
          regexCollector,
          applySanitizer: true,
          applyHostRegex: false,
          path: `message[${index}]`,
          stage: "final-injection-safe",
        },
      );
      if (debugState && (sanitized.changed || sanitized.dropped)) {
        debugState.finalMessageStripCount += 1;
      }
      if (!String(sanitized.text || "").trim()) {
        return null;
      }
      return {
        ...message,
        content: sanitized.text,
      };
    })
    .filter(Boolean);
}
