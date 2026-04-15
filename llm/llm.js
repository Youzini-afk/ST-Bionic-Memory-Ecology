// ST-BME: LLM 调用封装
// 包装 ST 的 sendOpenAIRequest，提供结构化 JSON 输出和重试机制

import { getRequestHeaders } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
import { chat_completion_sources, sendOpenAIRequest } from "../../../../openai.js";
import { debugLog, debugWarn } from "../runtime/debug-logging.js";
import { resolveTaskGenerationOptions } from "../runtime/generation-options.js";
import {
  resolveDedicatedLlmProviderConfig,
  resolveLlmConfigSelection,
} from "./llm-preset-utils.js";
import { getActiveTaskProfile } from "../prompting/prompt-profiles.js";
import { resolveConfiguredTimeoutMs } from "../runtime/request-timeout.js";
import { applyTaskRegex } from "../prompting/task-regex.js";

const MODULE_NAME = "st_bme";
const LLM_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_TEXT_COMPLETION_TOKENS = 64000;
const DEFAULT_JSON_COMPLETION_TOKENS = 64000;
const STREAM_DEBUG_PREVIEW_MAX_CHARS = 1200;
const STREAM_DEBUG_UPDATE_INTERVAL_MS = 120;
const TASK_DEBUG_TIMELINE_LIMIT = 24;
const TASK_DEBUG_PREVIEW_MAX_CHARS = 280;
const SENSITIVE_DEBUG_KEY_PATTERN =
  /^(authorization|proxy_password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)$/i;

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

function redactSensitiveString(value) {
  return String(value ?? "")
    .replace(/(Bearer\s+)[^\s"'\r\n]+/gi, "$1[REDACTED]")
    .replace(
      /(Authorization\s*:\s*Bearer\s+)[^\s"'\r\n]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(proxy_password\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]");
}

function redactSensitiveValue(value, currentKey = "") {
  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, currentKey));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        redactSensitiveValue(entryValue, key),
      ]),
    );
  }

  if (typeof value === "string") {
    if (SENSITIVE_DEBUG_KEY_PATTERN.test(String(currentKey || ""))) {
      return value ? "[REDACTED]" : "";
    }
    return redactSensitiveString(value);
  }

  if (SENSITIVE_DEBUG_KEY_PATTERN.test(String(currentKey || ""))) {
    return "[REDACTED]";
  }

  return value;
}

function sanitizeLlmDebugSnapshot(snapshot = {}) {
  const cloned = cloneRuntimeDebugValue(snapshot, {});
  const redacted = redactSensitiveValue(cloned);
  if (!isVerboseRuntimeDebugEnabled()) {
    return buildCompactLlmDebugSnapshot(redacted);
  }
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    redacted.redacted = true;
    redacted.debugMode = "verbose";
  }
  return redacted;
}

function isVerboseRuntimeDebugEnabled() {
  return globalThis.__stBmeVerboseDebug === true;
}

function buildPreviewText(value, maxChars = TASK_DEBUG_PREVIEW_MAX_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function summarizeMessageArray(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let totalChars = 0;
  const preview = [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index] || {};
    const role = String(message.role || message.name || "unknown");
    roles[role] = Number(roles[role] || 0) + 1;
    const content = Array.isArray(message.content)
      ? message.content
          .map((part) =>
            typeof part === "string"
              ? part
              : String(part?.text || part?.content || ""),
          )
          .join(" ")
      : String(message.content || message.text || "");
    totalChars += content.length;
    if (preview.length < 3) {
      const compact = buildPreviewText(content, 96);
      if (compact) {
        preview.push(`${role}: ${compact}`);
      }
    }
  }
  return {
    count: list.length,
    roles,
    totalChars,
    preview,
  };
}

function compactMessageDebugEntries(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(0, 6).map((message) => {
    const compact = {
      role: String(message?.role || ""),
      content: buildPreviewText(message?.content || message?.text || "", 160),
    };
    for (const key of [
      "regexSourceType",
      "source",
      "blockId",
      "blockType",
      "sourceKey",
      "contentOrigin",
    ]) {
      if (Object.prototype.hasOwnProperty.call(message || {}, key)) {
        compact[key] = cloneRuntimeDebugValue(message[key], message[key]);
      }
    }
    return compact;
  });
}

function summarizePlainObject(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value == null ? null : buildPreviewText(value, 96);
  }
  const keys = Object.keys(value);
  return {
    keyCount: keys.length,
    keys: keys.slice(0, 12),
  };
}

function summarizeRequestBody(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return summarizePlainObject(value);
  }
  const messageSummary = Array.isArray(value.messages)
    ? summarizeMessageArray(value.messages)
    : null;
  return {
    keyCount: Object.keys(value).length,
    keys: Object.keys(value).slice(0, 16),
    model: String(value.model || ""),
    stream: value.stream === true,
    maxTokens: Number(value.max_tokens || value.max_completion_tokens || 0) || 0,
    messages: messageSummary,
    messagesCompact: compactMessageDebugEntries(value.messages),
    promptPreview: buildPreviewText(
      value.prompt ||
        value.input ||
        value.user_input ||
        value.system_prompt ||
        "",
    ),
  };
}

