// ST-BME: 向量模式、后端索引与直连兜底

import { getRequestHeaders } from "../../../../script.js";
import { embedBatch, embedText, searchSimilar } from "./embedding.js";
import { getActiveNodes } from "./graph.js";
import {
  buildVectorCollectionId,
  stableHashString,
} from "./runtime-state.js";

export const BACKEND_VECTOR_SOURCES = [
  "openai",
  "openrouter",
  "cohere",
  "mistral",
  "electronhub",
  "chutes",
  "nanogpt",
  "ollama",
  "llamacpp",
  "vllm",
];

const BACKEND_SOURCES_REQUIRING_API_URL = new Set([
  "ollama",
  "llamacpp",
  "vllm",
]);

export const BACKEND_DEFAULT_MODELS = {
  openai: "text-embedding-3-small",
  openrouter: "openai/text-embedding-3-small",
  cohere: "embed-multilingual-v3.0",
  mistral: "mistral-embed",
  electronhub: "text-embedding-3-small",
  chutes: "chutes-qwen-qwen3-embedding-8b",
  nanogpt: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  llamacpp: "text-embedding-3-small",
  vllm: "BAAI/bge-m3",
};

export function normalizeOpenAICompatibleBaseUrl(value, autoSuffix = true) {
  let normalized = String(value || "")
    .trim()
    .replace(/\/+(chat\/completions|embeddings)$/i, "")
    .replace(/\/+$/, "");

  if (autoSuffix && normalized && !/\/v\d+$/i.test(normalized)) {
    normalized = normalized;
  }

  return normalized;
}

export function getVectorConfigFromSettings(settings = {}) {
  const mode =
    settings.embeddingTransportMode === "direct" ? "direct" : "backend";
  const autoSuffix = settings.embeddingAutoSuffix !== false;

  if (mode === "direct") {
    return {
      mode,
      source: "direct",
      apiUrl: normalizeOpenAICompatibleBaseUrl(settings.embeddingApiUrl, autoSuffix),
      apiKey: String(settings.embeddingApiKey || "").trim(),
      model: String(settings.embeddingModel || "").trim(),
      autoSuffix,
    };
  }

  const source = BACKEND_VECTOR_SOURCES.includes(settings.embeddingBackendSource)
    ? settings.embeddingBackendSource
    : "openai";

  return {
    mode,
    source,
    apiUrl: normalizeOpenAICompatibleBaseUrl(
      settings.embeddingBackendApiUrl,
      autoSuffix,
    ),
    apiKey: "",
    model: String(
      settings.embeddingBackendModel || BACKEND_DEFAULT_MODELS[source] || "",
    ).trim(),
    autoSuffix,
  };
}

export function getSuggestedBackendModel(source) {
  return BACKEND_DEFAULT_MODELS[source] || "text-embedding-3-small";
}

export function isBackendVectorConfig(config) {
  return config?.mode === "backend";
}

export function isDirectVectorConfig(config) {
  return config?.mode === "direct";
}

export function getVectorModelScope(config) {
  if (!config) return "";

  if (isDirectVectorConfig(config)) {
    return [
      "direct",
      normalizeOpenAICompatibleBaseUrl(config.apiUrl, config.autoSuffix),
      config.model || "",
    ].join("|");
  }

  return [
    "backend",
    config.source || "",
    normalizeOpenAICompatibleBaseUrl(config.apiUrl, config.autoSuffix),
    config.model || "",
  ].join("|");
}

export function validateVectorConfig(config) {
  if (!config) {
    return { valid: false, error: "未找到向量配置" };
  }

  if (isDirectVectorConfig(config)) {
    if (!config.apiUrl) {
      return { valid: false, error: "请填写直连 Embedding API 地址" };
    }
    if (!config.model) {
      return { valid: false, error: "请填写直连 Embedding 模型" };
    }
    return { valid: true, error: "" };
  }

  if (!config.model) {
    return { valid: false, error: "请填写后端向量模型" };
  }

  if (
    BACKEND_SOURCES_REQUIRING_API_URL.has(config.source) &&
    !config.apiUrl
  ) {
    return { valid: false, error: "当前后端向量源需要填写 API 地址" };
  }

  return { valid: true, error: "" };
}

