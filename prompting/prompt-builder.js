// ST-BME: Prompt Builder
// 统一负责任务预设块排序、变量渲染，以及世界书/EJS 上下文接入。

import { debugLog, debugWarn } from "../runtime/debug-logging.js";
import { getActiveTaskProfile, getLegacyPromptForTask } from "./prompt-profiles.js";
import {
  createEmptyInjectionSanitizerDebug,
  PROMPT_CONTENT_ORIGIN,
  sanitizeInjectionText,
  sanitizeInjectionMessages,
  sanitizeInjectionStructuredValue,
} from "./injection-sanitizer.js";
import { resolveTaskWorldInfo } from "./task-worldinfo.js";
import { applyTaskRegex } from "./task-regex.js";

const WORLD_INFO_VARIABLE_KEYS = [
  "worldInfoBefore",
  "worldInfoAfter",
  "worldInfoBeforeEntries",
  "worldInfoAfterEntries",
  "worldInfoAtDepthEntries",
  "activatedWorldInfoNames",
  "taskAdditionalMessages",
];

const INPUT_CONTEXT_MVU_FIELDS = [
  "userMessage",
  "recentMessages",
  "chatMessages",
  "dialogueText",
  "candidateText",
  "candidateNodes",
  "nodeContent",
  "eventSummary",
  "characterSummary",
  "threadSummary",
  "contradictionSummary",
  "charDescription",
  "userPersona",
];

const INPUT_REGEX_STAGE_BY_FIELD = {
  userMessage: "input.userMessage",
  recentMessages: "input.recentMessages",
  chatMessages: "input.recentMessages",
  dialogueText: "input.recentMessages",
  candidateText: "input.candidateText",
  candidateNodes: "input.candidateText",
  nodeContent: "input.candidateText",
  eventSummary: "input.candidateText",
  characterSummary: "input.candidateText",
  threadSummary: "input.candidateText",
  contradictionSummary: "input.candidateText",
};

const INPUT_REGEX_ROLE_BY_FIELD = {
  userMessage: "user",
  recentMessages: "mixed",
  chatMessages: "mixed",
  dialogueText: "mixed",
};

const INPUT_HOST_REGEX_SOURCE_BY_FIELD = {
  userMessage: "user_input",
  recentMessages: "ai_output",
  chatMessages: "ai_output",
  dialogueText: "ai_output",
  candidateText: "ai_output",
  candidateNodes: "ai_output",
  nodeContent: "ai_output",
  eventSummary: "ai_output",
  characterSummary: "ai_output",
  threadSummary: "ai_output",
  contradictionSummary: "ai_output",
  charDescription: "ai_output",
  userPersona: "user_input",
};

function cloneRuntimeDebugValue(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

function getRuntimeDebugState() {
  const stateKey = "__stBmeRuntimeDebugState";
  if (
    !globalThis[stateKey] ||
    typeof globalThis[stateKey] !== "object"
  ) {
    globalThis[stateKey] = {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      updatedAt: "",
    };
  }
  return globalThis[stateKey];
}

function recordTaskPromptBuild(taskType, snapshot = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  const state = getRuntimeDebugState();
  state.taskPromptBuilds[normalizedTaskType] = {
    updatedAt: new Date().toISOString(),
    ...cloneRuntimeDebugValue(snapshot, {}),
  };
  state.updatedAt = new Date().toISOString();
}

function mergeRegexCollectors(...collectors) {
  const mergedEntries = [];
  for (const collector of collectors) {
    if (!Array.isArray(collector?.entries)) {
      continue;
    }
    mergedEntries.push(...collector.entries);
  }
  return {
    entries: mergedEntries,
  };
}

export function buildTaskExecutionDebugContext(
  promptBuild = null,
  options = {},
) {
  const promptDebug = promptBuild?.debug || {};
  const worldInfoDebug =
    promptBuild?.worldInfo?.debug || promptBuild?.worldInfoResolution?.debug || {};
  const worldInfoHit =
    Number(promptDebug.worldInfoBeforeCount || 0) +
      Number(promptDebug.worldInfoAfterCount || 0) +
      Number(promptDebug.worldInfoAtDepthCount || 0) >
    0;

  return {
    promptAssembly: {
      mode: "ordered-private-messages",
      hostInjectionPlanMode:
        promptDebug.hostInjectionPlanMode || "diagnostic-plan-only",
      privateTaskMessageCount: Number(
        promptDebug.executionMessageCount ??
          promptBuild?.executionMessages?.length ??
          promptDebug.privateTaskMessageCount ??
          promptBuild?.privateTaskMessages?.length ??
          0,
      ),
    },
    promptBuild: {
      taskType: String(promptDebug.taskType || ""),
      profileId: String(promptDebug.profileId || ""),
      profileName: String(promptDebug.profileName || ""),
      renderedBlockCount: Number(promptDebug.renderedBlockCount || 0),
      privateTaskMessageCount: Number(promptDebug.privateTaskMessageCount || 0),
    },
    effectiveDelivery:
      promptDebug.effectiveDelivery && typeof promptDebug.effectiveDelivery === "object"
        ? cloneRuntimeDebugValue(promptDebug.effectiveDelivery, {})
        : null,
    ejsRuntimeStatus: String(
      promptDebug.ejsRuntimeStatus || worldInfoDebug.ejsRuntimeStatus || "",
    ),
    worldInfo: {
      requested: promptDebug.worldInfoRequested !== false,
      hit: worldInfoHit,
      cacheHit: Boolean(promptDebug.worldInfoCacheHit),
      beforeCount: Number(promptDebug.worldInfoBeforeCount || 0),
      afterCount: Number(promptDebug.worldInfoAfterCount || 0),
      atDepthCount: Number(promptDebug.worldInfoAtDepthCount || 0),
      loadMs: Number(worldInfoDebug.loadMs || 0),
    },
    mvu:
      promptDebug.mvu && typeof promptDebug.mvu === "object"
        ? cloneRuntimeDebugValue(promptDebug.mvu, {})
        : null,
    inputContext:
      promptDebug.inputContext && typeof promptDebug.inputContext === "object"
        ? cloneRuntimeDebugValue(promptDebug.inputContext, {})
        : null,
    regexInput:
      (() => {
        const merged = mergeRegexCollectors(
          promptBuild?.regexInput,
          options.regexInput,
        );
        return Array.isArray(merged.entries) && merged.entries.length > 0
          ? cloneRuntimeDebugValue(merged, {})
          : null;
      })(),
  };
}

function getByPath(target, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function normalizeRole(role) {
  const value = String(role || "system").toLowerCase();
  if (["system", "user", "assistant"].includes(value)) {
    return value;
  }
  return "system";
}

function normalizeInjectionMode(mode) {
  const value = String(mode || "append").toLowerCase();
  if (["prepend", "append", "relative"].includes(value)) {
    return value;
  }
  return "append";
}

function createExecutionMessage(
  role,
  content,
  extra = {},
) {
  const trimmedContent = String(content || "").trim();
  if (!trimmedContent) {
    return null;
  }
  return {
    role: normalizeRole(role),
    content: trimmedContent,
    ...extra,
  };
}

function isCustomWorldInfoFilterEnabled(settings = {}) {
  return String(settings?.worldInfoFilterMode || "default").trim() === "custom";
}

function usesWorldInfoSourceKey(sourceKey = "") {
  return [
    "worldInfoBefore",
    "worldInfoAfter",
    "worldInfoBeforeEntries",
    "worldInfoAfterEntries",
    "worldInfoAtDepthEntries",
    "activatedWorldInfoNames",
    "taskAdditionalMessages",
  ].includes(String(sourceKey || ""));
}

function blockUsesWorldInfoContent(block = {}) {
  if (usesWorldInfoSourceKey(block?.sourceKey)) {
    return true;
  }
  const content = String(block?.content || "");
  return /\{\{\s*(worldInfoBefore|worldInfoAfter|worldInfoBeforeEntries|worldInfoAfterEntries|worldInfoAtDepthEntries|activatedWorldInfoNames|taskAdditionalMessages)\s*\}\}/.test(
    content,
  );
}

function messageUsesWorldInfoContent(message = {}) {
  if (message?.derivedFromWorldInfo === true) {
    return true;
  }
  if (usesWorldInfoSourceKey(message?.sourceKey)) {
    return true;
  }
  return String(message?.source || "") === "worldInfo-atDepth";
}

function getOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function getPromptMessageLikeDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  if (typeof value.content === "string") {
    const role = String(value.role || "assistant").trim().toLowerCase();
    const speaker = String(
      value.speaker || value.name || value.displayName || "",
    ).trim();
    return {
      content: String(value.content || ""),
      role: role === "user" ? "user" : "assistant",
      seq: getOptionalFiniteNumber(value.seq),
      speaker,
    };
  }

  if (typeof value.mes === "string") {
    const speaker = String(
      value.speaker || value.name || value.displayName || "",
    ).trim();
    return {
      content: String(value.mes || ""),
      role: value.is_user === true ? "user" : "assistant",
      seq: getOptionalFiniteNumber(value.seq),
      speaker,
    };
  }

  return null;
}

function isPromptMessageArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => getPromptMessageLikeDescriptor(entry))
  );
}

