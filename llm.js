// ST-BME: LLM 调用封装
// 包装 ST 的 sendOpenAIRequest，提供结构化 JSON 输出和重试机制

import { getRequestHeaders } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { chat_completion_sources, sendOpenAIRequest } from "../../../openai.js";
import { resolveTaskGenerationOptions } from "./generation-options.js";
import { resolveConfiguredTimeoutMs } from "./request-timeout.js";
import { applyTaskRegex } from "./task-regex.js";

const MODULE_NAME = "st_bme";
const LLM_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_TEXT_COMPLETION_TOKENS = 64000;
const DEFAULT_JSON_COMPLETION_TOKENS = 64000;
const RETRY_JSON_COMPLETION_TOKENS = 3200;
const STREAM_DEBUG_PREVIEW_MAX_CHARS = 1200;
const STREAM_DEBUG_UPDATE_INTERVAL_MS = 120;
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
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    redacted.redacted = true;
  }
  return redacted;
}

function nowIso() {
  return new Date().toISOString();
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

function recordTaskLlmRequest(taskType, snapshot = {}, options = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  const state = getRuntimeDebugState();
  const shouldMerge = options?.merge === true;
  const previousSnapshot = shouldMerge
    ? cloneRuntimeDebugValue(state.taskLlmRequests[normalizedTaskType], {})
    : {};
  state.taskLlmRequests[normalizedTaskType] = {
    ...previousSnapshot,
    updatedAt: new Date().toISOString(),
    ...sanitizeLlmDebugSnapshot(snapshot),
  };
  state.updatedAt = new Date().toISOString();
}

function getLlmTestOverride(name) {
  const override = globalThis.__stBmeTestOverrides?.llm?.[name];
  return typeof override === "function" ? override : null;
}

function getMemoryLLMConfig() {
  const settings = extension_settings[MODULE_NAME] || {};
  return {
    apiUrl: normalizeOpenAICompatibleBaseUrl(settings.llmApiUrl),
    apiKey: String(settings.llmApiKey || "").trim(),
    model: String(settings.llmModel || "").trim(),
    timeoutMs: getConfiguredTimeoutMs(settings),
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
    taskType: String(entry?.taskType || ""),
    stage: String(entry?.stage || ""),
    enabled: entry?.enabled !== false,
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

function buildEffectiveLlmRoute(
  hasDedicatedConfig,
  privateRequestSource,
  taskType = "",
) {
  const dedicated = Boolean(hasDedicatedConfig);
  return {
    taskType: String(taskType || "").trim(),
    requestSource: String(privateRequestSource || "").trim(),
    llm: dedicated ? "dedicated-memory-llm" : "sillytavern-current-model",
    transport: dedicated
      ? "dedicated-openai-compatible"
      : "sillytavern-current-model",
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
  return String(value || "")
    .trim()
    .replace(/\/+(chat\/completions|embeddings)$/i, "")
    .replace(/\/+$/, "");
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
      id = String(item.id || item.name || item.value || item.slug || "").trim();
      label = String(
        item.name || item.id || item.value || item.slug || "",
      ).trim();
    }

    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label || id });
  }

  return models;
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
        .map((message) => {
          if (!message || typeof message !== "object") return null;
          const role = String(message.role || "").trim().toLowerCase();
          const content = String(message.content || "").trim();
          if (!["system", "user", "assistant"].includes(role) || !content) {
            return null;
          }
          return { role, content };
        })
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
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").trim().toLowerCase();
    const content = String(message.content || "").trim();
    if (!content) continue;
    if (!["system", "user", "assistant"].includes(role)) continue;
    messages.push({ role, content });
  }

  messages.push({ role: "user", content: userParts.join("\n\n") });
  return messages;
}

