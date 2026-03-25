// ST-BME: LLM 调用封装
// 包装 ST 的 sendOpenAIRequest，提供结构化 JSON 输出和重试机制

import { getRequestHeaders } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { chat_completion_sources, sendOpenAIRequest } from "../../../openai.js";

const MODULE_NAME = "st_bme";
const LLM_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_TEXT_COMPLETION_TOKENS = 1200;
const DEFAULT_JSON_COMPLETION_TOKENS = 2200;
const RETRY_JSON_COMPLETION_TOKENS = 3200;

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
  const timeoutMs = Number(settings?.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : LLM_REQUEST_TIMEOUT_MS;
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
) {
  const systemParts = [
    systemPrompt,
    "输出要求补充：只输出一个紧凑的 JSON 对象。",
    "禁止 markdown 代码块、禁止解释、禁止前后缀、禁止省略号。",
    "如果需要重新生成，请直接从头输出完整 JSON，不要续写上一次内容。",
  ];

  const userParts = [userPrompt];
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

  return [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: userParts.join("\n\n") },
  ];
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

async function callDedicatedOpenAICompatible(
  messages,
  { signal, jsonMode = false, maxCompletionTokens = null } = {},
) {
  const config = getMemoryLLMConfig();
  if (!hasDedicatedLLMConfig(config)) {
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
      "SillyTavern current model returned an unexpected response format",
    );
  }

  const completionTokens = Number.isFinite(maxCompletionTokens)
    ? maxCompletionTokens
    : jsonMode
      ? DEFAULT_JSON_COMPLETION_TOKENS
      : DEFAULT_TEXT_COMPLETION_TOKENS;

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
    temperature: jsonMode ? 0 : 0.2,
    max_tokens: completionTokens,
    max_completion_tokens: completionTokens,
    stream: false,
  };

  if (jsonMode) {
    body.custom_include_body = buildYamlObject({
      response_format: {
        type: "json_object",
      },
    });
  }

  const response = await fetchWithTimeout(
    "/api/backends/chat-completions/generate",
    {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    },
    config.timeoutMs,
  );

  // 如果 400 且带了 structured output，可能是 API 不支持，降级重试
  if (
    !response.ok &&
    response.status === 400 &&
    jsonMode &&
    _jsonModeSupported
  ) {
    console.warn("[ST-BME] API 不支持 json mode，降级为普通 JSON 提示模式");
    _jsonModeSupported = false;
    delete body.custom_include_body;
    const retryResponse = await fetchWithTimeout(
      "/api/backends/chat-completions/generate",
      {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
      },
      config.timeoutMs,
    );
    return await _parseResponse(retryResponse);
  }

  return await _parseResponse(response);
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
} = {}) {
  let lastFailureReason = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messages = buildJsonAttemptMessages(
        systemPrompt,
        userPrompt,
        attempt,
        lastFailureReason,
      );
      const response = await callDedicatedOpenAICompatible(messages, {
        signal,
        jsonMode: true,
        maxCompletionTokens:
          attempt === 0
            ? DEFAULT_JSON_COMPLETION_TOKENS
            : RETRY_JSON_COMPLETION_TOKENS,
      });
      const responseText = response?.content || "";

      if (!responseText || typeof responseText !== "string") {
        console.warn(`[ST-BME] LLM 返回空响应 (尝试 ${attempt + 1})`);
        lastFailureReason = "返回空响应";
        continue;
      }

      // 尝试解析 JSON
      const parsed = extractJSON(responseText);
      if (parsed !== null) {
        return parsed;
      }

      const truncated =
        response.finishReason === "length" ||
        looksLikeTruncatedJson(responseText);
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
export async function callLLM(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const response = await callDedicatedOpenAICompatible(messages);
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
