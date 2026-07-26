// ST-BME: 外部 Embedding API 封装 + 向量检索
// 支持 OpenAI 兼容的 /v1/embeddings 接口

/**
 * Embedding 服务
 * 调用外部 API 获取文本向量，并提供暴力搜索 cosine 相似度
 */

import { getRequestHeaders } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
import { resolveConfiguredTimeoutMs } from "../runtime/request-timeout.js";

const MODULE_NAME = "st_bme";
const EMBEDDING_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_EMBEDDING_BATCH_SIZE = 10;
const MAX_EMBEDDING_BATCH_SIZE = 100;
const BACKEND_SOURCES_REQUIRING_API_URL = new Set([
  "ollama",
  "llamacpp",
  "vllm",
]);

function getEmbeddingTestOverride(name) {
  const override = globalThis.__stBmeTestOverrides?.embedding?.[name];
  return typeof override === "function" ? override : null;
}

function getConfiguredTimeoutMs(
  settings = extension_settings[MODULE_NAME] || {},
) {
  return typeof resolveConfiguredTimeoutMs === "function"
    ? resolveConfiguredTimeoutMs(settings, EMBEDDING_REQUEST_TIMEOUT_MS)
    : (() => {
        const timeoutMs = Number(settings?.timeoutMs);
        return Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : EMBEDDING_REQUEST_TIMEOUT_MS;
      })();
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function normalizeOpenAICompatibleBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+(chat\/completions|embeddings)$/i, "")
    .replace(/\/+$/, "");
}

function normalizeVector(value) {
  if (!Array.isArray(value)) return null;
  const vector = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  return vector.length ? new Float64Array(vector) : null;
}

function summarizePayload(value, maxLength = 360) {
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value ?? "");
  }
  text = String(text || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function readPayloadMessage(value, fallback = "") {
  if (value && typeof value === "object") {
    const message = value?.error?.message || value?.message || value?.error || value?.detail;
    if (message) return String(message);
  }
  return summarizePayload(value) || fallback;
}

function parseJsonText(value = "") {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return value;
  }
}

function buildDirectEmbeddingBody(config = {}, input) {
  const body = {
    model: config.model,
    input,
    encoding_format: String(config.encodingFormat || config.encoding_format || "float"),
  };
  const dimensions = Number(config.dimensions ?? config.embeddingDimensions);
  if (Number.isFinite(dimensions) && dimensions > 0) {
    body.dimensions = Math.floor(dimensions);
  }
  return body;
}

function readEmbeddingMode(config = {}) {
  return String(config?.embeddingMode || config?.mode || "direct").trim().toLowerCase();
}

function readEmbeddingSource(config = {}) {
  return String(config?.embeddingSource || config?.source || "openai").trim().toLowerCase() || "openai";
}

function buildBackendEmbeddingRequestBody(config = {}, payload = {}) {
  const source = readEmbeddingSource(config);
  const body = {
    source,
    model: String(config?.model || "").trim(),
    isQuery: Boolean(payload.isQuery),
  };
  if (payload.text !== undefined) {
    body.text = String(payload.text ?? "");
  }
  if (Array.isArray(payload.texts)) {
    body.texts = payload.texts.map((item) => String(item ?? ""));
  }
  if (BACKEND_SOURCES_REQUIRING_API_URL.has(source)) {
    body.apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  }
  if (source === "ollama") {
    body.keep = false;
  }
  return body;
}