function resolvePrivateRequestSource(
  taskType = "",
  requestSource = "",
  { allowAnonymous = false } = {},
) {
  const normalizedRequestSource = String(requestSource || "").trim();
  if (normalizedRequestSource) {
    return normalizedRequestSource;
  }

  const normalizedTaskType = String(taskType || "").trim();
  if (normalizedTaskType) {
    return `task:${normalizedTaskType}`;
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
  const config = getMemoryLLMConfig();
  const settings = extension_settings[MODULE_NAME] || {};
  const hasDedicatedConfig = hasDedicatedLLMConfig(config);
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
  const streamRequested =
    hasDedicatedConfig && initialFilteredGeneration.stream === true;
  const streamState = createStreamDebugState({
    requested: streamRequested,
  });
  recordTaskLlmRequest(taskType || privateRequestSource, {
    requestSource: privateRequestSource,
    taskType: String(taskType || "").trim(),
    jsonMode,
    dedicatedConfig: hasDedicatedConfig,
    route: hasDedicatedConfig
      ? "dedicated-openai-compatible"
      : "sillytavern-current-model",
    model: hasDedicatedConfig ? config.model : "sillytavern-current-model",
    apiUrl: hasDedicatedConfig ? config.apiUrl : "",
    messages,
    generation: generationResolved.generation || {},
    filteredGeneration: generationResolved.filtered || {},
    removedGeneration: generationResolved.removed || [],
    capabilityMode: generationResolved.capabilityMode || "",
    effectiveRoute: buildEffectiveLlmRoute(
      hasDedicatedConfig,
      privateRequestSource,
      taskType,
    ),
    maxCompletionTokens,
    ...buildStreamDebugSnapshot(streamState),
  });
  if (!hasDedicatedConfig) {
    const payload = await sendOpenAIRequest(
      "quiet",
      messages,
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
  const filteredGeneration = generationResolved.filtered || {};
  const resolvedCompletionTokens = Number.isFinite(
    filteredGeneration.max_completion_tokens,
  )
    ? filteredGeneration.max_completion_tokens
    : completionTokens;

  const body = {
    chat_completion_source: chat_completion_sources.CUSTOM,
    custom_url: config.apiUrl,
    custom_include_headers: config.apiKey
      ? buildYamlObject({
          Authorization: `Bearer ${config.apiKey}`,
        })
      : "",
    model: config.model,
    messages,
    temperature: filteredGeneration.temperature ?? 1,
    max_completion_tokens: resolvedCompletionTokens,
    stream: filteredGeneration.stream ?? false,
    frequency_penalty: filteredGeneration.frequency_penalty ?? 0,
    presence_penalty: filteredGeneration.presence_penalty ?? 0,
    top_p: filteredGeneration.top_p ?? 1,
  };

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

  if (jsonMode && _jsonModeSupported) {
    body.custom_include_body = buildYamlObject({
      response_format: {
        type: "json_object",
      },
    });
  }

  recordTaskLlmRequest(taskKey, {
    requestSource: privateRequestSource,
    taskType: String(taskType || "").trim(),
    jsonMode,
    dedicatedConfig: true,
    route: "dedicated-openai-compatible",
    model: config.model,
    apiUrl: config.apiUrl,
    messages,
    generation: generationResolved.generation || {},
    filteredGeneration,
    removedGeneration: generationResolved.removed || [],
    capabilityMode: generationResolved.capabilityMode || "",
    resolvedCompletionTokens,
    effectiveRoute: buildEffectiveLlmRoute(
      true,
      privateRequestSource,
      taskType,
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
    });
  }

  const privateRequestSource = resolvePrivateRequestSource(
    taskType,
    requestSource,
  );
  let lastFailureReason = "";
  const promptExecutionSummary = buildPromptExecutionSummary(debugContext);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messages = buildJsonAttemptMessages(
        systemPrompt,
        userPrompt,
        attempt,
        lastFailureReason,
        additionalMessages,
        promptMessages,
      );
      const response = await callDedicatedOpenAICompatible(messages, {
        signal,
        jsonMode: true,
        taskType,
        requestSource: privateRequestSource,
        onStreamProgress,
        maxCompletionTokens:
          attempt === 0
            ? DEFAULT_JSON_COMPLETION_TOKENS
            : RETRY_JSON_COMPLETION_TOKENS,
      });
      const responseText = response?.content || "";
      const outputCleanup = applyTaskOutputRegexStages(taskType, responseText);
      recordTaskLlmRequest(
        taskType || privateRequestSource,
        {
          responseCleaning: outputCleanup.debug,
          promptExecution: promptExecutionSummary,
        },
        {
          merge: true,
        },
      );

      if (!responseText || typeof responseText !== "string") {
        console.warn(`[ST-BME] LLM 返回空响应 (尝试 ${attempt + 1})`);
        lastFailureReason = "返回空响应";
        continue;
      }

      // 尝试解析 JSON
      const parsed = extractJSON(outputCleanup.cleanedText);
      if (parsed !== null) {
        return parsed;
      }

      const truncated =
        response.finishReason === "length" ||
        looksLikeTruncatedJson(outputCleanup.cleanedText);
      lastFailureReason = truncated
        ? "输出因长度限制被截断，请重新输出更紧凑的完整 JSON"
        : "输出不是有效 JSON，请严格返回紧凑 JSON 对象";
      console.warn(
        `[ST-BME] LLM 响应无法解析为 JSON (尝试 ${attempt + 1}, finish=${response.finishReason || "unknown"}):`,
        responseText.slice(0, 200),
      );
    } catch (e) {
      if (isAbortError(e)) {
        throw e;
      }
      console.error(`[ST-BME] LLM 调用失败 (尝试 ${attempt + 1}):`, e);
      lastFailureReason = e?.message || String(e) || "LLM 调用失败";
    }
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

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const response = await callDedicatedOpenAICompatible(messages, {
      signal: options.signal,
      taskType: options.taskType || "",
      requestSource:
        options.requestSource || options.source || "diagnostic:call-llm",
    });
    return response?.content || null;
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
    ? `dedicated:${config.model}`
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

  try {
    const response = await fetch("/api/backends/chat-completions/status", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        chat_completion_source: chat_completion_sources.OPENAI,
        reverse_proxy: config.apiUrl,
        proxy_password: config.apiKey || "",
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || payload?.message || response.statusText;
      return {
        success: false,
        models: [],
        error: message || `HTTP ${response.status}`,
      };
    }

    const models = normalizeModelList(payload?.data);
    if (models.length === 0) {
      return {
        success: false,
        models: [],
        error: "未拉取到可用模型，请检查接口是否支持 /models",
      };
    }

    return { success: true, models, error: "" };
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

  return null;
}