function buildCompactLlmDebugSnapshot(snapshot = {}) {
  const compactMessages = compactMessageDebugEntries(
    Array.isArray(snapshot?.messages) && snapshot.messages.length > 0
      ? snapshot.messages
      : Array.isArray(snapshot?.requestBody?.messages)
        ? snapshot.requestBody.messages
        : snapshot?.transportMessages,
  );
  const compactTransportMessages = compactMessageDebugEntries(
    Array.isArray(snapshot?.transportMessages) && snapshot.transportMessages.length > 0
      ? snapshot.transportMessages
      : Array.isArray(snapshot?.requestBody?.messages)
        ? snapshot.requestBody.messages
        : [],
  );
  return {
    updatedAt: nowIso(),
    debugMode: "summary",
    redacted: true,
    startedAt: String(snapshot?.startedAt || snapshot?.streamStartedAt || ""),
    finishedAt: String(snapshot?.finishedAt || snapshot?.streamFinishedAt || ""),
    model: String(snapshot?.model || ""),
    route: String(snapshot?.route || snapshot?.effectiveRoute || ""),
    effectiveRoute: String(snapshot?.effectiveRoute || snapshot?.route || ""),
    llmConfigSourceLabel: String(snapshot?.llmConfigSourceLabel || ""),
    llmPresetName: String(snapshot?.llmPresetName || ""),
    llmProviderLabel: String(snapshot?.llmProviderLabel || ""),
    llmTransportLabel: String(snapshot?.llmTransportLabel || ""),
    filteredGeneration:
      snapshot?.filteredGeneration &&
      typeof snapshot.filteredGeneration === "object" &&
      !Array.isArray(snapshot.filteredGeneration)
        ? cloneRuntimeDebugValue(snapshot.filteredGeneration, {})
        : null,
    streamForceDisabled:
      typeof snapshot?.streamForceDisabled === "boolean"
        ? snapshot.streamForceDisabled
        : undefined,
    streamRequested:
      typeof snapshot?.streamRequested === "boolean"
        ? snapshot.streamRequested
        : undefined,
    streamActive:
      typeof snapshot?.streamActive === "boolean"
        ? snapshot.streamActive
        : undefined,
    streamCompleted:
      typeof snapshot?.streamCompleted === "boolean"
        ? snapshot.streamCompleted
        : undefined,
    streamFallback:
      typeof snapshot?.streamFallback === "boolean"
        ? snapshot.streamFallback
        : undefined,
    streamFallbackSucceeded:
      typeof snapshot?.streamFallbackSucceeded === "boolean"
        ? snapshot.streamFallbackSucceeded
        : undefined,
    streamFallbackReason:
      snapshot?.streamFallbackReason != null
        ? String(snapshot.streamFallbackReason || "")
        : undefined,
    streamFinishReason:
      snapshot?.streamFinishReason != null
        ? String(snapshot.streamFinishReason || "")
        : undefined,
    streamPreviewText:
      snapshot?.streamPreviewText != null ||
      snapshot?.streamTextPreview != null ||
      snapshot?.preview != null
        ? buildPreviewText(
            snapshot?.streamPreviewText ||
              snapshot?.streamTextPreview ||
              snapshot?.preview ||
              "",
            STREAM_DEBUG_PREVIEW_MAX_CHARS,
          )
        : undefined,
    promptExecution: cloneRuntimeDebugValue(snapshot?.promptExecution, null),
    requestCleaning: cloneRuntimeDebugValue(snapshot?.requestCleaning, null),
    responseCleaning: cloneRuntimeDebugValue(snapshot?.responseCleaning, null),
    jsonFailure: cloneRuntimeDebugValue(snapshot?.jsonFailure, null),
    messages: compactMessages,
    transportMessages: compactTransportMessages,
    requestBody: (() => {
      const summary = summarizeRequestBody(snapshot?.requestBody);
      return summary && typeof summary === "object"
        ? {
            ...summary,
            messages: compactTransportMessages,
          }
        : summary;
    })(),
    messagesSummary: summarizeMessageArray(
      Array.isArray(snapshot?.messages) && snapshot.messages.length > 0
        ? snapshot.messages
        : snapshot?.requestBody?.messages,
    ),
    transportMessagesSummary: summarizeMessageArray(
      Array.isArray(snapshot?.transportMessages) && snapshot.transportMessages.length > 0
        ? snapshot.transportMessages
        : snapshot?.requestBody?.messages,
    ),
    requestBodySummary: summarizeRequestBody(snapshot?.requestBody),
    responsePreview: buildPreviewText(
      snapshot?.cleanedText ||
        snapshot?.responseText ||
        snapshot?.preview ||
        snapshot?.content ||
        "",
    ),
    promptPreview: buildPreviewText(
      snapshot?.systemPrompt ||
        snapshot?.userPrompt ||
        snapshot?.promptText ||
        "",
    ),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function summarizeTaskTimelineEntry(taskType, snapshot = {}) {
  const taskKey = String(taskType || "unknown").trim() || "unknown";
  const status = snapshot?.jsonFailure
    ? "failed"
    : snapshot?.responseCleaning
      ? "completed"
      : snapshot?.streamCompleted
        ? "stream-completed"
      : "";
  if (!status) return null;

  const startedAt = String(snapshot?.startedAt || snapshot?.streamStartedAt || "").trim();
  const finishedAt = String(
    snapshot?.finishedAt ||
      snapshot?.streamFinishedAt ||
      snapshot?.updatedAt ||
      nowIso(),
  ).trim();
  const startedAtMs = Date.parse(startedAt);
  const finishedAtMs = Date.parse(finishedAt);
  const durationMs =
    Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs
      ? finishedAtMs - startedAtMs
      : 0;

  return {
    id: `${taskKey}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    taskType: taskKey,
    status,
    updatedAt: nowIso(),
    startedAt,
    finishedAt,
    durationMs,
    model: String(snapshot?.model || ""),
    route: String(snapshot?.route || snapshot?.effectiveRoute || ""),
    llmConfigSourceLabel: String(snapshot?.llmConfigSourceLabel || ""),
    llmPresetName: String(snapshot?.llmPresetName || ""),
    promptExecution: cloneRuntimeDebugValue(snapshot?.promptExecution, null),
    requestCleaning: cloneRuntimeDebugValue(snapshot?.requestCleaning, null),
    responseCleaning: cloneRuntimeDebugValue(snapshot?.responseCleaning, null),
    jsonFailure: cloneRuntimeDebugValue(snapshot?.jsonFailure, null),
    messagesSummary:
      cloneRuntimeDebugValue(snapshot?.messagesSummary, null) ||
      summarizeMessageArray(snapshot?.messages),
    transportMessagesSummary:
      cloneRuntimeDebugValue(snapshot?.transportMessagesSummary, null) ||
      summarizeMessageArray(snapshot?.transportMessages),
    requestBodySummary:
      cloneRuntimeDebugValue(snapshot?.requestBodySummary, null) ||
      summarizeRequestBody(snapshot?.requestBody),
    responsePreview: buildPreviewText(
      snapshot?.responsePreview ||
        snapshot?.cleanedText ||
        snapshot?.responseText ||
        "",
    ),
  };
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
      taskTimeline: [],
      updatedAt: "",
    };
  }
  return globalThis[stateKey];
}

function preserveStreamingDebugFields(previousSnapshot = {}, nextSnapshot = {}) {
  const merged = {
    ...cloneRuntimeDebugValue(previousSnapshot, {}),
    ...cloneRuntimeDebugValue(nextSnapshot, {}),
  };
  for (const key of [
    "streamRequested",
    "streamActive",
    "streamCompleted",
    "streamFallback",
    "streamFallbackReason",
    "streamFallbackSucceeded",
    "streamStartedAt",
    "streamFinishedAt",
    "streamChunkCount",
    "streamReceivedChars",
    "streamPreviewText",
    "streamFinishReason",
    "streamLastEventAt",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(nextSnapshot, key)) {
      merged[key] = previousSnapshot?.[key];
    }
  }
  return merged;
}

function recordTaskLlmRequest(taskType, snapshot = {}, options = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  const state = getRuntimeDebugState();
  const shouldMerge = options?.merge === true;
  const existingSnapshot = cloneRuntimeDebugValue(
    state.taskLlmRequests[normalizedTaskType],
    {},
  );
  const previousSnapshot = shouldMerge ? existingSnapshot : {};
  const sanitizedSnapshot = sanitizeLlmDebugSnapshot(snapshot);
  state.taskLlmRequests[normalizedTaskType] = {
    ...(shouldMerge
      ? previousSnapshot
      : preserveStreamingDebugFields(existingSnapshot, sanitizedSnapshot)),
    updatedAt: new Date().toISOString(),
    ...sanitizedSnapshot,
  };
  const timelineEntry = summarizeTaskTimelineEntry(
    normalizedTaskType,
    state.taskLlmRequests[normalizedTaskType],
  );
  if (timelineEntry) {
    state.taskTimeline = Array.isArray(state.taskTimeline)
      ? [...state.taskTimeline, timelineEntry].slice(-TASK_DEBUG_TIMELINE_LIMIT)
      : [timelineEntry];
  }
  state.updatedAt = new Date().toISOString();
}

function getLlmTestOverride(name) {
  const override = globalThis.__stBmeTestOverrides?.llm?.[name];
  return typeof override === "function" ? override : null;
}

function formatLlmConfigSourceLabel(source = "") {
  switch (String(source || "").trim()) {
    case "task-preset":
      return "任务专用模板";
    case "global-fallback-missing-task-preset":
      return "任务模板缺失，已回退当前 API";
    case "global-fallback-invalid-task-preset":
      return "任务模板不完整，已回退当前 API";
    case "global":
    default:
      return "跟随当前 API";
  }
}

function getMemoryLLMConfig(taskType = "") {
  const settings = extension_settings[MODULE_NAME] || {};
  const normalizedTaskType = String(taskType || "").trim();
  const activeProfile = normalizedTaskType
    ? getActiveTaskProfile(settings, normalizedTaskType)
    : null;
  const selectedPresetName =
    typeof activeProfile?.generation?.llm_preset === "string"
      ? activeProfile.generation.llm_preset
      : "";
  const selection = resolveLlmConfigSelection(settings, selectedPresetName);
  const resolvedProvider = resolveDedicatedLlmProviderConfig(
    selection.config?.llmApiUrl,
  );
  return {
    inputApiUrl: resolvedProvider.inputUrl || "",
    apiUrl: resolvedProvider.apiUrl || "",
    apiKey: String(selection.config?.llmApiKey || "").trim(),
    model: String(selection.config?.llmModel || "").trim(),
    timeoutMs: getConfiguredTimeoutMs(settings),
    llmProvider: resolvedProvider.providerId || "",
    llmProviderLabel: resolvedProvider.providerLabel || "",
    llmTransport: resolvedProvider.transportId || "",
    llmTransportLabel: resolvedProvider.transportLabel || "",
    llmRouteMode: resolvedProvider.routeMode || "",
    llmHostSource: resolvedProvider.hostSource || "",
    llmHostSourceConst: resolvedProvider.hostSourceConst || "",
    llmSupportsModelFetch: resolvedProvider.supportsModelFetch === true,
    llmStatusStrategies: Array.isArray(resolvedProvider.statusStrategies)
      ? [...resolvedProvider.statusStrategies]
      : [],
    llmChannel: resolvedProvider,
    llmConfigSource: selection.source || "global",
    llmConfigSourceLabel: formatLlmConfigSourceLabel(selection.source),
    llmPresetName: selection.presetName || "",
    requestedLlmPresetName: selection.requestedPresetName || "",
    llmPresetFallbackReason: selection.fallbackReason || "",
  };
}

function getConfiguredTimeoutMs(settings = {}) {
  return typeof resolveConfiguredTimeoutMs === "function"
    ? resolveConfiguredTimeoutMs(settings, LLM_REQUEST_TIMEOUT_MS)
    : (() => {
        const timeoutMs = Number(settings?.timeoutMs);
        return Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : LLM_REQUEST_TIMEOUT_MS;
      })();
}

function normalizeRegexDebugEntries(debugCollector = null) {
  if (!Array.isArray(debugCollector?.entries)) {
    return [];
  }
  return debugCollector.entries.map((entry) => ({
    kind: String(entry?.kind || "local-regex"),
    taskType: String(entry?.taskType || ""),
    stage: String(entry?.stage || ""),
    enabled: entry?.enabled !== false,
    executionMode: String(entry?.executionMode || ""),
    formatterAvailable: Boolean(entry?.formatterAvailable),
    hostFormatterSource: String(entry?.hostFormatterSource || ""),
    fallbackReason: String(entry?.fallbackReason || ""),
    skippedDisplayOnlyRuleCount: Number(
      entry?.skippedDisplayOnlyRuleCount || 0,
    ),
    appliedRules: Array.isArray(entry?.appliedRules)
      ? entry.appliedRules.map((rule) => ({
          id: String(rule?.id || ""),
          source: String(rule?.source || ""),
          error: String(rule?.error || ""),
        }))
      : [],
    sourceCount: {
      tavern: Number(entry?.sourceCount?.tavern || 0),
      local: Number(entry?.sourceCount?.local || 0),
    },
  }));
}

function applyTaskOutputRegexStages(taskType, text) {
  const normalizedTaskType = String(taskType || "").trim();
  const rawText = typeof text === "string" ? text : "";
  if (!normalizedTaskType || !rawText) {
    return {
      cleanedText: rawText,
      debug: {
        changed: false,
        applied: false,
        stages: [],
        rawLength: rawText.length,
        cleanedLength: rawText.length,
      },
    };
  }

  const settings = extension_settings[MODULE_NAME] || {};
  const regexDebug = { entries: [] };
  const afterRawStage = applyTaskRegex(
    settings,
    normalizedTaskType,
    "output.rawResponse",
    rawText,
    regexDebug,
    "assistant",
  );
  const cleanedText = applyTaskRegex(
    settings,
    normalizedTaskType,
    "output.beforeParse",
    afterRawStage,
    regexDebug,
    "assistant",
  );
  const normalizedEntries = normalizeRegexDebugEntries(regexDebug);
  const applied = normalizedEntries.some(
    (entry) => entry.appliedRules.length > 0,
  );

  return {
    cleanedText,
    debug: {
      changed: cleanedText !== rawText,
      applied,
      rawLength: rawText.length,
      cleanedLength: cleanedText.length,
      stages: normalizedEntries,
    },
  };
}

function applyTaskFinalInputRegex(taskType, messages = []) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const role = String(message.role || "").trim().toLowerCase();
      if (!["system", "user", "assistant"].includes(role)) {
        return null;
      }
      return {
        ...message,
        role,
        content: String(message.content || ""),
      };
    })
    .filter(Boolean);
  const normalizedTaskType = String(taskType || "").trim();

  if (!normalizedTaskType || normalizedMessages.length === 0) {
    const cleanedMessages = normalizedMessages.filter((message) =>
      String(message.content || "").trim(),
    );
    return {
      messages: cleanedMessages,
      debug: {
        stage: "input.finalPrompt",
        changed: cleanedMessages.length !== normalizedMessages.length,
        applied: false,
        rawMessageCount: normalizedMessages.length,
        cleanedMessageCount: cleanedMessages.length,
        droppedMessageCount: normalizedMessages.length - cleanedMessages.length,
        finalPromptLocalRuleCount: 0,
        stages: [],
      },
    };
  }

  const settings = extension_settings[MODULE_NAME] || {};
  const regexDebug = { entries: [] };
  let changed = false;
  let droppedMessageCount = 0;
  const cleanedMessages = normalizedMessages
    .map((message) => {
      const originalContent = String(message.content || "");
      const cleanedContent = applyTaskRegex(
        settings,
        normalizedTaskType,
        "input.finalPrompt",
        originalContent,
        regexDebug,
        message.role,
      );
      if (cleanedContent !== originalContent) {
        changed = true;
      }
      if (!String(cleanedContent || "").trim()) {
        droppedMessageCount += 1;
        return null;
      }
      return {
        ...message,
        content: cleanedContent,
      };
    })
    .filter(Boolean);
  const normalizedEntries = normalizeRegexDebugEntries(regexDebug);
  const applied = normalizedEntries.some(
    (entry) => entry.appliedRules.length > 0,
  );

  return {
    messages: cleanedMessages,
    debug: {
      stage: "input.finalPrompt",
      changed: changed || droppedMessageCount > 0,
      applied,
      rawMessageCount: normalizedMessages.length,
      cleanedMessageCount: cleanedMessages.length,
      droppedMessageCount,
      finalPromptLocalRuleCount: normalizedEntries.reduce(
        (sum, entry) => sum + Number(entry?.sourceCount?.local || 0),
        0,
      ),
      stages: normalizedEntries,
    },
  };
}

function attachRequestCleaningToPromptExecution(
  promptExecutionSummary,
  requestCleaning,
) {
  const base =
    promptExecutionSummary && typeof promptExecutionSummary === "object"
      ? cloneRuntimeDebugValue(promptExecutionSummary, {})
      : {};
  if (requestCleaning && typeof requestCleaning === "object") {
    base.requestCleaning = cloneRuntimeDebugValue(requestCleaning, null);
  }
  return base;
}

function buildEffectiveLlmRoute(
  hasDedicatedConfig,
  privateRequestSource,
  taskType = "",
  config = null,
) {
  const dedicated = Boolean(hasDedicatedConfig);
  return {
    taskType: String(taskType || "").trim(),
    requestSource: String(privateRequestSource || "").trim(),
    llm: dedicated ? "dedicated-memory-llm" : "sillytavern-current-model",
    transport: dedicated
      ? String(config?.llmTransport || "dedicated-openai-compatible")
      : "sillytavern-current-model",
    transportLabel: dedicated
      ? String(
          config?.llmTransportLabel || config?.llmProviderLabel || "专用记忆模型",
        )
      : "酒馆当前模型",
    provider: dedicated ? String(config?.llmProvider || "") : "",
    providerLabel: dedicated ? String(config?.llmProviderLabel || "") : "",
    routeMode: dedicated ? String(config?.llmRouteMode || "") : "",
    inputApiUrl: dedicated ? String(config?.inputApiUrl || "") : "",
    apiUrl: dedicated ? String(config?.apiUrl || "") : "",
  };
}

function buildPromptExecutionSummary(debugContext = null) {
  if (!debugContext || typeof debugContext !== "object") {
    return null;
  }

  return {
    promptAssembly:
      debugContext.promptAssembly && typeof debugContext.promptAssembly === "object"
        ? cloneRuntimeDebugValue(debugContext.promptAssembly, {})
        : null,
    promptBuild:
      debugContext.promptBuild && typeof debugContext.promptBuild === "object"
        ? cloneRuntimeDebugValue(debugContext.promptBuild, {})
        : null,
    effectiveDelivery:
      debugContext.effectiveDelivery &&
      typeof debugContext.effectiveDelivery === "object"
        ? cloneRuntimeDebugValue(debugContext.effectiveDelivery, {})
        : null,
    ejsRuntimeStatus: String(debugContext.ejsRuntimeStatus || ""),
    worldInfo:
      debugContext.worldInfo && typeof debugContext.worldInfo === "object"
        ? cloneRuntimeDebugValue(debugContext.worldInfo, {})
        : null,
    mvu:
      debugContext.mvu && typeof debugContext.mvu === "object"
        ? cloneRuntimeDebugValue(debugContext.mvu, {})
        : null,
    inputContext:
      debugContext.inputContext && typeof debugContext.inputContext === "object"
        ? cloneRuntimeDebugValue(debugContext.inputContext, {})
        : null,
    regexInput: normalizeRegexDebugEntries(debugContext.regexInput),
  };
}

function createStreamDebugState({
  requested = false,
  fallback = false,
  fallbackReason = "",
  fallbackSucceeded = false,
} = {}) {
  return {
    requested: Boolean(requested),
    active: false,
    completed: false,
    fallback: Boolean(fallback),
    fallbackReason: String(fallbackReason || ""),
    fallbackSucceeded: Boolean(fallbackSucceeded),
    startedAt: "",
    finishedAt: "",
    chunkCount: 0,
    receivedChars: 0,
    previewText: "",
    finishReason: "",
    lastEventAt: "",
    lastDebugUpdateAt: 0,
  };
}

function buildStreamDebugSnapshot(streamState = {}) {
  return {
    streamRequested: Boolean(streamState.requested),
    streamActive: Boolean(streamState.active),
    streamCompleted: Boolean(streamState.completed),
    streamFallback: Boolean(streamState.fallback),
    streamFallbackReason: String(streamState.fallbackReason || ""),
    streamFallbackSucceeded: Boolean(streamState.fallbackSucceeded),
    streamStartedAt: String(streamState.startedAt || ""),
    streamFinishedAt: String(streamState.finishedAt || ""),
    streamChunkCount: Number(streamState.chunkCount || 0),
    streamReceivedChars: Number(streamState.receivedChars || 0),
    streamPreviewText: String(streamState.previewText || ""),
    streamFinishReason: String(streamState.finishReason || ""),
    streamLastEventAt: String(streamState.lastEventAt || ""),
  };
}

function recordTaskLlmStreamState(
  taskKey,
  streamState,
  extraSnapshot = {},
  { force = false } = {},
) {
  if (!taskKey || !streamState) return;

  const now = Date.now();
  if (
    !force &&
    streamState.lastDebugUpdateAt &&
    now - streamState.lastDebugUpdateAt < STREAM_DEBUG_UPDATE_INTERVAL_MS
  ) {
    return;
  }

  streamState.lastDebugUpdateAt = now;
  recordTaskLlmRequest(
    taskKey,
    {
      ...buildStreamDebugSnapshot(streamState),
      ...extraSnapshot,
    },
    {
      merge: true,
    },
  );
}

function appendStreamPreview(existingPreview = "", deltaText = "") {
  const combined = `${String(existingPreview || "")}${String(deltaText || "")}`;
  if (combined.length <= STREAM_DEBUG_PREVIEW_MAX_CHARS) {
    return combined;
  }
  return combined.slice(-STREAM_DEBUG_PREVIEW_MAX_CHARS);
}

function extractTextLikeValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        extractTextLikeValue(item?.text ?? item?.content ?? item),
      )
      .join("");
  }
  if (typeof value === "object") {
    return extractTextLikeValue(value.text ?? value.content ?? "");
  }
  return "";
}

function extractStreamingChoice(payload = {}) {
  return payload?.choices?.[0] || {};
}

function extractStreamingContentDelta(payload = {}) {
  const choice = extractStreamingChoice(payload);
  return extractTextLikeValue(
    choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      payload?.content ??
      payload?.text ??
      "",
  );
}

function extractStreamingReasoningDelta(payload = {}) {
  const choice = extractStreamingChoice(payload);
  return extractTextLikeValue(
    choice?.delta?.reasoning_content ??
      choice?.delta?.reasoning ??
      choice?.message?.reasoning_content ??
      payload?.reasoning ??
      "",
  );
}

function extractStreamingFinishReason(payload = {}) {
  const choice = extractStreamingChoice(payload);
  return String(
    choice?.finish_reason ??
      payload?.finish_reason ??
      payload?.stop_reason ??
      "",
  );
}

function extractErrorMessageFromPayload(payload = {}) {
  if (typeof payload === "string") {
    return payload;
  }
  return String(
    payload?.error?.message ??
      payload?.message ??
      payload?.detail ??
      payload?.error ??
      "",
  ).trim();
}

function looksLikeJsonModeUnsupportedMessage(message = "") {
  return /(response_format|json[_-\s]?mode|json[_-\s]?object|json schema|structured output)/i.test(
    String(message || ""),
  );
}

function looksLikeStreamUnsupportedMessage(message = "") {
  return /(stream|streaming|sse|event[-\s]?stream|text\/event-stream)/i.test(
    String(message || ""),
  );
}

function createStreamHandlingError(
  message,
  code = "stream_error",
  options = {},
) {
  const error = new Error(String(message || "流式请求失败"));
  error.name = "StreamHandlingError";
  error.code = code;
  error.fallbackable = options?.fallbackable !== false;
  error.status = Number.isFinite(Number(options?.status))
    ? Number(options.status)
    : 0;
  return error;
}

function isStreamHandlingError(error) {
  return error?.name === "StreamHandlingError";
}

function shouldFallbackToNonStream(error) {
  return isStreamHandlingError(error) && error?.fallbackable !== false;
}

function buildResponseErrorMessage(response, responseText = "") {
  const rawText = String(responseText || "").trim();
  if (!rawText) {
    return String(response?.statusText || "");
  }

  try {
    const parsed = JSON.parse(rawText);
    return extractErrorMessageFromPayload(parsed) || rawText;
  } catch {
    return rawText;
  }
}

function normalizeOpenAICompatibleBaseUrl(value) {
  const resolved = resolveDedicatedLlmProviderConfig(value);
  return resolved.apiUrl || String(value || "").trim().replace(/\/+$/, "");
}

function hasDedicatedLLMConfig(config = getMemoryLLMConfig()) {
  return Boolean(config.apiUrl && config.model);
}

function normalizeModelList(items = []) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const models = [];

  for (const item of items) {
    let id = "";
    let label = "";

    if (typeof item === "string") {
      id = item.trim();
      label = id;
    } else if (item && typeof item === "object") {
      id = String(
        item.id || item.name || item.label || item.value || item.slug || "",
      ).trim();
      label = String(
        item.label || item.name || item.id || item.value || item.slug || "",
      ).trim();
    }

    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label || id });
  }

  return models;
}

function extractModelListPayload(payload = {}) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.models)) {
    return payload.models;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.models)) {
      return payload.data.models;
    }
    if (Array.isArray(payload.data.data)) {
      return payload.data.data;
    }
  }

  return [];
}

function buildDedicatedAuthHeaderString(apiKey = "") {
  const normalized = String(apiKey || "").trim();
  return normalized ? `Authorization: Bearer ${normalized}` : "";
}

function resolveChatCompletionSourceValue(sourceConst = "", fallback = "") {
  const normalizedConst = String(sourceConst || "").trim();
  if (
    normalizedConst &&
    chat_completion_sources &&
    typeof chat_completion_sources === "object" &&
    chat_completion_sources[normalizedConst]
  ) {
    return String(chat_completion_sources[normalizedConst]).trim();
  }
  return String(fallback || "").trim();
}

function buildDedicatedCustomStatusVariant(config = getMemoryLLMConfig()) {
  return {
    mode: "custom",
    body: {
      chat_completion_source: resolveChatCompletionSourceValue("CUSTOM", "custom"),
      custom_url: config.apiUrl,
      custom_include_headers: buildDedicatedAuthHeaderString(config.apiKey),
      reverse_proxy: config.apiUrl,
      proxy_password: "",
    },
  };
}

function buildDedicatedReverseProxyStatusVariant(
  mode,
  sourceConst,
  fallbackSource,
  config = getMemoryLLMConfig(),
) {
  return {
    mode,
    body: {
      chat_completion_source: resolveChatCompletionSourceValue(
        sourceConst,
        fallbackSource,
      ),
      reverse_proxy: config.apiUrl,
      proxy_password: config.apiKey || "",
    },
  };
}

function buildDedicatedStatusRequestVariants(config = getMemoryLLMConfig()) {
  const strategies = Array.isArray(config.llmStatusStrategies)
    ? config.llmStatusStrategies
    : ["custom", "openai-reverse-proxy"];
  const variants = [];
  const seenModes = new Set();

  for (const strategy of strategies) {
    let variant = null;
    if (strategy === "custom") {
      variant = buildDedicatedCustomStatusVariant(config);
    } else if (strategy === "openai-reverse-proxy") {
      variant = buildDedicatedReverseProxyStatusVariant(
        "openai-reverse-proxy",
        "OPENAI",
        "openai",
        config,
      );
    } else if (strategy === "makersuite-reverse-proxy") {
      variant = buildDedicatedReverseProxyStatusVariant(
        "makersuite-reverse-proxy",
        "MAKERSUITE",
        "makersuite",
        config,
      );
    }

    if (!variant?.mode || seenModes.has(variant.mode)) {
      continue;
    }

    seenModes.add(variant.mode);
    variants.push(variant);
  }

  return variants;
}

async function requestDedicatedStatusModels(
  variant,
  { timeoutMs = LLM_REQUEST_TIMEOUT_MS } = {},
) {
  const response = await fetchWithTimeout(
    "/api/backends/chat-completions/status",
    {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify(variant.body),
    },
    timeoutMs,
  );

  const rawText = await response.text().catch(() => "");
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (!response.ok || payload?.error) {
    throw new Error(
      extractErrorMessageFromPayload(payload) ||
        rawText ||
        response.statusText ||
        `HTTP ${response.status}`,
    );
  }

  return {
    payload,
    models: normalizeModelList(extractModelListPayload(payload)),
  };
}

function extractContentFromResponsePayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload
      .map((item) => item?.text || item?.content || "")
      .join("")
      .trim();
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => item?.text || item?.content || "")
      .join("")
      .trim();
  }

  const textContent =
    payload?.choices?.[0]?.text ??
    payload?.text ??
    payload?.message?.content ??
    payload?.content;

  if (typeof textContent === "string") {
    return textContent;
  }

  if (Array.isArray(textContent)) {
    return textContent
      .map((item) => item?.text || item?.content || "")
      .join("")
      .trim();
  }

  return "";
}

function normalizeLLMResponsePayload(payload) {
  if (typeof payload === "string") {
    return {
      content: payload.trim(),
      finishReason: "",
      reasoningContent: "",
      raw: payload,
    };
  }

  const choice = payload?.choices?.[0] || {};
  const message = choice?.message || {};
  return {
    content: extractContentFromResponsePayload(payload).trim(),
    finishReason: String(choice?.finish_reason || ""),
    reasoningContent:
      typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : "",
    raw: payload,
  };
}

function createGenericJsonSchema() {
  return {
    name: "st_bme_json_response",
    description: "A well-formed JSON object for programmatic parsing.",
    strict: false,
    value: {
      type: "object",
      additionalProperties: true,
    },
  };
}

function buildYamlObject(value, indent = 0) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          return `${pad}-\n${buildYamlObject(item, indent + 2)}`;
        }
        return `${pad}- ${JSON.stringify(item)}`;
      })
      .join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        if (item && typeof item === "object") {
          return `${pad}${key}:\n${buildYamlObject(item, indent + 2)}`;
        }
        return `${pad}${key}: ${JSON.stringify(item)}`;
      })
      .join("\n");
  }

  return `${pad}${JSON.stringify(value)}`;
}

function looksLikeTruncatedJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  const openBraces = (trimmed.match(/\{/g) || []).length;
  const closeBraces = (trimmed.match(/\}/g) || []).length;
  const openBrackets = (trimmed.match(/\[/g) || []).length;
  const closeBrackets = (trimmed.match(/\]/g) || []).length;

  if (openBraces > closeBraces || openBrackets > closeBrackets) {
    return true;
  }

  if (/```(?:json)?/i.test(trimmed) && !/```[\s]*$/i.test(trimmed)) {
    return true;
  }

  return false;
}

function cloneLlmDebugMessageMetadata(message = {}) {
  const metadata = {};

  for (const key of [
    "source",
    "sourceKey",
    "blockId",
    "blockName",
    "blockType",
    "injectionMode",
    "contentOrigin",
    "regexSourceType",
    "speaker",
    "name",
  ]) {
    const value = String(message?.[key] || "").trim();
    if (value) {
      metadata[key] = value;
    }
  }

  if (message?.derivedFromWorldInfo === true) {
    metadata.derivedFromWorldInfo = true;
  }
  if (message?.sanitizationEligible === true) {
    metadata.sanitizationEligible = true;
  }
  if (Number.isFinite(Number(message?.depth))) {
    metadata.depth = Number(message.depth);
  }
  if (Number.isFinite(Number(message?.order))) {
    metadata.order = Number(message.order);
  }

  return metadata;
}

function normalizeLlmDebugMessage(message = {}) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim().toLowerCase();
  const content = String(message.content || "").trim();
  if (!content || !["system", "user", "assistant"].includes(role)) {
    return null;
  }
  return {
    role,
    content,
    ...cloneLlmDebugMessageMetadata(message),
  };
}

function buildTransportMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const role = String(message.role || "").trim().toLowerCase();
      const content = String(message.content || "").trim();
      if (!content || !["system", "user", "assistant"].includes(role)) {
        return null;
      }
      return {
        role,
        content,
      };
    })
    .filter(Boolean);
}

function buildJsonAttemptMessages(
  systemPrompt,
  userPrompt,
  attempt,
  reason = "",
  additionalMessages = [],
  promptMessages = [],
) {
  const systemParts = [
    "输出要求补充：只输出一个紧凑的 JSON 对象。",
    "禁止 markdown 代码块、禁止解释、禁止前后缀、禁止省略号。",
    "如果需要重新生成，请直接从头输出完整 JSON，不要续写上一次内容。",
  ];

  const userParts = [];
  if (String(userPrompt || "").trim()) {
    userParts.push(String(userPrompt || "").trim());
  }
  if (attempt > 0) {
    userParts.push(
      reason ? `上一次输出失败原因：${reason}` : "上一次输出未能被程序解析。",
    );
    userParts.push(
      "请重新输出一个完整、紧凑、可直接 JSON.parse 的 JSON 对象。",
    );
  } else {
    userParts.push("请直接输出紧凑 JSON 对象，不要包含任何额外文本。");
  }

  const normalizedPromptMessages = Array.isArray(promptMessages)
    ? promptMessages
        .map((message) => normalizeLlmDebugMessage(message))
        .filter(Boolean)
    : [];

  const systemSupplement = [systemPrompt, ...systemParts]
    .filter((part) => String(part || "").trim())
    .join("\n\n")
    .trim();
  const userSupplement = userParts.join("\n\n").trim();

  if (normalizedPromptMessages.length > 0) {
    const messages = normalizedPromptMessages.map((message) => ({ ...message }));
    const firstSystemIndex = messages.findIndex(
      (message) => message.role === "system",
    );

    if (systemSupplement) {
      if (firstSystemIndex >= 0) {
        messages[firstSystemIndex] = {
          ...messages[firstSystemIndex],
          content: [
            messages[firstSystemIndex].content,
            systemSupplement,
          ]
            .filter((part) => String(part || "").trim())
            .join("\n\n"),
        };
      } else {
        messages.unshift({ role: "system", content: systemSupplement });
      }
    }

    if (userSupplement) {
      const hasFallbackUserPrompt = Boolean(String(userPrompt || "").trim());
      const lastUserIndex = [...messages]
        .reverse()
        .findIndex((message) => message.role === "user");
      const resolvedLastUserIndex =
        lastUserIndex >= 0 ? messages.length - 1 - lastUserIndex : -1;

      if (resolvedLastUserIndex >= 0 && !hasFallbackUserPrompt) {
        messages[resolvedLastUserIndex] = {
          ...messages[resolvedLastUserIndex],
          content: [
            messages[resolvedLastUserIndex].content,
            userSupplement,
          ]
            .filter((part) => String(part || "").trim())
            .join("\n\n"),
        };
      } else {
        messages.push({ role: "user", content: userSupplement });
      }
    }

    return messages;
  }

  const messages = [];
  const normalizedSystemPrompt = [systemPrompt, ...systemParts]
    .filter((part) => String(part || "").trim())
    .join("\n\n")
    .trim();
  if (normalizedSystemPrompt) {
    messages.push({ role: "system", content: normalizedSystemPrompt });
  }

  for (const message of additionalMessages || []) {
    const normalizedMessage = normalizeLlmDebugMessage(message);
    if (!normalizedMessage) continue;
    messages.push(normalizedMessage);
  }

  messages.push({ role: "user", content: userParts.join("\n\n") });
  return messages;
}

function resolvePrivateRequestSource(
  taskType = "",
  requestSource = "",
  { allowAnonymous = false } = {},
) {
  const normalizedTaskType = String(taskType || "").trim();
  if (normalizedTaskType) {
    return `task:${normalizedTaskType}`;
  }

  const normalizedRequestSource = String(requestSource || "").trim();
  if (normalizedRequestSource) {
    return normalizedRequestSource;
  }

  if (allowAnonymous) {
    return "adhoc";
  }

  throw new Error(
    "ST-BME private LLM requests require taskType or requestSource",
  );
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = LLM_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `LLM 请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          "AbortError",
        ),
      ),
    timeoutMs,
  );
  const signal = options.signal
    ? createCombinedAbortSignal(options.signal, controller.signal)
    : controller.signal;

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createCombinedAbortSignal(...signals) {
  const validSignals = signals.filter(Boolean);
  if (validSignals.length <= 1) {
    return validSignals[0] || undefined;
  }

  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.any === "function"
  ) {
    return AbortSignal.any(validSignals);
  }

  const controller = new AbortController();
  for (const signal of validSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

// 自动检测：如果 API 不支持 response_format，记住并跳过
let _jsonModeSupported = true;

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function parseDedicatedStreamingResponse(
  response,
  { taskKey = "", streamState = null, onStreamProgress = null } = {},
) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    throw createStreamHandlingError(
      "专用 LLM 返回的响应体不可流式读取",
      "missing_stream_body",
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let finishReason = "";
  let sawStreamEvent = false;

  streamState.active = true;
  streamState.completed = false;
  streamState.startedAt = streamState.startedAt || nowIso();
  streamState.finishedAt = "";
  recordTaskLlmStreamState(taskKey, streamState, {}, { force: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      while (true) {
        const boundaryIndex = buffer.indexOf("\n\n");
        if (boundaryIndex < 0) {
          break;
        }

        const eventBlock = buffer.slice(0, boundaryIndex).trim();
        buffer = buffer.slice(boundaryIndex + 2);
        if (!eventBlock) {
          continue;
        }

        const dataLines = eventBlock
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) {
          continue;
        }

        const rawData = dataLines.join("\n").trim();
        if (!rawData) {
          continue;
        }
        if (rawData === "[DONE]") {
          sawStreamEvent = true;
          streamState.lastEventAt = nowIso();
          break;
        }

        let parsed;
        try {
          parsed = JSON.parse(rawData);
        } catch (error) {
          throw createStreamHandlingError(
            "专用 LLM 返回了无法解析的 SSE 数据块",
            "invalid_sse_chunk",
            {
              fallbackable: true,
            },
          );
        }

        const payloadErrorMessage = extractErrorMessageFromPayload(parsed);
        if (payloadErrorMessage) {
          throw createStreamHandlingError(
            payloadErrorMessage,
            "stream_payload_error",
            {
              fallbackable:
                looksLikeStreamUnsupportedMessage(payloadErrorMessage),
            },
          );
        }

        sawStreamEvent = true;
        streamState.chunkCount += 1;
        streamState.lastEventAt = nowIso();

        const deltaText = extractStreamingContentDelta(parsed);
        const reasoningDelta = extractStreamingReasoningDelta(parsed);
        const nextFinishReason = extractStreamingFinishReason(parsed);

        if (deltaText) {
          content += deltaText;
          streamState.receivedChars += deltaText.length;
          streamState.previewText = appendStreamPreview(
            streamState.previewText,
            deltaText,
          );
          if (typeof onStreamProgress === "function") {
            try {
              onStreamProgress({
                previewText: streamState.previewText,
                chunkCount: streamState.chunkCount,
                receivedChars: streamState.receivedChars,
              });
            } catch {}
          }
        }

        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
        }

        if (nextFinishReason) {
          finishReason = nextFinishReason;
          streamState.finishReason = nextFinishReason;
        }

        recordTaskLlmStreamState(taskKey, streamState, {});
      }
    }

    buffer += decoder.decode();
    if (!sawStreamEvent) {
      throw createStreamHandlingError(
        "专用 LLM 未返回可识别的 SSE 事件流",
        "invalid_sse_stream",
      );
    }

    streamState.active = false;
    streamState.completed = true;
    streamState.finishedAt = nowIso();
    if (finishReason) {
      streamState.finishReason = finishReason;
    }
    recordTaskLlmStreamState(taskKey, streamState, {}, { force: true });

    return {
      content: String(content || "").trim(),
      finishReason: String(finishReason || ""),
      reasoningContent: String(reasoningContent || ""),
      raw: {
        mode: "stream",
        chunkCount: streamState.chunkCount,
      },
    };
  } catch (error) {
    streamState.active = false;
    streamState.completed = false;
    streamState.finishedAt = nowIso();
    if (isAbortError(error)) {
      streamState.finishReason = "aborted";
    }
    recordTaskLlmStreamState(taskKey, streamState, {}, { force: true });
    throw error;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // ignore
    }
  }
}