export function buildNodeVectorText(node) {
  const fields = node?.fields || {};
  const preferredKeys = [
    "summary",
    "insight",
    "title",
    "name",
    "state",
    "traits",
    "constraint",
    "goal",
    "participants",
    "suggestion",
    "status",
    "scope",
  ];

  const parts = [];

  for (const key of preferredKeys) {
    const value = fields[key];
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) parts.push(value.join(", "));
    } else if (typeof value === "object") {
      parts.push(JSON.stringify(value));
    } else {
      parts.push(String(value));
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    if (preferredKeys.includes(key) || value == null || value === "") continue;
    if (key === "embedding") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) parts.push(`${key}: ${value.join(", ")}`);
      continue;
    }
    if (typeof value === "object") {
      parts.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    parts.push(`${key}: ${value}`);
  }

  return parts.join(" | ").trim();
}

export function buildNodeVectorHash(node, config) {
  const text = buildNodeVectorText(node);
  const seqEnd = node?.seqRange?.[1] ?? node?.seq ?? 0;
  const payload = [
    node?.id || "",
    text,
    String(seqEnd),
    getVectorModelScope(config),
  ].join("::");
  return stableHashString(payload);
}

function buildBackendSourceRequest(config) {
  const body = {
    source: config.source,
    model: config.model,
  };

  if (BACKEND_SOURCES_REQUIRING_API_URL.has(config.source)) {
    body.apiUrl = config.apiUrl;
  }

  if (config.source === "ollama") {
    body.keep = false;
  }

  return body;
}

function getEligibleVectorNodes(graph, range = null) {
  let nodes = getActiveNodes(graph).filter((node) => !node.archived);

  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    nodes = nodes.filter((node) => {
      const seqStart = node?.seqRange?.[0] ?? node?.seq ?? -1;
      const seqEnd = node?.seqRange?.[1] ?? node?.seq ?? -1;
      return seqEnd >= start && seqStart <= end;
    });
  }

  return nodes.filter((node) => buildNodeVectorText(node).length > 0);
}

function buildDesiredVectorEntries(graph, config, range = null) {
  return getEligibleVectorNodes(graph, range).map((node) => {
    const hash = buildNodeVectorHash(node, config);
    return {
      nodeId: node.id,
      hash,
      text: buildNodeVectorText(node),
      index: node?.seqRange?.[1] ?? node?.seq ?? 0,
    };
  });
}

function computeVectorStats(graph, desiredEntries) {
  const state = graph.vectorIndexState || {};
  const desiredByNodeId = new Map(desiredEntries.map((entry) => [entry.nodeId, entry]));
  const nodeToHash = state.nodeToHash || {};
  const hashToNodeId = state.hashToNodeId || {};

  let indexed = 0;
  let pending = 0;

  for (const entry of desiredEntries) {
    if (nodeToHash[entry.nodeId] === entry.hash) {
      indexed++;
    } else {
      pending++;
    }
  }

  let stale = 0;
  for (const [nodeId, hash] of Object.entries(nodeToHash)) {
    const desired = desiredByNodeId.get(nodeId);
    if (!desired || desired.hash !== hash || hashToNodeId[hash] !== nodeId) {
      stale++;
    }
  }

  return {
    total: desiredEntries.length,
    indexed,
    stale,
    pending,
  };
}