async function requestBackendEmbeddings(config = {}, payload = {}, { signal } = {}) {
  const response = await fetchWithTimeout(
    "/api/vector/embed",
    {
      method: "POST",
      headers: {
        ...getRequestHeaders(),
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify(buildBackendEmbeddingRequestBody(config, payload)),
    },
    getConfiguredTimeoutMs(config),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const payload = parseJsonText(errorText);
    const message = `Backend Embedding API 错误 (${response.status}): ${readPayloadMessage(payload, response.statusText)}`;
    console.error(`[ST-BME] ${message}`, payload);
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return await response.json().catch((error) => {
    throw new Error(
      `Backend Embedding API JSON 解析失败: ${error?.message || error}`,
    );
  });
}

function getEmbeddingBatchSize(config = {}) {
  const parsed = Number(config?.embeddingBatchSize ?? config?.batchSize);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EMBEDDING_BATCH_SIZE;
  }
  return Math.min(MAX_EMBEDDING_BATCH_SIZE, Math.max(1, Math.trunc(parsed)));
}

function chunkTexts(texts = [], size = DEFAULT_EMBEDDING_BATCH_SIZE) {
  const chunks = [];
  for (let start = 0; start < texts.length; start += size) {
    chunks.push({ start, texts: texts.slice(start, start + size) });
  }
  return chunks;
}

async function requestDirectEmbeddingBatch(texts, config = {}, { signal } = {}) {
  const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  const response = await fetchWithTimeout(
    apiUrl + "/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
      },
      signal,
      body: JSON.stringify(buildDirectEmbeddingBody(config, texts)),
    },
    getConfiguredTimeoutMs(config),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const payload = parseJsonText(errorText);
    const error = new Error(
      `Embedding API 错误 (${response.status}): ${readPayloadMessage(payload, response.statusText)}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  const embeddings = Array.isArray(data?.data) ? data.data : null;
  if (!embeddings) {
    throw new Error(`Embedding API 返回格式异常: ${summarizePayload(data)}`);
  }

  const results = new Array(texts.length).fill(null);
  embeddings.forEach((item, order) => {
    const rawIndex = Number(item?.index);
    const index = Number.isInteger(rawIndex) ? rawIndex : order;
    if (index >= 0 && index < results.length) {
      results[index] = normalizeVector(item?.embedding);
    }
  });
  return results;
}

async function requestBackendEmbeddingBatch(texts, config = {}, { signal, isQuery = false } = {}) {
  const payload = await requestBackendEmbeddings(
    config,
    { texts, isQuery },
    { signal },
  );
  const vectors = Array.isArray(payload?.vectors) ? payload.vectors : null;
  if (!vectors) {
    throw new Error(`Backend Embedding API 返回格式异常: ${summarizePayload(payload)}`);
  }
  return texts.map((_, index) => normalizeVector(vectors[index]));
}

async function fallbackEmbedChunkTexts(
  texts,
  config = {},
  { signal, isQuery = false, collectErrors = null, throwOnFailure = false } = {},
) {
  const vectors = [];
  for (const text of texts) {
    try {
      vectors.push(await embedText(text, { ...config, throwOnFailure }, { signal, isQuery }));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (Array.isArray(collectErrors)) {
        collectErrors.push(error?.message || String(error));
      }
      console.error("[ST-BME] Embedding 单条回退失败:", error);
      vectors.push(null);
    }
  }
  return vectors;
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

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = EMBEDDING_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Embedding 请求超时 (${Math.round(timeoutMs / 1000)}s)`,
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

/**
 * 调用外部 Embedding API
 *
 * @param {string} text - 要嵌入的文本
 * @param {object} config - API 配置
 * @param {string} config.apiUrl - API 基地址（如 https://api.openai.com/v1）
 * @param {string} config.apiKey - API Key
 * @param {string} config.model - 模型名（如 text-embedding-3-small）
 * @returns {Promise<Float64Array|null>} 向量或 null
 */
export async function embedText(text, config, { signal, isQuery = false } = {}) {
  const override = getEmbeddingTestOverride("embedText");
  if (override) {
    return await override(text, config, { signal, isQuery });
  }

  if (readEmbeddingMode(config) === "backend") {
    if (!text || !config?.model) {
      console.warn("[ST-BME] Embedding 配置不完整，跳过");
      return null;
    }
    try {
      const payload = await requestBackendEmbeddings(
        config,
        { text, isQuery },
        { signal },
      );
      return normalizeVector(payload?.vector);
    } catch (e) {
      if (isAbortError(e)) {
        throw e;
      }
      if (config?.throwOnFailure) {
        throw e;
      }
      console.error("[ST-BME] Backend Embedding 调用失败:", e);
      return null;
    }
  }

  const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  if (!text || !apiUrl || !config?.model) {
    console.warn("[ST-BME] Embedding 配置不完整，跳过");
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      `${apiUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        signal,
        body: JSON.stringify(buildDirectEmbeddingBody(config, text)),
      },
      getConfiguredTimeoutMs(config),
    );

    if (!response.ok) {
      const errorText = await response.text();
      const payload = parseJsonText(errorText);
      const message = `Embedding API 错误 (${response.status}): ${readPayloadMessage(payload, response.statusText)}`;
      console.error(`[ST-BME] ${message}`, payload);
      if (config?.throwOnFailure) throw new Error(message);
      return null;
    }

    const data = await response.json().catch((error) => {
      if (config?.throwOnFailure) {
        throw new Error(`Embedding API JSON 解析失败: ${error?.message || error}`);
      }
      return {};
    });
    const vector = data?.data?.[0]?.embedding;

    if (!vector || !Array.isArray(vector)) {
      console.error("[ST-BME] Embedding API 返回格式异常:", data);
      if (config?.throwOnFailure) {
        throw new Error(`Embedding API 返回格式异常: ${summarizePayload(data)}`);
      }
      return null;
    }

    return new Float64Array(vector);
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    if (config?.throwOnFailure) {
      throw e;
    }
    console.error("[ST-BME] Embedding API 调用失败:", e);
    return null;
  }
}

/**
 * 批量嵌入文本
 *
 * @param {string[]} texts
 * @param {object} config
 * @returns {Promise<(Float64Array|null)[]>}
 */
export async function embedBatch(texts, config, { signal, isQuery = false } = {}) {
  const normalizedTexts = Array.isArray(texts)
    ? texts.map((item) => String(item ?? ""))
    : [];
  const override = getEmbeddingTestOverride("embedBatch");
  if (override) {
    return await override(normalizedTexts, config, { signal, isQuery });
  }

  if (!normalizedTexts.length) {
    return [];
  }

  const isBackend = readEmbeddingMode(config) === "backend";
  const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  if (!config?.model || (!isBackend && !apiUrl)) {
    return normalizedTexts.map(() => null);
  }

  const results = new Array(normalizedTexts.length).fill(null);
  const diagnostics = [];
  const batchSize = getEmbeddingBatchSize(config);
  for (const chunk of chunkTexts(normalizedTexts, batchSize)) {
    let vectors = null;
    try {
      vectors = isBackend
        ? await requestBackendEmbeddingBatch(chunk.texts, config, { signal, isQuery })
        : await requestDirectEmbeddingBatch(chunk.texts, config, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      console.error(
        isBackend
          ? "[ST-BME] Backend Embedding 批量调用失败:"
          : "[ST-BME] Embedding API 批量调用失败:",
        error,
      );
      diagnostics.push(error?.message || String(error));
    }

    if (!vectors || vectors.length < chunk.texts.length) {
      vectors = await fallbackEmbedChunkTexts(chunk.texts, config, {
        signal,
        isQuery,
        collectErrors: diagnostics,
        throwOnFailure: Boolean(config?.throwOnEmptyBatch),
      });
    } else {
      const missingIndexes = [];
      for (let index = 0; index < chunk.texts.length; index++) {
        if (!vectors[index]) {
          missingIndexes.push(index);
        }
      }
      if (missingIndexes.length > 0) {
        const fallbackVectors = await fallbackEmbedChunkTexts(
          missingIndexes.map((index) => chunk.texts[index]),
          config,
          {
            signal,
            isQuery,
            collectErrors: diagnostics,
            throwOnFailure: Boolean(config?.throwOnEmptyBatch),
          },
        );
        missingIndexes.forEach((missingIndex, fallbackIndex) => {
          vectors[missingIndex] = fallbackVectors[fallbackIndex] || null;
        });
      }
    }

    for (let index = 0; index < chunk.texts.length; index++) {
      results[chunk.start + index] = vectors[index] || null;
    }
  }

  if (config?.throwOnEmptyBatch && !results.some((vector) => vector && vector.length > 0)) {
    throw new Error(diagnostics.find(Boolean) || "Embedding API 批量返回空结果");
  }

  return results;
}
/**
 * 计算两个向量的 cosine 相似度
 *
 * @param {Float64Array|number[]} vecA
 * @param {Float64Array|number[]} vecB
 * @returns {number} 相似度 [-1, 1]
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * 暴力搜索：找出与查询向量最相似的 Top-K 节点
 * PeroCore 的向量引擎也是暴力搜索（<1000 节点时比 HNSW 更快）
 *
 * @param {Float64Array|number[]} queryVec - 查询向量
 * @param {Array<{nodeId: string, embedding: Float64Array|number[]}>} candidates - 候选节点
 * @param {number} topK - 返回数量
 * @returns {Array<{nodeId: string, score: number}>} 按相似度降序
 */
export function searchSimilar(queryVec, candidates, topK = 20) {
  const override = getEmbeddingTestOverride("searchSimilar");
  if (override) {
    return override(queryVec, candidates, topK);
  }

  if (!queryVec || candidates.length === 0) return [];

  const scored = candidates
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((c) => ({
      nodeId: c.nodeId,
      score: cosineSimilarity(queryVec, c.embedding),
    }))
    .filter((item) => item.score > 0);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

/**
 * 测试 Embedding API 连通性
 *
 * @param {object} config - API 配置
 * @returns {Promise<{success: boolean, dimensions: number, error: string}>}
 */
export async function testConnection(config) {
  try {
    const vec = await embedText("test connection", config);
    if (vec) {
      return { success: true, dimensions: vec.length, error: "" };
    }
    return { success: false, dimensions: 0, error: "API 返回空结果" };
  } catch (e) {
    return { success: false, dimensions: 0, error: String(e) };
  }
}