async function executeDedicatedRequest(
  body,
  {
    signal,
    timeoutMs = LLM_REQUEST_TIMEOUT_MS,
    jsonMode = false,
    taskKey = "",
    streamState = null,
    onStreamProgress = null,
  } = {},
) {
  const requestBody = cloneRuntimeDebugValue(body, {}) || {};

  while (true) {
    recordTaskLlmRequest(
      taskKey,
      {
        requestBody: requestBody,
      },
      {
        merge: true,
      },
    );

    const response = await fetchWithTimeout(
      "/api/backends/chat-completions/generate",
      {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
        signal,
      },
      timeoutMs,
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const message = buildResponseErrorMessage(response, responseText);
      if (
        jsonMode &&
        _jsonModeSupported &&
        response.status === 400 &&
        looksLikeJsonModeUnsupportedMessage(message)
      ) {
        console.warn("[ST-BME] API 不支持 json mode，降级为普通 JSON 提示模式");
        _jsonModeSupported = false;
        delete requestBody.custom_include_body;
        continue;
      }

      if (requestBody.stream === true && looksLikeStreamUnsupportedMessage(message)) {
        throw createStreamHandlingError(
          message || `Memory LLM proxy error ${response.status}`,
          "stream_http_error",
          {
            status: response.status,
          },
        );
      }

      throw new Error(
        `Memory LLM proxy error ${response.status}: ${message || response.statusText}`,
      );
    }

    if (requestBody.stream === true) {
      return await parseDedicatedStreamingResponse(response, {
        taskKey,
        streamState,
        onStreamProgress,
      });
    }

    return await _parseResponse(response);
  }
}