async function purgeVectorCollection(collectionId) {
  const response = await fetch("/api/vector/purge", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ collectionId }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function deleteVectorHashes(collectionId, config, hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return;

  const response = await fetch("/api/vector/delete", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      collectionId,
      hashes,
      ...buildBackendSourceRequest(config),
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function insertVectorEntries(collectionId, config, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const response = await fetch("/api/vector/insert", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      collectionId,
      items: entries.map((entry) => ({
        hash: entry.hash,
        text: entry.text,
        index: entry.index,
      })),
      ...buildBackendSourceRequest(config),
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

function resetVectorMappings(graph, config, chatId) {
  graph.vectorIndexState.mode = config.mode;
  graph.vectorIndexState.source = config.source || "";
  graph.vectorIndexState.modelScope = getVectorModelScope(config);
  graph.vectorIndexState.collectionId = buildVectorCollectionId(chatId);
  graph.vectorIndexState.hashToNodeId = {};
  graph.vectorIndexState.nodeToHash = {};
}

export async function syncGraphVectorIndex(
  graph,
  config,
  {
    chatId = "",
    purge = false,
    force = false,
    range = null,
  } = {},
) {
  if (!graph || !config) {
    return { insertedHashes: [], stats: { total: 0, indexed: 0, stale: 0, pending: 0 } };
  }

  const validation = validateVectorConfig(config);
  if (!validation.valid) {
    graph.vectorIndexState.lastWarning = validation.error;
    graph.vectorIndexState.dirty = true;
    return { insertedHashes: [], stats: graph.vectorIndexState.lastStats };
  }

  const state = graph.vectorIndexState;
  const collectionId = buildVectorCollectionId(chatId || graph?.historyState?.chatId);
  const desiredEntries = buildDesiredVectorEntries(graph, config, range);
  const desiredByNodeId = new Map(desiredEntries.map((entry) => [entry.nodeId, entry]));
  const insertedHashes = [];
  const hasConcreteRange =
    range &&
    Number.isFinite(range.start) &&
    Number.isFinite(range.end);
  const rangedNodeIds = new Set(desiredEntries.map((entry) => entry.nodeId));

  if (isBackendVectorConfig(config)) {
    const scopeChanged =
      state.mode !== "backend" ||
      state.source !== config.source ||
      state.modelScope !== getVectorModelScope(config) ||
      state.collectionId !== collectionId;
    const fullReset = purge || state.dirty || scopeChanged || (force && !hasConcreteRange);

    if (fullReset) {
      await purgeVectorCollection(collectionId);
      resetVectorMappings(graph, config, chatId);
      await insertVectorEntries(collectionId, config, desiredEntries);
      for (const entry of desiredEntries) {
        state.hashToNodeId[entry.hash] = entry.nodeId;
        state.nodeToHash[entry.nodeId] = entry.hash;
        insertedHashes.push(entry.hash);
      }
    } else {
      const hashesToDelete = [];
      const entriesToInsert = [];

      if (force && hasConcreteRange) {
        for (const entry of desiredEntries) {
          const currentHash = state.nodeToHash[entry.nodeId];
          if (currentHash) {
            hashesToDelete.push(currentHash);
            delete state.hashToNodeId[currentHash];
            delete state.nodeToHash[entry.nodeId];
          }
          entriesToInsert.push(entry);
        }
      }

      for (const [nodeId, hash] of Object.entries(state.nodeToHash)) {
        if (hasConcreteRange && !rangedNodeIds.has(nodeId)) {
          continue;
        }
        const desired = desiredByNodeId.get(nodeId);
        if (!desired || desired.hash !== hash) {
          hashesToDelete.push(hash);
          delete state.nodeToHash[nodeId];
          delete state.hashToNodeId[hash];
        }
      }

      for (const entry of desiredEntries) {
        if (force && hasConcreteRange) continue;
        if (state.nodeToHash[entry.nodeId] === entry.hash) continue;
        entriesToInsert.push(entry);
      }

      await deleteVectorHashes(collectionId, config, hashesToDelete);
      await insertVectorEntries(collectionId, config, entriesToInsert);

      for (const entry of entriesToInsert) {
        state.hashToNodeId[entry.hash] = entry.nodeId;
        state.nodeToHash[entry.nodeId] = entry.hash;
        insertedHashes.push(entry.hash);
      }
    }

    for (const node of graph.nodes || []) {
      if (Array.isArray(node.embedding) && node.embedding.length > 0) {
        node.embedding = null;
      }
    }
  } else {
    const entriesToEmbed = [];
    const hashByNodeId = {};

    for (const entry of desiredEntries) {
      hashByNodeId[entry.nodeId] = entry.hash;
      const currentHash = state.nodeToHash?.[entry.nodeId];
      const node = graph.nodes.find((candidate) => candidate.id === entry.nodeId);
      const hasEmbedding = Array.isArray(node?.embedding) && node.embedding.length > 0;

      if (!force && !currentHash && hasEmbedding) {
        state.hashToNodeId[entry.hash] = entry.nodeId;
        state.nodeToHash[entry.nodeId] = entry.hash;
        continue;
      }

      if (force || purge || currentHash !== entry.hash || !hasEmbedding) {
        entriesToEmbed.push(entry);
      }
    }

    if (purge || state.mode !== "direct") {
      resetVectorMappings(graph, config, chatId);
    } else {
      for (const [nodeId, hash] of Object.entries(state.nodeToHash || {})) {
        if (hasConcreteRange && !rangedNodeIds.has(nodeId)) {
          continue;
        }
        if (!hashByNodeId[nodeId]) {
          delete state.nodeToHash[nodeId];
          delete state.hashToNodeId[hash];
        }
      }
    }

    if (entriesToEmbed.length > 0) {
      const embeddings = await embedBatch(
        entriesToEmbed.map((entry) => entry.text),
        config,
      );

      for (let index = 0; index < entriesToEmbed.length; index++) {
        const entry = entriesToEmbed[index];
        const node = graph.nodes.find((candidate) => candidate.id === entry.nodeId);
        if (!node) continue;

        if (embeddings[index]) {
          node.embedding = Array.from(embeddings[index]);
          state.hashToNodeId[entry.hash] = entry.nodeId;
          state.nodeToHash[entry.nodeId] = entry.hash;
          insertedHashes.push(entry.hash);
        }
      }
    }

    state.mode = "direct";
    state.source = "direct";
    state.modelScope = getVectorModelScope(config);
    state.collectionId = collectionId;
  }

  state.dirty = false;
  state.lastWarning = "";
  state.lastSyncAt = Date.now();
  state.lastStats = computeVectorStats(graph, buildDesiredVectorEntries(graph, config));

  return {
    insertedHashes,
    stats: state.lastStats,
  };
}

export async function findSimilarNodesByText(
  graph,
  text,
  config,
  topK = 10,
  candidates = null,
) {
  if (!text || !graph || !config) return [];

  const candidateNodes = Array.isArray(candidates)
    ? candidates
    : getEligibleVectorNodes(graph);

  if (candidateNodes.length === 0) return [];

  if (isDirectVectorConfig(config)) {
    const queryVec = await embedText(text, config);
    if (!queryVec) return [];

    return searchSimilar(
      queryVec,
      candidateNodes
        .filter((node) => Array.isArray(node.embedding) && node.embedding.length > 0)
        .map((node) => ({
          nodeId: node.id,
          embedding: node.embedding,
        })),
      topK,
    );
  }

  const validation = validateVectorConfig(config);
  if (!validation.valid) return [];

  const response = await fetch("/api/vector/query", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      collectionId: graph.vectorIndexState.collectionId,
      searchText: text,
      topK,
      threshold: 0,
      ...buildBackendSourceRequest(config),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    console.warn("[ST-BME] 后端向量查询失败:", errorText);
    return [];
  }

  const data = await response.json().catch(() => ({ hashes: [] }));
  const hashes = Array.isArray(data?.hashes) ? data.hashes : [];
  const nodeIdByHash = graph.vectorIndexState?.hashToNodeId || {};
  const allowedIds = new Set(candidateNodes.map((node) => node.id));

  return hashes
    .map((hash, index) => ({
      nodeId: nodeIdByHash[hash],
      score: Math.max(0.01, 1 - index / Math.max(1, hashes.length)),
    }))
    .filter((entry) => entry.nodeId && allowedIds.has(entry.nodeId))
    .slice(0, topK);
}

export async function testVectorConnection(config, chatId = "connection-test") {
  const validation = validateVectorConfig(config);
  if (!validation.valid) {
    return { success: false, dimensions: 0, error: validation.error };
  }

  if (isDirectVectorConfig(config)) {
    try {
      const vec = await embedText("test connection", config);
      if (vec) {
        return { success: true, dimensions: vec.length, error: "" };
      }
      return { success: false, dimensions: 0, error: "API 返回空结果" };
    } catch (error) {
      return { success: false, dimensions: 0, error: String(error) };
    }
  }

  try {
    const response = await fetch("/api/vector/query", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        collectionId: buildVectorCollectionId(chatId),
        searchText: "test connection",
        topK: 1,
        threshold: 0,
        ...buildBackendSourceRequest(config),
      }),
    });

    const payload = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        success: false,
        dimensions: 0,
        error: payload || response.statusText,
      };
    }

    return { success: true, dimensions: 0, error: "" };
  } catch (error) {
    return { success: false, dimensions: 0, error: String(error) };
  }
}

export function getVectorIndexStats(graph) {
  const state = graph?.vectorIndexState;
  if (!state) {
    return { total: 0, indexed: 0, stale: 0, pending: 0 };
  }
  return state.lastStats || { total: 0, indexed: 0, stale: 0, pending: 0 };
}