function formatPromptMessageTranscript(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry, index) => {
      const descriptor = getPromptMessageLikeDescriptor(entry);
      if (!descriptor) {
        return "";
      }
      const seqLabel =
        descriptor.seq != null ? `#${descriptor.seq}` : `#${index + 1}`;
      const speakerLabel = descriptor.speaker
        ? `|${descriptor.speaker}`
        : "";
      return `${seqLabel} [${descriptor.role}${speakerLabel}]: ${descriptor.content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function stringifyInterpolatedValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (getPromptMessageLikeDescriptor(value)) {
    return formatPromptMessageTranscript(value);
  }
  if (isPromptMessageArray(value)) {
    return formatPromptMessageTranscript(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildEmptyWorldInfoContext() {
  return {
    worldInfoBefore: "",
    worldInfoAfter: "",
    worldInfoBeforeEntries: [],
    worldInfoAfterEntries: [],
    worldInfoAtDepthEntries: [],
    activatedWorldInfoNames: [],
    taskAdditionalMessages: [],
    worldInfoDebug: null,
  };
}

function createEmptyMvuPromptDebug() {
  return createEmptyInjectionSanitizerDebug();
}

function pushMvuPromptDebugEntry(debugState, entry = {}) {
  if (!debugState || !entry || (!entry.changed && !entry.dropped)) {
    return;
  }

  debugState.sanitizedFields.push({
    name: String(entry.name || ""),
    stage: String(entry.stage || ""),
    changed: Boolean(entry.changed),
    dropped: Boolean(entry.dropped),
    reasons: Array.isArray(entry.reasons) ? [...entry.reasons] : [],
    blockedHitCount: Number(entry.blockedHitCount || 0),
  });
  debugState.sanitizedFieldCount = debugState.sanitizedFields.length;
}

function sanitizeTaskPromptText(
  settings = {},
  taskType,
  text,
  {
    mode = "injection-safe",
    blockedContents = [],
    regexStage = "",
    role = "system",
    regexCollector = null,
    applyMvu = true,
    contentOrigin = PROMPT_CONTENT_ORIGIN.HOST_INJECTED,
    sanitizationEligible = true,
    regexSourceType = "",
  } = {},
) {
  const sanitized = sanitizeInjectionText(settings, taskType, text, {
    mode:
      String(mode || "").trim() === "final-safe"
        ? "final-injection-safe"
        : "injection-safe",
    blockedContents,
    contentOrigin,
    sanitizationEligible,
    regexSourceType,
    role,
    regexCollector,
    applySanitizer: applyMvu,
    applyHostRegex: Boolean(regexSourceType),
  });
  const finalText = regexStage
    ? applyTaskRegex(
        settings,
        taskType,
        regexStage,
        sanitized.text,
        regexCollector,
        role,
      )
    : sanitized.text;

  return {
    ...sanitized,
    text: finalText,
    changed: finalText !== String(text || ""),
  };
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

  return Object.values(value).some((item) =>
    looksLikeMvuStateContainer(item, seen),
  );
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

function sanitizeStructuredPromptValue(
  settings = {},
  taskType,
  value,
  {
    fieldName = "",
    path = fieldName,
    mode = "aggressive",
    blockedContents = [],
    regexStage = "",
    role = "system",
    debugState = null,
    regexCollector = null,
    applyMvu = true,
    stripMvuContainers = true,
    seen = new WeakSet(),
  } = {},
) {
  if (typeof value === "string") {
    const sanitized = sanitizeTaskPromptText(settings, taskType, value, {
      mode,
      blockedContents,
      regexStage,
      role,
      regexCollector,
      applyMvu,
    });
    pushMvuPromptDebugEntry(debugState, {
      name: path || fieldName,
      stage: regexStage,
      ...sanitized,
    });
    return {
      value: sanitized.text,
      changed: Boolean(sanitized.changed || sanitized.dropped),
      omit:
        !String(sanitized.text || "").trim() &&
        String(value || "").trim().length > 0,
    };
  }

  if (Array.isArray(value)) {
    const sanitizedArray = [];
    let changed = false;
    for (let index = 0; index < value.length; index += 1) {
      const childResult = sanitizeStructuredPromptValue(
        settings,
        taskType,
        value[index],
        {
          fieldName,
          path: joinStructuredPath(path, `[${index}]`),
          mode,
          blockedContents,
          regexStage,
          role,
          debugState,
          regexCollector,
          applyMvu,
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
    };
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return {
        value,
        changed: false,
        omit: false,
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
        pushMvuPromptDebugEntry(debugState, {
          name: joinStructuredPath(path, key),
          stage: regexStage,
          changed: true,
          dropped: true,
          reasons: [stripReason],
          blockedHitCount: 0,
        });
        continue;
      }

      const childResult = sanitizeStructuredPromptValue(
        settings,
        taskType,
        entryValue,
        {
          fieldName,
          path: joinStructuredPath(path, key),
          mode,
          blockedContents,
          regexStage,
          role,
          debugState,
          regexCollector,
          applyMvu,
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
    };
  }

  return {
    value,
    changed: false,
    omit: false,
  };
}

function sanitizePromptMessages(
  settings = {},
  taskType,
  messages = [],
  {
    blockedContents = [],
    debugState = null,
    regexCollector = null,
    applySanitizer = null,
  } = {},
) {
  const preparedMessages = (Array.isArray(messages) ? messages : []).map(
    (message, index) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      const shouldSanitize =
        typeof applySanitizer === "function"
          ? applySanitizer(message, index)
          : applySanitizer;
      if (shouldSanitize === false) {
        return {
          ...message,
          sanitizationEligible: false,
        };
      }
      return message;
    },
  );

  return sanitizeInjectionMessages(settings, taskType, preparedMessages, {
    blockedContents,
    debugState,
    regexCollector,
  })
    .map((message) =>
      createExecutionMessage(message.role, message.content, {
        source: String(message?.source || ""),
        blockId: String(message?.blockId || ""),
        blockName: String(message?.blockName || ""),
        blockType: String(message?.blockType || ""),
        sourceKey: String(message?.sourceKey || ""),
        injectionMode: String(message?.injectionMode || ""),
        derivedFromWorldInfo: message?.derivedFromWorldInfo === true,
        contentOrigin: String(message?.contentOrigin || ""),
        sanitizationEligible: message?.sanitizationEligible === true,
        regexSourceType: String(message?.regexSourceType || ""),
      }),
    )
    .filter(Boolean);
}

function resolveStructuredMessageSanitizerInput(fieldName = "", context = {}, value) {
  const normalizedFieldName = String(fieldName || "").trim();
  if (!["recentMessages", "dialogueText"].includes(normalizedFieldName)) {
    return {
      value,
      renderAsTranscript: false,
    };
  }

  if (
    typeof value === "string" &&
    Array.isArray(context?.chatMessages) &&
    isPromptMessageArray(context.chatMessages)
  ) {
    return {
      value: context.chatMessages,
      renderAsTranscript: true,
    };
  }

  return {
    value,
    renderAsTranscript: false,
  };
}

function sanitizePromptContextInputs(
  settings = {},
  taskType,
  context = {},
  debugState = null,
  regexCollector = null,
  options = {},
) {
  const sanitizedContext = {
    ...context,
  };
  const {
    applyMvu = true,
    stripMvuContainers = applyMvu,
  } = options || {};

  const applyLocalRegexToStructuredValue = (
    value,
    regexStage,
    regexRole,
    seen = new WeakSet(),
  ) => {
    if (!regexStage) {
      return value;
    }
    if (typeof value === "string") {
      return applyTaskRegex(
        settings,
        taskType,
        regexStage,
        value,
        regexCollector,
        regexRole,
      );
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        applyLocalRegexToStructuredValue(item, regexStage, regexRole, seen),
      );
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return value;
      }
      seen.add(value);
      const messageDescriptor = getPromptMessageLikeDescriptor(value);
      if (messageDescriptor) {
        const contentKey = typeof value.content === "string"
          ? "content"
          : typeof value.mes === "string"
            ? "mes"
            : "";
        const messageRole = messageDescriptor.role === "user"
          ? "user"
          : messageDescriptor.role === "assistant"
            ? "assistant"
            : regexRole;
        return Object.fromEntries(
          Object.entries(value).map(([key, entryValue]) => [
            key,
            key === contentKey
              ? applyLocalRegexToStructuredValue(
                  entryValue,
                  regexStage,
                  messageRole,
                  seen,
                )
              : entryValue,
          ]),
        );
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [
          key,
          applyLocalRegexToStructuredValue(
            entryValue,
            regexStage,
            regexRole,
            seen,
          ),
        ]),
      );
    }
    return value;
  };

  for (const fieldName of INPUT_CONTEXT_MVU_FIELDS) {
    if (!(fieldName in sanitizedContext)) {
      continue;
    }
    const value = sanitizedContext[fieldName];
    const structuredSanitizerInput = resolveStructuredMessageSanitizerInput(
      fieldName,
      context,
      value,
    );
    const valueForSanitizer = structuredSanitizerInput.value;
    const regexStage = INPUT_REGEX_STAGE_BY_FIELD[fieldName] || "";
    const regexRole = INPUT_REGEX_ROLE_BY_FIELD[fieldName] || "system";
    const regexSourceType = INPUT_HOST_REGEX_SOURCE_BY_FIELD[fieldName] || "";
    const sanitized = sanitizeInjectionStructuredValue(
      settings,
      taskType,
      valueForSanitizer,
      {
        fieldName,
        path: fieldName,
        mode: "injection-safe",
        contentOrigin: PROMPT_CONTENT_ORIGIN.HOST_INJECTED,
        sanitizationEligible: true,
        regexSourceType,
        role: regexRole,
        debugState,
        regexCollector,
        applySanitizer: applyMvu,
        applyHostRegex: Boolean(regexSourceType),
        stripMvuContainers,
      },
    );
    let sanitizedValue = sanitized.omit
      ? Array.isArray(valueForSanitizer)
        ? []
        : typeof valueForSanitizer === "string"
          ? ""
          : null
      : sanitized.value;
    sanitizedValue = applyLocalRegexToStructuredValue(
      sanitizedValue,
      regexStage,
      regexRole,
    );
    if (structuredSanitizerInput.renderAsTranscript) {
      sanitizedValue = stringifyInterpolatedValue(sanitizedValue);
    }
    sanitizedContext[fieldName] = sanitizedValue;
  }

  return sanitizedContext;
}

function sanitizeWorldInfoEntries(
  settings = {},
  taskType,
  entries = [],
  blockedContents = [],
  debugState = null,
  regexCollector = null,
  { applyMvu = true } = {},
) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const sanitized = sanitizeInjectionText(
        settings,
        taskType,
        String(entry?.content || ""),
        {
          mode: "injection-safe",
          blockedContents,
          contentOrigin: PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED,
          sanitizationEligible: true,
          regexSourceType: "world_info",
          role: entry?.role || "system",
          regexCollector,
          applySanitizer: applyMvu,
          applyHostRegex: true,
          path: `worldInfo[${index}]`,
          stage: "world-info-rendered",
        },
      );
      debugState.worldInfoBlockedContentHits += sanitized.blockedHitCount;
      if (sanitized.changed || sanitized.dropped) {
        debugState.finalMessageStripCount += 1;
      }
      if (!sanitized.text.trim()) {
        return null;
      }
      return {
        ...entry,
        content: sanitized.text,
        index:
          Number.isFinite(Number(entry?.index))
            ? Number(entry.index)
            : index,
      };
    })
    .filter(Boolean);
}

function sanitizeWorldInfoContext(
  settings = {},
  taskType,
  worldInfo = null,
  debugState = null,
  regexCollector = null,
) {
  const isCustomFilter = isCustomWorldInfoFilterEnabled(settings);
  const rawDebug =
    worldInfo?.debug && typeof worldInfo.debug === "object"
      ? worldInfo.debug
      : null;
  const blockedContentsCount = Number(rawDebug?.mvu?.blockedContentsCount || 0);
  const blockedContents = [];
  if (blockedContentsCount > 0 && Array.isArray(rawDebug?.mvu?.filteredEntries)) {
    // Use only the structural count for debug; blocked content strings stay internal
    // on the world info object via the non-enumerable runtime property below.
  }

  const runtimeBlockedContents = Array.isArray(worldInfo?.__mvuBlockedContents)
    ? worldInfo.__mvuBlockedContents
    : [];

  const beforeEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.beforeEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
    { applyMvu: !isCustomFilter },
  );
  const afterEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.afterEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
    { applyMvu: !isCustomFilter },
  );
  const atDepthEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.atDepthEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
    { applyMvu: !isCustomFilter },
  );
  const additionalMessages = (Array.isArray(worldInfo?.additionalMessages)
    ? worldInfo.additionalMessages
    : []
  )
    .map((message) => {
      const sanitized = sanitizeInjectionText(
        settings,
        taskType,
        String(message?.content || ""),
        {
          mode: "injection-safe",
          blockedContents: runtimeBlockedContents,
          contentOrigin: PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED,
          sanitizationEligible: true,
          regexSourceType: "world_info",
          role: message?.role || "system",
          regexCollector,
          applySanitizer: !isCustomFilter,
          applyHostRegex: true,
          path: "taskAdditionalMessages",
          stage: "world-info-rendered",
        },
      );
      debugState.worldInfoBlockedContentHits += sanitized.blockedHitCount;
      if (sanitized.changed || sanitized.dropped) {
        debugState.finalMessageStripCount += 1;
      }
      if (!sanitized.text.trim()) {
        return null;
      }
      return {
        ...message,
        content: sanitized.text,
        source: String(message?.source || "worldInfo-atDepth"),
        sourceKey: String(message?.sourceKey || "taskAdditionalMessages"),
        contentOrigin: PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED,
        sanitizationEligible: true,
        regexSourceType: "world_info",
      };
    })
    .filter(Boolean);

  const beforeText = beforeEntries.map((entry) => entry.content).join("\n\n");
  const afterText = afterEntries.map((entry) => entry.content).join("\n\n");
  const activatedEntryNames = [
    ...beforeEntries.map((entry) => entry.name),
    ...afterEntries.map((entry) => entry.name),
    ...atDepthEntries.map((entry) => entry.name),
  ].filter(Boolean);

  const sanitizedWorldInfo = {
    beforeEntries,
    afterEntries,
    atDepthEntries,
    beforeText,
    afterText,
    additionalMessages,
    activatedEntryNames: [...new Set(activatedEntryNames)],
    debug: rawDebug,
  };

  Object.defineProperty(sanitizedWorldInfo, "__mvuBlockedContents", {
    value: [...runtimeBlockedContents],
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return sanitizedWorldInfo;
}

function createHostInjectionEntry(
  entry = {},
  position = "after",
  source = "worldInfo",
) {
  return {
    source,
    position,
    role: normalizeRole(entry.role),
    content: String(entry.content || "").trim(),
    name: String(entry.name || ""),
    sourceName: String(entry.sourceName || entry.name || ""),
    worldbook: String(entry.worldbook || ""),
    depth:
      position === "atDepth" && Number.isFinite(Number(entry.depth))
        ? Number(entry.depth)
        : null,
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
  };
}

function buildWorldInfoResolution(worldInfoContext = {}) {
  const beforeEntries = Array.isArray(worldInfoContext.worldInfoBeforeEntries)
    ? worldInfoContext.worldInfoBeforeEntries
    : [];
  const afterEntries = Array.isArray(worldInfoContext.worldInfoAfterEntries)
    ? worldInfoContext.worldInfoAfterEntries
    : [];
  const atDepthEntries = Array.isArray(worldInfoContext.worldInfoAtDepthEntries)
    ? worldInfoContext.worldInfoAtDepthEntries
    : [];
  const additionalMessages = Array.isArray(worldInfoContext.taskAdditionalMessages)
    ? worldInfoContext.taskAdditionalMessages
    : [];

  return {
    beforeText: String(worldInfoContext.worldInfoBefore || ""),
    afterText: String(worldInfoContext.worldInfoAfter || ""),
    beforeEntries,
    afterEntries,
    atDepthEntries,
    activatedEntryNames: Array.isArray(worldInfoContext.activatedWorldInfoNames)
      ? worldInfoContext.activatedWorldInfoNames
      : [],
    additionalMessages,
    debug:
      worldInfoContext.worldInfoDebug &&
      typeof worldInfoContext.worldInfoDebug === "object"
        ? worldInfoContext.worldInfoDebug
        : null,
    injections: {
      before: beforeEntries
        .map((entry) => createHostInjectionEntry(entry, "before"))
        .filter((entry) => entry.content),
      after: afterEntries
        .map((entry) => createHostInjectionEntry(entry, "after"))
        .filter((entry) => entry.content),
      atDepth: atDepthEntries
        .map((entry) => createHostInjectionEntry(entry, "atDepth"))
        .filter((entry) => entry.content),
    },
  };
}

function sortInjectionEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const orderLeft = Number.isFinite(Number(left?.order))
      ? Number(left.order)
      : 0;
    const orderRight = Number.isFinite(Number(right?.order))
      ? Number(right.order)
      : 0;
    return orderLeft - orderRight;
  });
}

function sortAtDepthInjectionEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const depthLeft = Number.isFinite(Number(left?.depth))
      ? Number(left.depth)
      : 0;
    const depthRight = Number.isFinite(Number(right?.depth))
      ? Number(right.depth)
      : 0;
    const orderLeft = Number.isFinite(Number(left?.order))
      ? Number(left.order)
      : 0;
    const orderRight = Number.isFinite(Number(right?.order))
      ? Number(right.order)
      : 0;
    const uidLeft = Number.isFinite(Number(left?.uid))
      ? Number(left.uid)
      : Number.NEGATIVE_INFINITY;
    const uidRight = Number.isFinite(Number(right?.uid))
      ? Number(right.uid)
      : Number.NEGATIVE_INFINITY;
    const indexLeft = Number.isFinite(Number(left?.index))
      ? Number(left.index)
      : 0;
    const indexRight = Number.isFinite(Number(right?.index))
      ? Number(right.index)
      : 0;
    return (
      depthRight - depthLeft ||
      orderLeft - orderRight ||
      uidRight - uidLeft ||
      indexLeft - indexRight
    );
  });
}

function createHostInjectionPlanEntry(block = {}, position, extra = {}) {
  return {
    source: "block",
    origin: "profile-block",
    position,
    role: normalizeRole(block.role),
    content: String(block.content || "").trim(),
    blockId: String(block.id || ""),
    blockName: String(block.name || ""),
    sourceKey: String(block.sourceKey || ""),
    injectionMode: normalizeInjectionMode(block.injectionMode),
    order: Number.isFinite(Number(block.order)) ? Number(block.order) : 0,
    ...extra,
  };
}

function buildHostInjectionPlan(renderedBlocks = [], worldInfoResolution = {}) {
  const beforeEntryNames = (
    Array.isArray(worldInfoResolution.beforeEntries)
      ? worldInfoResolution.beforeEntries
      : []
  )
    .map((entry) => String(entry?.name || entry?.sourceName || "").trim())
    .filter(Boolean);
  const afterEntryNames = (
    Array.isArray(worldInfoResolution.afterEntries)
      ? worldInfoResolution.afterEntries
      : []
  )
    .map((entry) => String(entry?.name || entry?.sourceName || "").trim())
    .filter(Boolean);
  const atDepthEntries = Array.isArray(worldInfoResolution.injections?.atDepth)
    ? worldInfoResolution.injections.atDepth
    : [];

  const plan = {
    before: [],
    after: [],
    atDepth: [],
  };

  for (const block of renderedBlocks) {
    if (!block?.content) continue;

    if (
      block.type === "builtin" &&
      String(block.sourceKey || "") === "worldInfoBefore"
    ) {
      plan.before.push(
        createHostInjectionPlanEntry(block, "before", {
          entryNames: beforeEntryNames,
          entryCount: beforeEntryNames.length,
        }),
      );
      continue;
    }

    if (
      block.type === "builtin" &&
      String(block.sourceKey || "") === "worldInfoAfter"
    ) {
      plan.after.push(
        createHostInjectionPlanEntry(block, "after", {
          entryNames: afterEntryNames,
          entryCount: afterEntryNames.length,
        }),
      );
    }
  }

  for (const entry of atDepthEntries) {
    if (!entry?.content) continue;
    plan.atDepth.push({
      ...entry,
      origin: "worldInfo-entry",
      entryName: String(entry.name || entry.sourceName || "").trim(),
    });
  }

  return {
    before: sortInjectionEntries(plan.before),
    after: sortInjectionEntries(plan.after),
    atDepth: sortAtDepthInjectionEntries(plan.atDepth),
  };
}

function createInjectedAtDepthChatMessage(message = {}) {
  const descriptor = getPromptMessageLikeDescriptor(message);
  if (!descriptor) {
    return null;
  }
  return {
    ...(message && typeof message === "object" ? message : {}),
    role: descriptor.role,
    content: descriptor.content,
    seq: descriptor.seq,
    uid: Number.isFinite(Number(message?.uid))
      ? Number(message.uid)
      : null,
    index: Number.isFinite(Number(message?.index))
      ? Number(message.index)
      : null,
    name: String(message?.name || ""),
    sourceName: String(message?.sourceName || ""),
    worldbook: String(message?.worldbook || ""),
    source: String(message?.source || "worldInfo-atDepth"),
    sourceKey: String(message?.sourceKey || "taskAdditionalMessages"),
    derivedFromWorldInfo: true,
    contentOrigin:
      String(message?.contentOrigin || "") ||
      PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED,
    sanitizationEligible: message?.sanitizationEligible === true,
    regexSourceType: String(message?.regexSourceType || "world_info"),
    depth: Number.isFinite(Number(message?.depth))
      ? Number(message.depth)
      : 0,
    order: Number.isFinite(Number(message?.order))
      ? Number(message.order)
      : 0,
  };
}

function injectAtDepthMessagesIntoChatMessages(
  chatMessages = [],
  atDepthMessages = [],
) {
  const normalizedChatMessages = (Array.isArray(chatMessages) ? chatMessages : [])
    .map((message) => {
      const descriptor = getPromptMessageLikeDescriptor(message);
      if (!descriptor) return null;
      return {
        ...(message && typeof message === "object" ? message : {}),
        role: descriptor.role,
        content: descriptor.content,
        seq: descriptor.seq,
      };
    })
    .filter(Boolean);
  if (normalizedChatMessages.length === 0) {
    return null;
  }

  const groupedByDepth = new Map();
  for (const message of sortAtDepthInjectionEntries(atDepthMessages)) {
    const injectedMessage = createInjectedAtDepthChatMessage(message);
    if (!injectedMessage) continue;
    const depth = Math.max(0, Number(injectedMessage.depth || 0));
    if (!groupedByDepth.has(depth)) {
      groupedByDepth.set(depth, []);
    }
    groupedByDepth.get(depth).push(injectedMessage);
  }
  if (groupedByDepth.size === 0) {
    return normalizedChatMessages;
  }

  const reversedMessages = [...normalizedChatMessages].reverse();
  const sortedDepths = [...groupedByDepth.keys()].sort((left, right) => left - right);
  let totalInsertedMessages = 0;

  for (const depth of sortedDepths) {
    const depthMessages = groupedByDepth.get(depth) || [];
    if (depthMessages.length === 0) continue;
    const injectIndex = Math.min(
      Math.max(0, depth + totalInsertedMessages),
      reversedMessages.length,
    );
    reversedMessages.splice(injectIndex, 0, ...depthMessages);
    totalInsertedMessages += depthMessages.length;
  }

  return reversedMessages.reverse();
}

function getPromptFieldContentOrigin(sourceKey = "") {
  const normalizedSourceKey = String(sourceKey || "").trim();
  if (!normalizedSourceKey) {
    return PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
  }
  if (WORLD_INFO_VARIABLE_KEYS.includes(normalizedSourceKey)) {
    return PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED;
  }
  if (INPUT_CONTEXT_MVU_FIELDS.includes(normalizedSourceKey)) {
    return PROMPT_CONTENT_ORIGIN.HOST_INJECTED;
  }
  return PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
}

function getPromptFieldRegexSourceType(sourceKey = "") {
  const normalizedSourceKey = String(sourceKey || "").trim();
  if (!normalizedSourceKey) {
    return "";
  }
  if (WORLD_INFO_VARIABLE_KEYS.includes(normalizedSourceKey)) {
    return "world_info";
  }
  return INPUT_HOST_REGEX_SOURCE_BY_FIELD[normalizedSourceKey] || "";
}

function blockIsPureInjectedContent(block = {}) {
  return (
    block?.type === "builtin" &&
    !String(block?.content || "").trim() &&
    String(block?.sourceKey || "").trim().length > 0
  );
}

function describeBlockContentOwnership(block = {}) {
  const contentOrigin = blockIsPureInjectedContent(block)
    ? getPromptFieldContentOrigin(block.sourceKey)
    : PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED;
  return {
    contentOrigin,
    sanitizationEligible:
      contentOrigin !== PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED,
    regexSourceType:
      contentOrigin === PROMPT_CONTENT_ORIGIN.TEMPLATE_OWNED
        ? ""
        : getPromptFieldRegexSourceType(block.sourceKey),
  };
}

function resolveBlockDelivery(block = {}) {
  return normalizeRole(block.role) === "system"
    ? "private.system"
    : "private.message";
}

function getBlockDiagnosticInjectionPosition(block = {}) {
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoBefore"
  ) {
    return "before";
  }
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoAfter"
  ) {
    return "after";
  }
  return "";
}

function profileRequiresWorldInfo(profile) {
  if (
    profile?.worldInfo === false ||
    profile?.metadata?.disableWorldInfo === true
  ) {
    return false;
  }

  const blocks = Array.isArray(profile?.blocks) ? profile.blocks : [];
  for (const block of blocks) {
    if (!block || block.enabled === false) continue;
    if (
      block.type === "builtin" &&
      ["worldInfoBefore", "worldInfoAfter"].includes(String(block.sourceKey || ""))
    ) {
      return true;
    }

    const rawContent = String(block.content || "");
    if (!rawContent.includes("{{")) continue;
    if (
      WORLD_INFO_VARIABLE_KEYS.some((key) =>
        rawContent.includes(`{{${key}}}`) ||
        rawContent.includes(`{{ ${key} }}`),
      )
    ) {
      return true;
    }
  }

  // atDepth world info is implicit in the final message chain, so profiles
  // without explicit before/after placeholders should still resolve lore.
  return blocks.some((block) => block && block.enabled !== false);
}

function extractWorldInfoChatMessages(context = {}) {
  if (Array.isArray(context.chatMessages)) {
    return context.chatMessages;
  }
  return [];
}

export async function buildTaskPrompt(settings = {}, taskType, context = {}) {
  const isCustomFilter = isCustomWorldInfoFilterEnabled(settings);
  const profile = getActiveTaskProfile(settings, taskType);
  const legacyPrompt = getLegacyPromptForTask(settings, taskType);
  const promptRegexInput = { entries: [] };
  const mvuPromptDebug = createEmptyMvuPromptDebug();
  const taskInputDebug =
    context?.taskInputDebug && typeof context.taskInputDebug === "object"
      ? cloneRuntimeDebugValue(context.taskInputDebug, {})
      : null;
  const worldInfoInputContext = {
    ...context,
  };
  const sanitizedInputContext = sanitizePromptContextInputs(
    settings,
    taskType,
    context,
    mvuPromptDebug,
    promptRegexInput,
  );
  const rawBlocks = Array.isArray(profile?.blocks) ? profile.blocks : [];
  const blocks = rawBlocks
    .map((block, index) => ({ ...block, _orderIndex: index }))
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.order))
        ? Number(a.order)
        : a._orderIndex;
      const orderB = Number.isFinite(Number(b.order))
        ? Number(b.order)
        : b._orderIndex;
      return orderA - orderB;
    });

  const worldInfoRequested = context?.__skipWorldInfo === true
    ? false
    : profileRequiresWorldInfo(profile);
  const emptyWorldInfo = buildEmptyWorldInfoContext();
  let resolvedWorldInfo = emptyWorldInfo;
  let worldInfoRuntimeBlockedContents = [];
  let deliveredAtDepthViaChatMessages = false;

  if (worldInfoRequested) {
    const worldInfo = await resolveTaskWorldInfo({
      settings,
      chatMessages: extractWorldInfoChatMessages(worldInfoInputContext),
      userMessage: String(worldInfoInputContext.userMessage || ""),
      templateContext: worldInfoInputContext,
    });
    const sanitizedWorldInfo = sanitizeWorldInfoContext(
      settings,
      taskType,
      worldInfo,
      mvuPromptDebug,
      promptRegexInput,
    );
    worldInfoRuntimeBlockedContents = Array.isArray(
      sanitizedWorldInfo.__mvuBlockedContents,
    )
      ? sanitizedWorldInfo.__mvuBlockedContents
      : [];
    resolvedWorldInfo = {
      worldInfoBefore: sanitizedWorldInfo.beforeText || "",
      worldInfoAfter: sanitizedWorldInfo.afterText || "",
      worldInfoBeforeEntries: sanitizedWorldInfo.beforeEntries || [],
      worldInfoAfterEntries: sanitizedWorldInfo.afterEntries || [],
      worldInfoAtDepthEntries: sanitizedWorldInfo.atDepthEntries || [],
      activatedWorldInfoNames: sanitizedWorldInfo.activatedEntryNames || [],
      taskAdditionalMessages: sanitizedWorldInfo.additionalMessages || [],
      worldInfoDebug: sanitizedWorldInfo.debug || null,
    };

    if (
      Array.isArray(sanitizedInputContext.chatMessages) &&
      isPromptMessageArray(sanitizedInputContext.chatMessages)
    ) {
      const injectedChatMessages = injectAtDepthMessagesIntoChatMessages(
        sanitizedInputContext.chatMessages,
        sanitizedWorldInfo.additionalMessages,
      );
      if (Array.isArray(injectedChatMessages) && injectedChatMessages.length > 0) {
        sanitizedInputContext.chatMessages = injectedChatMessages;
        if (typeof context.recentMessages === "string") {
          sanitizedInputContext.recentMessages =
            stringifyInterpolatedValue(injectedChatMessages);
        }
        if (typeof context.dialogueText === "string") {
          sanitizedInputContext.dialogueText =
            stringifyInterpolatedValue(injectedChatMessages);
        }
        deliveredAtDepthViaChatMessages = true;
      }
    }
  }

  const resolvedContext = {
    ...sanitizedInputContext,
    ...emptyWorldInfo,
    ...resolvedWorldInfo,
  };
  const worldInfoResolution = buildWorldInfoResolution(resolvedContext);

  let systemPrompt = "";
  const customMessages = [];
  const executionMessages = [];
  const renderedBlocks = [];
  let userRoleBlockCount = 0;
  let assistantRoleBlockCount = 0;
  let systemRoleBlockCount = 0;

  debugLog(
    `[ST-BME][prompt-diag] buildTaskPrompt: taskType=${taskType}, ` +
      `total blocks=${blocks.length}, ` +
      `block roles=[${blocks.map((b) => `${b.name}(${b.role},${b.enabled !== false ? "on" : "off"})`).join(", ")}]`,
  );

  for (const block of blocks) {
    if (!block || block.enabled === false) continue;

    const role = normalizeRole(block.role);
    const blockDerivedFromWorldInfo = blockUsesWorldInfoContent(block);
    const blockOwnership = describeBlockContentOwnership(block);
    let content = "";

    if (block.type === "legacyPrompt") {
      content = legacyPrompt || block.content || "";
    } else if (block.type === "builtin") {
      if (block.content) {
        content = interpolateVariables(block.content, resolvedContext);
      } else if (block.sourceKey) {
        content = stringifyInterpolatedValue(
          getByPath(resolvedContext, block.sourceKey),
        );
      }
    } else if (block.type === "custom") {
      content = interpolateVariables(block.content || "", resolvedContext);
    }

    if (role === "user") {
      debugLog(
        `[ST-BME][prompt-diag] user block "${block.name || block.id}": ` +
          `type=${block.type}, contentLen=${String(content || "").length}, ` +
          `rawContentLen=${String(block.content || "").length}, ` +
          `blockedContentsCount=${worldInfoRuntimeBlockedContents.length}`,
      );
    }

    if (!String(content || "").trim()) {
      continue;
    }

    const mode = normalizeInjectionMode(block.injectionMode);
    renderedBlocks.push({
      id: String(block.id || ""),
      name: String(block.name || ""),
      type: String(block.type || "custom"),
      role,
      sourceKey: String(block.sourceKey || ""),
      sourceField: String(block.sourceField || ""),
      content,
      order: Number.isFinite(Number(block.order))
        ? Number(block.order)
        : block._orderIndex,
      derivedFromWorldInfo: blockDerivedFromWorldInfo,
      injectionMode: mode,
      delivery: resolveBlockDelivery(block),
      effectiveDelivery: resolveBlockDelivery(block),
      diagnosticInjectionPosition: getBlockDiagnosticInjectionPosition(block),
      contentOrigin: blockOwnership.contentOrigin,
      sanitizationEligible: blockOwnership.sanitizationEligible,
      regexSourceType: blockOwnership.regexSourceType,
    });

    const executionMessage = createExecutionMessage(role, content, {
      source: "profile-block",
      blockId: String(block.id || ""),
      blockName: String(block.name || ""),
      blockType: String(block.type || "custom"),
      sourceKey: String(block.sourceKey || ""),
      injectionMode: mode,
      derivedFromWorldInfo: blockDerivedFromWorldInfo,
      contentOrigin: blockOwnership.contentOrigin,
      sanitizationEligible: blockOwnership.sanitizationEligible,
      regexSourceType: blockOwnership.regexSourceType,
    });
    if (executionMessage) {
      executionMessages.push(executionMessage);
    }

    if (role === "system") {
      systemRoleBlockCount += 1;
      if (!systemPrompt) {
        systemPrompt = content;
      } else if (mode === "prepend") {
        systemPrompt = `${content}\n\n${systemPrompt}`;
      } else {
        systemPrompt = `${systemPrompt}\n\n${content}`;
      }
      continue;
    }

    if (role === "user") {
      userRoleBlockCount += 1;
    } else if (role === "assistant") {
      assistantRoleBlockCount += 1;
    }
    if (mode === "prepend") {
      customMessages.unshift({
        role,
        content,
        source: "profile-block",
        blockId: String(block.id || ""),
        blockName: String(block.name || ""),
        blockType: String(block.type || "custom"),
        sourceKey: String(block.sourceKey || ""),
        injectionMode: mode,
        derivedFromWorldInfo: blockDerivedFromWorldInfo,
        contentOrigin: blockOwnership.contentOrigin,
        sanitizationEligible: blockOwnership.sanitizationEligible,
        regexSourceType: blockOwnership.regexSourceType,
      });
    } else {
      customMessages.push({
        role,
        content,
        source: "profile-block",
        blockId: String(block.id || ""),
        blockName: String(block.name || ""),
        blockType: String(block.type || "custom"),
        sourceKey: String(block.sourceKey || ""),
        injectionMode: mode,
        derivedFromWorldInfo: blockDerivedFromWorldInfo,
        contentOrigin: blockOwnership.contentOrigin,
        sanitizationEligible: blockOwnership.sanitizationEligible,
        regexSourceType: blockOwnership.regexSourceType,
      });
    }
  }

  const atDepthExecutionMessages = (worldInfoResolution.additionalMessages || [])
    .map((message) =>
      createExecutionMessage(
        message.role,
        message.content,
        {
          source: "worldInfo-atDepth",
          sourceKey: "taskAdditionalMessages",
          contentOrigin:
            String(message.contentOrigin || "") ||
            PROMPT_CONTENT_ORIGIN.WORLD_INFO_RENDERED,
          sanitizationEligible: message.sanitizationEligible === true,
          regexSourceType: String(message.regexSourceType || "world_info"),
          depth: Number.isFinite(Number(message?.depth))
            ? Number(message.depth)
            : null,
          order: Number.isFinite(Number(message?.order))
            ? Number(message.order)
            : 0,
        },
      ),
    )
    .filter(Boolean);
  const finalExecutionMessages = deliveredAtDepthViaChatMessages
    ? executionMessages
    : [...atDepthExecutionMessages, ...executionMessages];

  const privateTaskMessages = deliveredAtDepthViaChatMessages
    ? [...customMessages]
    : [...worldInfoResolution.additionalMessages, ...customMessages];
  debugLog(
    `[ST-BME][prompt-diag] buildTaskPrompt done: ` +
      `executionMessages=${finalExecutionMessages.length}, ` +
      `userBlocks=${userRoleBlockCount}, systemBlocks=${systemRoleBlockCount}, ` +
      `customMessages=${customMessages.length}, ` +
      `atDepthMessages=${atDepthExecutionMessages.length}, ` +
      `atDepthViaChatMessages=${deliveredAtDepthViaChatMessages}`,
  );
  const hostInjectionPlan = buildHostInjectionPlan(
    renderedBlocks,
    worldInfoResolution,
  );

  const result = {
    profile,
    hostInjections: worldInfoResolution.injections,
    hostInjectionPlan,
    privateTaskPrompt: {
      systemPrompt,
      messages: privateTaskMessages,
    },
    executionMessages: finalExecutionMessages,
    privateTaskMessages,
    renderedBlocks,
    regexInput: mergeRegexCollectors(promptRegexInput),
    worldInfoResolution,
    systemPrompt,
    customMessages,
    additionalMessages: worldInfoResolution.additionalMessages,
    worldInfo: {
      beforeText: worldInfoResolution.beforeText,
      afterText: worldInfoResolution.afterText,
      beforeEntries: worldInfoResolution.beforeEntries,
      afterEntries: worldInfoResolution.afterEntries,
      atDepthEntries: worldInfoResolution.atDepthEntries,
      activatedEntryNames: worldInfoResolution.activatedEntryNames,
      debug: worldInfoResolution.debug,
    },
    debug: {
      taskType,
      profileId: profile?.id || "",
      profileName: profile?.name || "",
      usedLegacyPrompt: Boolean(legacyPrompt),
      blockCount: blocks.length,
      renderedBlockCount: renderedBlocks.length,
      worldInfoRequested,
      worldInfoBeforeCount: worldInfoResolution.beforeEntries.length,
      worldInfoAfterCount: worldInfoResolution.afterEntries.length,
      worldInfoAtDepthCount: worldInfoResolution.atDepthEntries.length,
      hostInjectionCount:
        worldInfoResolution.injections.before.length +
        worldInfoResolution.injections.after.length +
        worldInfoResolution.injections.atDepth.length,
      hostInjectionPlanCount:
        hostInjectionPlan.before.length +
        hostInjectionPlan.after.length +
        hostInjectionPlan.atDepth.length,
      hostInjectionPlanMode: "diagnostic-plan-only",
      customMessageCount: customMessages.length,
      additionalMessageCount: worldInfoResolution.additionalMessages.length,
      privateTaskMessageCount: privateTaskMessages.length,
      executionMessageCount: finalExecutionMessages.length,
      userRoleBlockCount,
      assistantRoleBlockCount,
      systemRoleBlockCount,
      effectiveDelivery: {
        profileBlocks: "ordered-private-messages",
        worldInfoBeforeAfter: "inline-in-ordered-messages",
        worldInfoAtDepth: deliveredAtDepthViaChatMessages
          ? "inserted-into-chat-messages-by-depth"
          : "appended-private-messages-fallback",
      },
      worldInfoCacheHit: Boolean(worldInfoResolution.debug?.cache?.hit),
      ejsRuntimeStatus: worldInfoResolution.debug?.ejsRuntimeStatus || "",
      mvu: {
        sanitizedFieldCount: mvuPromptDebug.sanitizedFieldCount,
        sanitizedFields: cloneRuntimeDebugValue(
          mvuPromptDebug.sanitizedFields,
          [],
        ),
        finalMessageStripCount: mvuPromptDebug.finalMessageStripCount,
        worldInfoBlockedContentHits: mvuPromptDebug.worldInfoBlockedContentHits,
        sanitizerAppliedFields: cloneRuntimeDebugValue(
          mvuPromptDebug.sanitizerAppliedFields,
          [],
        ),
        sanitizerHitKinds: cloneRuntimeDebugValue(
          mvuPromptDebug.sanitizerHitKinds,
          [],
        ),
        hostReuseAppliedFields: cloneRuntimeDebugValue(
          mvuPromptDebug.hostReuseAppliedFields,
          [],
        ),
        hostReuseSkippedDisplayOnlyRules: Number(
          mvuPromptDebug.hostReuseSkippedDisplayOnlyRules || 0,
        ),
        regexExecutionMode: String(
          mvuPromptDebug.regexExecutionMode || "host-unavailable",
        ),
        hostFormatterAvailable: Boolean(
          mvuPromptDebug.hostFormatterAvailable,
        ),
        hostFormatterSource: String(
          mvuPromptDebug.hostFormatterSource || "",
        ),
        fallbackReason: String(mvuPromptDebug.fallbackReason || ""),
      },
      inputContext: taskInputDebug,
      effectivePath: {
        promptAssembly: "ordered-private-messages",
        hostInjectionPlan: "diagnostic-plan-only",
        worldInfoInputContext: "raw-context-for-trigger-and-ejs",
        ejs:
          worldInfoResolution.debug?.ejsRuntimeStatus ||
          "unknown",
        worldInfo:
          worldInfoRequested !== false
            ? worldInfoResolution.activatedEntryNames.length > 0
              ? "matched"
              : "requested-but-missed"
            : "disabled",
      },
    },
  };

  Object.defineProperty(result, "__mvuRuntime", {
    value: {
      blockedContents: [...worldInfoRuntimeBlockedContents],
    },
    configurable: true,
    enumerable: false,
    writable: false,
  });

  recordTaskPromptBuild(taskType, {
    taskType,
    profileId: profile?.id || "",
    profileName: profile?.name || "",
    systemPrompt,
    privateTaskMessages,
    executionMessages: finalExecutionMessages,
    renderedBlocks,
    hostInjections: worldInfoResolution.injections,
    hostInjectionPlan,
    worldInfoResolution,
    mvu: result.debug.mvu,
    inputContext: taskInputDebug,
    regexInput: result.regexInput,
    debug: result.debug,
  });

  return result;
}

export function buildTaskLlmPayload(promptBuild = null, fallbackUserPrompt = "") {
  const runtimeMvu = promptBuild?.__mvuRuntime || {};
  const taskType = String(promptBuild?.debug?.taskType || "");
  const settings = {};
  const isCustomFilter =
    String(
      promptBuild?.worldInfo?.debug?.customFilter?.mode ||
        promptBuild?.worldInfoResolution?.debug?.customFilter?.mode ||
        "default",
    ).trim() === "custom";
  const blockedContents = Array.isArray(runtimeMvu?.blockedContents)
    ? runtimeMvu.blockedContents
    : [];
  const rawExecutionMessages = Array.isArray(promptBuild?.executionMessages)
    ? promptBuild.executionMessages
        .map((message) =>
          createExecutionMessage(message.role, message.content, {
            source: String(message.source || ""),
            blockId: String(message.blockId || ""),
            blockName: String(message.blockName || ""),
            blockType: String(message.blockType || ""),
            sourceKey: String(message.sourceKey || ""),
            injectionMode: String(message.injectionMode || ""),
            derivedFromWorldInfo: message.derivedFromWorldInfo === true,
            contentOrigin: String(message.contentOrigin || ""),
            sanitizationEligible: message.sanitizationEligible === true,
            regexSourceType: String(message.regexSourceType || ""),
          }),
        )
        .filter(Boolean)
    : [];
  const executionMessages = sanitizePromptMessages(
    settings,
    taskType,
    rawExecutionMessages,
    {
      blockedContents,
      applySanitizer: (message) =>
        !(isCustomFilter && messageUsesWorldInfoContent(message)),
    },
  );

  const hasUserMessage = executionMessages.some(
    (message) => message.role === "user",
  );
  if (!hasUserMessage && rawExecutionMessages.length > 0) {
    const userBlocksBefore = (promptBuild?.executionMessages || []).filter(
      (m) => m?.role === "user",
    );
    const userBlocksAfterRaw = rawExecutionMessages.filter(
      (m) => m?.role === "user",
    );
    const userBlocksAfterSanitize = executionMessages.filter(
      (m) => m?.role === "user",
    );
    debugWarn(
      `[ST-BME] buildTaskLlmPayload fallback triggered: ` +
        `user blocks in promptBuild=${userBlocksBefore.length}, ` +
        `after recreate=${userBlocksAfterRaw.length}, ` +
        `after sanitize=${userBlocksAfterSanitize.length}, ` +
        `blockedContents count=${blockedContents.length}, ` +
        `total executionMessages=${executionMessages.length}`,
    );
    if (userBlocksBefore.length > 0) {
      for (const block of userBlocksBefore) {
        debugWarn(
          `[ST-BME]   user block "${block.blockName || block.blockId}": ` +
            `content length=${String(block.content || "").length}, ` +
            `content preview="${String(block.content || "").slice(0, 80)}..."`,
        );
      }
    }
    if (blockedContents.length > 0) {
      debugWarn(
        `[ST-BME]   blockedContents lengths: [${blockedContents.map((c) => String(c || "").length).join(", ")}]`,
      );
    }
  }
  const additionalMessages =
    executionMessages.length > 0
      ? []
      : sanitizePromptMessages(
          settings,
          taskType,
          Array.isArray(promptBuild?.privateTaskMessages)
            ? promptBuild.privateTaskMessages
            : [],
          {
            blockedContents,
            applySanitizer: (message) =>
              !(isCustomFilter && messageUsesWorldInfoContent(message)),
          },
        );

  return {
    systemPrompt:
      executionMessages.length > 0 ? "" : String(promptBuild?.systemPrompt || ""),
    userPrompt: hasUserMessage ? "" : String(fallbackUserPrompt || ""),
    promptMessages: executionMessages,
    additionalMessages,
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return stringifyInterpolatedValue(getByPath(context, key));
  });
}