function shouldForceDedicatedNonStream(config = getMemoryLLMConfig()) {
  return (
    String(config.llmRouteMode || "").trim() === "reverse-proxy" &&
    ["claude", "makersuite"].includes(
      String(config.llmHostSource || "").trim().toLowerCase(),
    )
  );
}

function buildDedicatedRequestBody(
  config,
  transportMessages,
  filteredGeneration,
  resolvedCompletionTokens,
  { jsonMode = false } = {},
) {
  const routeMode = String(config?.llmRouteMode || "custom").trim() || "custom";
  const body = {
    model: config.model,
    messages: transportMessages,
    temperature: filteredGeneration.temperature ?? 1,
    max_tokens: resolvedCompletionTokens,
    stream: filteredGeneration.stream ?? false,
    frequency_penalty: filteredGeneration.frequency_penalty ?? 0,
    presence_penalty: filteredGeneration.presence_penalty ?? 0,
    top_p: filteredGeneration.top_p ?? 1,
  };

  if (routeMode === "reverse-proxy") {
    body.chat_completion_source = resolveChatCompletionSourceValue(
      config.llmHostSourceConst,
      config.llmHostSource || "custom",
    );
    body.reverse_proxy = config.apiUrl;
    body.proxy_password = config.apiKey || "";
    if (jsonMode) {
      body.json_schema = createGenericJsonSchema();
    }
  } else {
    body.chat_completion_source = resolveChatCompletionSourceValue("CUSTOM", "custom");
    body.custom_url = config.apiUrl;
    body.custom_include_headers = config.apiKey
      ? buildYamlObject({
          Authorization: `Bearer ${config.apiKey}`,
        })
      : "";
    if (jsonMode && _jsonModeSupported) {
      body.custom_include_body = buildYamlObject({
        response_format: {
          type: "json_object",
        },
      });
    }
  }

  return body;
}

async function callDedicatedOpenAICompatible(
  messages,
  {
    signal,
    jsonMode = false,
    maxCompletionTokens = null,
    taskType = "",
    requestSource = "",
    onStreamProgress = null,
  } = {},
) {
  const privateRequestSource = resolvePrivateRequestSource(
    taskType,
    requestSource,
  );
  const transportMessages = buildTransportMessages(messages);
  const config = getMemoryLLMConfig(taskType);
  const settings = extension_settings[MODULE_NAME] || {};
  const hasDedicatedConfig = hasDedicatedLLMConfig(config);
  if (taskType && config.llmPresetFallbackReason) {
    debugWarn(
      `[ST-BME] 任务 ${taskType} 指定的 API 模板不可用，已回退当前 API: ` +
        `${config.requestedLlmPresetName || "(empty)"} / ${config.llmPresetFallbackReason}`,
    );
  }
  const generationResolved = taskType
    ? resolveTaskGenerationOptions(settings, taskType, {
        max_completion_tokens: Number.isFinite(maxCompletionTokens)
          ? maxCompletionTokens
          : jsonMode
            ? DEFAULT_JSON_COMPLETION_TOKENS
            : DEFAULT_TEXT_COMPLETION_TOKENS,
      }, {
        mode: hasDedicatedConfig
          ? "dedicated-openai-compatible"
          : "sillytavern-current-model",
      })
    : {
        filtered: {},
        removed: [],
      };
  const taskKey = taskType || privateRequestSource;
  const initialFilteredGeneration = generationResolved.filtered || {};
  const filteredGeneration = {
    ...initialFilteredGeneration,
  };
  const forceNonStream = hasDedicatedConfig && shouldForceDedicatedNonStream(config);
  if (forceNonStream && filteredGeneration.stream === true) {
    filteredGeneration.stream = false;
  }
  const streamRequested =
    hasDedicatedConfig && filteredGeneration.stream === true;
  const streamState = createStreamDebugState({
    requested: streamRequested,
  });
  recordTaskLlmRequest(taskType || privateRequestSource, {
    startedAt: nowIso(),
    requestSource: privateRequestSource,
    taskType: String(taskType || "").trim(),
    jsonMode,
    dedicatedConfig: hasDedicatedConfig,
    route: hasDedicatedConfig
      ? config.llmTransport || "dedicated-openai-compatible"
      : "sillytavern-current-model",
    routeLabel: hasDedicatedConfig ? config.llmTransportLabel || "" : "酒馆当前模型",
    model: hasDedicatedConfig ? config.model : "sillytavern-current-model",
    inputApiUrl: hasDedicatedConfig ? config.inputApiUrl || "" : "",
    apiUrl: hasDedicatedConfig ? config.apiUrl : "",
    llmProvider: config.llmProvider || "",
    llmProviderLabel: config.llmProviderLabel || "",
    llmTransport: config.llmTransport || "",
    llmTransportLabel: config.llmTransportLabel || "",
    llmRouteMode: config.llmRouteMode || "",
    llmConfigSource: config.llmConfigSource || "global",
    llmConfigSourceLabel: config.llmConfigSourceLabel || "",
    llmPresetName: config.llmPresetName || "",
    requestedLlmPresetName: config.requestedLlmPresetName || "",
    llmPresetFallbackReason: config.llmPresetFallbackReason || "",
    messages,
    transportMessages,
    generation: generationResolved.generation || {},
    filteredGeneration,
    removedGeneration: generationResolved.removed || [],
    capabilityMode: generationResolved.capabilityMode || "",
    streamForceDisabled: forceNonStream,
    effectiveRoute: buildEffectiveLlmRoute(
      hasDedicatedConfig,
      privateRequestSource,
      taskType,
      config,
    ),
    maxCompletionTokens,
    ...buildStreamDebugSnapshot(streamState),
  });
  if (!hasDedicatedConfig) {
    const payload = await sendOpenAIRequest(
      "quiet",
      transportMessages,
      signal,
      jsonMode ? { jsonSchema: createGenericJsonSchema() } : {},
    );
    const normalized = normalizeLLMResponsePayload(payload);
    if (
      typeof normalized.content === "string" &&
      normalized.content.trim().length > 0
    ) {
      return normalized;
    }
    throw new Error(
      `${privateRequestSource}: SillyTavern current model returned an unexpected response format`,
    );
  }

  const completionTokens = Number.isFinite(maxCompletionTokens)
    ? maxCompletionTokens
    : jsonMode
      ? DEFAULT_JSON_COMPLETION_TOKENS
      : DEFAULT_TEXT_COMPLETION_TOKENS;
  const resolvedCompletionTokens = Number.isFinite(
    filteredGeneration.max_completion_tokens,
  )
    ? filteredGeneration.max_completion_tokens
    : completionTokens;

  const body = buildDedicatedRequestBody(
    config,
    transportMessages,
    filteredGeneration,
    resolvedCompletionTokens,
    { jsonMode },
  );

  const optionalGenerationFields = [
    "top_p",
    "top_k",
    "top_a",
    "min_p",
    "seed",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "squash_system_messages",
    "reasoning_effort",
    "request_thoughts",
    "enable_function_calling",
    "enable_web_search",
    "wrap_user_messages_in_quotes",
    "reply_count",
    "max_context_tokens",
    "character_name_prefix",
  ];

  for (const field of optionalGenerationFields) {
    if (!Object.prototype.hasOwnProperty.call(filteredGeneration, field)) continue;
    body[field] = filteredGeneration[field];
  }

  if (Object.prototype.hasOwnProperty.call(filteredGeneration, "request_thoughts")) {
    body.include_reasoning = Boolean(filteredGeneration.request_thoughts);
  }

  recordTaskLlmRequest(taskKey, {
    requestSource: privateRequestSource,
    taskType: String(taskType || "").trim(),
    jsonMode,
    dedicatedConfig: true,
    route: config.llmTransport || "dedicated-openai-compatible",
    routeLabel: config.llmTransportLabel || "",
    model: config.model,
    inputApiUrl: config.inputApiUrl || "",
    apiUrl: config.apiUrl,
    llmProvider: config.llmProvider || "",
    llmProviderLabel: config.llmProviderLabel || "",
    llmTransport: config.llmTransport || "",
    llmTransportLabel: config.llmTransportLabel || "",
    llmRouteMode: config.llmRouteMode || "",
    llmConfigSource: config.llmConfigSource || "global",
    llmConfigSourceLabel: config.llmConfigSourceLabel || "",
    llmPresetName: config.llmPresetName || "",
    requestedLlmPresetName: config.requestedLlmPresetName || "",
    llmPresetFallbackReason: config.llmPresetFallbackReason || "",
    messages,
    transportMessages,
    generation: generationResolved.generation || {},
    filteredGeneration,
    removedGeneration: generationResolved.removed || [],
    capabilityMode: generationResolved.capabilityMode || "",
    resolvedCompletionTokens,
    streamForceDisabled: forceNonStream,
    effectiveRoute: buildEffectiveLlmRoute(
      true,
      privateRequestSource,
      taskType,
      config,
    ),
    requestBody: body,
    ...buildStreamDebugSnapshot(streamState),
  });

  try {
    return await executeDedicatedRequest(body, {
      signal,
      timeoutMs: config.timeoutMs,
      jsonMode,
      taskKey,
      streamState,
      onStreamProgress,
    });
  } catch (error) {
    if (
      !streamRequested ||
      !shouldFallbackToNonStream(error) ||
      isAbortError(error)
    ) {
      throw error;
    }

    streamState.active = false;
    streamState.completed = false;
    streamState.fallback = true;
    streamState.fallbackReason = error?.message || String(error);
    streamState.finishedAt = nowIso();
    recordTaskLlmStreamState(taskKey, streamState, {}, { force: true });

    console.warn(
      `[ST-BME] 专用 LLM 流式不可用，已自动降级为非流式: ${streamState.fallbackReason}`,
    );

    const fallbackBody = {
      ...body,
      stream: false,
    };

    const fallbackResponse = await executeDedicatedRequest(fallbackBody, {
      signal,
      timeoutMs: config.timeoutMs,
      jsonMode,
      taskKey,
      streamState,
    });

    streamState.fallbackSucceeded = true;
    recordTaskLlmStreamState(taskKey, streamState, {}, { force: true });
    return fallbackResponse;
  }
}

async function _parseResponse(response) {
  const responseText = await response.text().catch(() => "");
  let data;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { error: { message: responseText || response.statusText } };
  }

  if (!response.ok) {
    const message = data?.error?.message || response.statusText;
    throw new Error(`Memory LLM proxy error ${response.status}: ${message}`);
  }

  if (data?.error?.message) {
    throw new Error(`Memory LLM proxy error: ${data.error.message}`);
  }
  const normalized = normalizeLLMResponsePayload(data);
  if (typeof normalized.content === "string" && normalized.content.length > 0) {
    return normalized;
  }

  throw new Error("Memory LLM API returned an unexpected response format");
}

/**
 * 调用 LLM 并期望返回结构化 JSON
 *
 * @param {object} params
 * @param {string} params.systemPrompt - 系统提示词
 * @param {string} params.userPrompt - 用户提示词
 * @param {number} [params.maxRetries=2] - JSON 解析失败时的重试次数
 * @param {string} [params.model] - 指定模型（留空使用当前配置）
 * @returns {Promise<object|null>} 解析后的 JSON 对象，或 null
 */
export async function callLLMForJSON({
  systemPrompt,
  userPrompt,
  maxRetries = 2,
  signal,
  taskType = "",
  requestSource = "",
  additionalMessages = [],
  promptMessages = [],
  debugContext = null,
  onStreamProgress = null,
  maxCompletionTokens = null,
  returnFailureDetails = false,
} = {}) {
  const override = getLlmTestOverride("callLLMForJSON");
  if (override) {
    return await override({
      systemPrompt,
      userPrompt,
      maxRetries,
      signal,
      taskType,
      requestSource,
      additionalMessages,
      promptMessages,
      debugContext,
      onStreamProgress,
      maxCompletionTokens,
      returnFailureDetails,
    });
  }

  const privateRequestSource = resolvePrivateRequestSource(
    taskType,
    requestSource,
  );
  let lastFailureReason = "";
  let lastFailureType = "";
  const promptExecutionSummary = buildPromptExecutionSummary(debugContext);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const assembledMessages = buildJsonAttemptMessages(
        systemPrompt,
        userPrompt,
        attempt,
        lastFailureReason,
        additionalMessages,
        promptMessages,
      );
      {
        const asmUser = assembledMessages.filter((m) => m?.role === "user");
        debugLog(
          `[ST-BME][prompt-diag] buildJsonAttemptMessages: ` +
            `total=${assembledMessages.length}, user=${asmUser.length}, ` +
            `roles=[${assembledMessages.map((m) => m?.role).join(",")}]`,
        );
        for (const m of asmUser) {
          debugLog(
            `[ST-BME][prompt-diag]   assembled user: len=${String(m.content || "").length}, ` +
              `preview="${String(m.content || "").slice(0, 80)}..."`,
          );
        }
      }
      const requestCleaning = applyTaskFinalInputRegex(
        taskType,
        assembledMessages,
      );
      {
        const rcMsgs = Array.isArray(requestCleaning.messages) ? requestCleaning.messages : [];
        const rcUser = rcMsgs.filter((m) => m?.role === "user");
        const dbg = requestCleaning.debug || {};
        debugLog(
          `[ST-BME][prompt-diag] applyTaskFinalInputRegex: ` +
            `total=${rcMsgs.length}, user=${rcUser.length}, ` +
            `changed=${dbg.changed}, applied=${dbg.applied}, ` +
            `roles=[${rcMsgs.map((m) => m?.role).join(",")}]`,
        );
        if (rcUser.length === 0 && assembledMessages.filter((m) => m?.role === "user").length > 0) {
          debugWarn(
            `[ST-BME][prompt-diag] *** USER MESSAGES LOST during applyTaskFinalInputRegex! ***`,
          );
          for (const rule of dbg.appliedRules || []) {
            debugWarn(`[ST-BME][prompt-diag]   applied rule: ${JSON.stringify(rule)}`);
          }
        }
      }
      const promptExecutionSnapshot = attachRequestCleaningToPromptExecution(
        promptExecutionSummary,
        requestCleaning.debug,
      );
      recordTaskLlmRequest(
        taskType || privateRequestSource,
        {
          requestCleaning: requestCleaning.debug,
          promptExecution: promptExecutionSnapshot,
        },
        {
          merge: true,
        },
      );
      const response = await callDedicatedOpenAICompatible(requestCleaning.messages, {
        signal,
        jsonMode: true,
        taskType,
        requestSource: privateRequestSource,
        onStreamProgress,
        maxCompletionTokens: Number.isFinite(maxCompletionTokens)
          ? maxCompletionTokens
          : DEFAULT_JSON_COMPLETION_TOKENS,
      });
      const responseText = response?.content || "";
      const outputCleanup = applyTaskOutputRegexStages(taskType, responseText);
      recordTaskLlmRequest(
        taskType || privateRequestSource,
        {
          requestCleaning: requestCleaning.debug,
          responseCleaning: outputCleanup.debug,
          promptExecution: promptExecutionSnapshot,
        },
        {
          merge: true,
        },
      );

      if (!responseText || typeof responseText !== "string") {
        console.warn(`[ST-BME] LLM 返回空响应 (尝试 ${attempt + 1})`);
        lastFailureReason = "返回空响应";
        lastFailureType = "empty-response";
        continue;
      }

      // 尝试解析 JSON
      const parsed = extractJSON(outputCleanup.cleanedText);
      if (parsed !== null) {
        return returnFailureDetails
          ? {
              ok: true,
              data: parsed,
              attempts: attempt + 1,
              errorType: "",
              failureReason: "",
            }
          : parsed;
      }

      const truncated =
        response.finishReason === "length" ||
        looksLikeTruncatedJson(outputCleanup.cleanedText);
      lastFailureType = truncated ? "truncated-json" : "invalid-json";
      lastFailureReason = truncated
        ? "输出因长度限制被截断，请重新输出更紧凑的完整 JSON"
        : "输出不是有效 JSON，请严格返回紧凑 JSON 对象";
      console.warn(
        `[ST-BME] LLM 响应无法解析为 JSON (尝试 ${attempt + 1}, finish=${response.finishReason || "unknown"}):`,
        responseText.slice(0, 200),
      );
    } catch (e) {
      if (isAbortError(e)) {
        const abortMessage = e?.message || String(e) || "LLM 调用已终止";
        const isTimeoutAbort =
          !signal?.aborted && /超时/i.test(String(abortMessage || ""));
        if (!isTimeoutAbort) {
          throw e;
        }
        console.error(`[ST-BME] LLM 调用超时 (尝试 ${attempt + 1}):`, e);
        lastFailureReason = abortMessage;
        lastFailureType = "timeout";
        continue;
      }
      console.error(`[ST-BME] LLM 调用失败 (尝试 ${attempt + 1}):`, e);
      lastFailureReason = e?.message || String(e) || "LLM 调用失败";
      lastFailureType = "provider-error";
    }
  }

  if (returnFailureDetails) {
    const failureSnapshot = {
      ok: false,
      data: null,
      attempts: maxRetries + 1,
      errorType: lastFailureType || "unknown",
      failureReason: lastFailureReason || "LLM 未返回可解析 JSON",
    };
    recordTaskLlmRequest(taskType || privateRequestSource, {
      jsonFailure: failureSnapshot,
      promptExecution: promptExecutionSummary,
    }, {
      merge: true,
    });
    return failureSnapshot;
  }

  return null;
}

/**
 * 调用 LLM（不要求 JSON 输出）
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string|null>}
 */
export async function callLLM(systemPrompt, userPrompt, options = {}) {
  const override = getLlmTestOverride("callLLM");
  if (override) {
    return await override(systemPrompt, userPrompt, options);
  }

  const taskType = String(options.taskType || "").trim();
  const privateRequestSource = resolvePrivateRequestSource(
    taskType,
    options.requestSource || options.source || "diagnostic:call-llm",
    { allowAnonymous: true },
  );
  const promptExecutionSummary = buildPromptExecutionSummary(
    options.debugContext || null,
  );
  const assembledMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const requestCleaning = applyTaskFinalInputRegex(taskType, assembledMessages);
  const promptExecutionSnapshot = attachRequestCleaningToPromptExecution(
    promptExecutionSummary,
    requestCleaning.debug,
  );

  try {
    recordTaskLlmRequest(taskType || privateRequestSource, {
      requestCleaning: requestCleaning.debug,
      promptExecution: promptExecutionSnapshot,
    }, {
      merge: true,
    });
    const response = await callDedicatedOpenAICompatible(requestCleaning.messages, {
      signal: options.signal,
      taskType,
      requestSource: privateRequestSource,
    });
    const responseText =
      typeof response?.content === "string" ? response.content : "";
    const outputCleanup = applyTaskOutputRegexStages(taskType, responseText);
    recordTaskLlmRequest(taskType || privateRequestSource, {
      requestCleaning: requestCleaning.debug,
      responseCleaning: outputCleanup.debug,
      promptExecution: promptExecutionSnapshot,
    }, {
      merge: true,
    });
    return outputCleanup.cleanedText || null;
  } catch (e) {
    console.error("[ST-BME] LLM 调用失败:", e);
    return null;
  }
}

/**
 * 测试记忆 LLM 连通性
 * 若未配置独立记忆 LLM，则测试当前 SillyTavern 聊天模型。
 *
 * @returns {Promise<{success: boolean, mode: string, error: string}>}
 */
export async function testLLMConnection() {
  const config = getMemoryLLMConfig();
  const mode = hasDedicatedLLMConfig(config)
    ? `dedicated:${config.llmProviderLabel || config.llmTransportLabel || config.model}:${config.model}`
    : "sillytavern-current-model";

  try {
    const response = await callLLM(
      "你是一个连接测试助手。请只回答 OK。",
      "请只回复 OK",
      {
        requestSource: "diagnostic:test-connection",
      },
    );
    if (typeof response === "string" && response.trim().length > 0) {
      return { success: true, mode, error: "" };
    }
    return { success: false, mode, error: "API 返回空结果" };
  } catch (e) {
    return { success: false, mode, error: String(e) };
  }
}

export async function fetchMemoryLLMModels() {
  const config = getMemoryLLMConfig();
  if (!config.apiUrl) {
    return {
      success: false,
      models: [],
      error: "请先填写记忆 LLM API 地址",
    };
  }

  if (config.llmSupportsModelFetch !== true) {
    return {
      success: false,
      models: [],
      error: `${config.llmProviderLabel || "当前渠道"} 暂不支持自动拉取模型，请手动填写模型名`,
    };
  }

  const variants = buildDedicatedStatusRequestVariants(config);
  if (!variants.length) {
    return {
      success: false,
      models: [],
      error: `${config.llmProviderLabel || "当前渠道"} 暂无可用的模型探测策略，请手动填写模型名`,
    };
  }
  const errors = [];

  try {
    for (const variant of variants) {
      try {
        const result = await requestDedicatedStatusModels(variant, {
          timeoutMs: config.timeoutMs,
        });
        if (result.models.length > 0) {
          return { success: true, models: result.models, error: "" };
        }
        errors.push(`${variant.mode}:empty`);
      } catch (error) {
        errors.push(`${variant.mode}:${String(error?.message || error)}`);
      }
    }

    return {
      success: false,
      models: [],
      error:
        errors.length > 0
          ? `未拉取到可用模型。尝试结果: ${errors.join(" | ")}`
          : "未拉取到可用模型，请检查接口是否支持模型列表接口",
    };
  } catch (error) {
    return { success: false, models: [], error: String(error) };
  }
}

/**
 * 从 LLM 响应文本中提取 JSON 对象
 * 处理各种常见格式：纯 JSON、markdown 代码块、混合文本等
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;

  const trimmed = text.trim();

  // 1. 直接尝试解析
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  // 2. 尝试提取 markdown 代码块中的 JSON
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  // 3. 尝试找到第一个 { 或 [ 开始的 JSON
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");

  let startIdx = -1;
  let endChar = "";

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endChar = "}";
  } else if (firstBracket >= 0) {
    startIdx = firstBracket;
    endChar = "]";
  }

  if (startIdx >= 0) {
    // 从后往前找匹配的结束字符
    const lastEnd = trimmed.lastIndexOf(endChar);
    if (lastEnd > startIdx) {
      try {
        return JSON.parse(trimmed.slice(startIdx, lastEnd + 1));
      } catch {
        /* continue */
      }
    }
  }

  // 4. trailing comma 容错 (常见 LLM 错误: {"a": 1,} 或 [1, 2,])
  if (startIdx >= 0) {
    const lastEnd = trimmed.lastIndexOf(endChar);
    if (lastEnd > startIdx) {
      const candidate = trimmed
        .slice(startIdx, lastEnd + 1)
        .replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(candidate);
      } catch {
        /* continue */
      }
    }
  }

  // 5. 截断 JSON 修复: 尝试补全不匹配的括号
  if (startIdx >= 0) {
    let candidate = trimmed.slice(startIdx);
    // 先清理 trailing comma
    candidate = candidate.replace(/,\s*$/g, "");

    const opens = { "{": 0, "[": 0 };
    const closes = { "}": "{", "]": "[" };
    for (const ch of candidate) {
      if (ch in opens) opens[ch]++;
      if (ch in closes && opens[closes[ch]] > 0) opens[closes[ch]]--;
    }

    if (opens["["] > 0 || opens["{"] > 0) {
      // 去除末尾不完整的 key-value 残片（如 "key": "未完...）
      candidate = candidate.replace(
        /,?\s*"[^"]*"?\s*:\s*"?[^"}\]]*$/,
        "",
      );
      candidate = candidate.replace(/,\s*$/g, "");
      for (let i = 0; i < opens["["]; i++) candidate += "]";
      for (let i = 0; i < opens["{"]; i++) candidate += "}";
      candidate = candidate.replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(candidate);
      } catch {
        /* continue */
      }
    }
  }

  return null;
}
