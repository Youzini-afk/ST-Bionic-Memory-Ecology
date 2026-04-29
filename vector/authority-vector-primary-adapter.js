import { normalizeAuthorityBaseUrl } from "../runtime/authority-capabilities.js";
import {
  AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06,
  AuthorityHttpClient,
} from "../runtime/authority-http-client.js";
import { embedText } from "./embedding.js";

export const AUTHORITY_VECTOR_MODE = "authority";
export const AUTHORITY_VECTOR_SOURCE = "authority-trivium";

const DEFAULT_AUTHORITY_TRIVIUM_DATABASE = "st_bme_vectors";
const DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE = 1000;
const MAX_AUTHORITY_VECTOR_CHUNK_SIZE = 2000;
const DEFAULT_AUTHORITY_PURGE_PAGE_SIZE = 200;
const DEFAULT_AUTHORITY_PURGE_MAX_PAGES = 1000;
const DEFAULT_AUTHORITY_EMBEDDING_BACKEND_SOURCE = "openai";

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowMs() {
  if (typeof performance?.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function clonePlain(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeVector(value = null) {
  const source = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function estimateJsonBytes(value = null) {
  try {
    const text = JSON.stringify(value ?? null);
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).length;
    }
    return text.length;
  } catch {
    return 0;
  }
}

function isPlainObject(value = null) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasPlainKeys(value = null) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function normalizeOpenAICompatibleBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+(chat\/completions|embeddings)$/i, "")
    .replace(/\/+$/, "");
}

function readNestedValue(source = null, path = []) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function normalizeNodeResultId(item = null) {
  return normalizeRecordId(
    item?.nodeId ||
      item?.externalId ||
      item?.id ||
      readNestedValue(item, ["payload", "nodeId"]) ||
      readNestedValue(item, ["payload", "externalId"]) ||
      readNestedValue(item, ["payload", "id"]),
  );
}

function readResultRows(payload = null) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.hits)) return payload.hits;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.neighbors)) return payload.neighbors;
  if (Array.isArray(payload.links)) return payload.links;
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (Array.isArray(payload.result?.results)) return payload.result.results;
  if (Array.isArray(payload.result?.items)) return payload.result.items;
  if (Array.isArray(payload.result?.rows)) return payload.result.rows;
  if (Array.isArray(payload.result?.data)) return payload.result.data;
  if (Array.isArray(payload.result?.neighbors)) return payload.result.neighbors;
  if (Array.isArray(payload.result?.links)) return payload.result.links;
  if (Array.isArray(payload.result?.nodes)) return payload.result.nodes;
  return [];
}

function normalizeNodeIdRows(payload = null) {
  const seen = new Set();
  const result = [];
  for (const item of readResultRows(payload)) {
    const nodeId = normalizeNodeResultId(item);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  return result;
}

function normalizeNeighborNodeIds(payload = null, seedIds = []) {
  const seedSet = new Set((Array.isArray(seedIds) ? seedIds : []).map(normalizeRecordId));
  const seen = new Set();
  const result = [];
  for (const item of readResultRows(payload)) {
    const directId = normalizeNodeResultId(item);
    const preferredId =
      normalizeRecordId(item?.neighborId || item?.targetId || item?.toId) || directId;
    const alternateId = normalizeRecordId(item?.sourceId || item?.fromId);
    const nodeId = !seedSet.has(preferredId)
      ? preferredId
      : !seedSet.has(alternateId)
        ? alternateId
        : preferredId;
    if (!nodeId || seedSet.has(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  return result;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("操作已终止"), { name: "AbortError" });
  }
}

function getNodeFieldText(node = {}, keys = []) {
  const fields = node?.fields && typeof node.fields === "object" ? node.fields : {};
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeSearchResults(payload = null) {
  const rows = readResultRows(payload);
  return rows
    .map((item, index) => {
      const nodeId = normalizeNodeResultId(item);
      if (!nodeId) return null;
      const rawScore = Number(item?.score ?? item?.similarity ?? item?.rankScore);
      const distance = Number(item?.distance);
      const score = Number.isFinite(rawScore)
        ? rawScore
        : Number.isFinite(distance)
          ? 1 / (1 + Math.max(0, distance))
          : Math.max(0.01, 1 - index / Math.max(1, rows.length));
      return { nodeId, score };
    })
    .filter(Boolean);
}

function buildOpenOptions(config = {}, payload = {}) {
  const database = normalizeRecordId(payload.database || config.database) || DEFAULT_AUTHORITY_TRIVIUM_DATABASE;
  return {
    database,
    ...(normalizePositiveInteger(payload.dim ?? config.dim, 0) > 0 ? { dim: normalizePositiveInteger(payload.dim ?? config.dim, 0) } : {}),
    ...(payload.dtype || config.dtype ? { dtype: String(payload.dtype || config.dtype) } : {}),
    ...(payload.syncMode || config.syncMode ? { syncMode: String(payload.syncMode || config.syncMode) } : {}),
    ...(payload.storageMode || config.storageMode ? { storageMode: String(payload.storageMode || config.storageMode) } : {}),
  };
}

function getNamespace(payload = {}) {
  return normalizeRecordId(payload.namespace || payload.collectionId || payload.chatId);
}

function buildNodeReference(id, namespace = "") {
  return {
    externalId: normalizeRecordId(id),
    ...(namespace ? { namespace } : {}),
  };
}

function buildV06PayloadSource(payload = {}) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function buildAuthorityNodePayload(node = {}, entry = {}, { chatId = "", modelScope = "", revision = 0 } = {}) {
  const scope = node?.scope && typeof node.scope === "object" ? node.scope : {};
  const seqRange = Array.isArray(node?.seqRange) ? node.seqRange : [node?.seq ?? 0, node?.seq ?? 0];
  return {
    chatId,
    nodeId: normalizeRecordId(node?.id || entry?.nodeId),
    type: String(node?.type || ""),
    archived: Boolean(node?.archived),
    seqStart: Number(seqRange[0] ?? node?.seq ?? 0) || 0,
    seqEnd: Number(seqRange[1] ?? node?.seq ?? 0) || 0,
    sourceFloor: Number(seqRange[1] ?? node?.seq ?? 0) || 0,
    importance: Number(node?.importance ?? 0) || 0,
    updatedAt: Number(node?.updatedAt || Date.now()) || Date.now(),
    scopeLayer: String(scope.layer || ""),
    scopeOwnerType: String(scope.ownerType || ""),
    scopeOwnerId: String(scope.ownerId || ""),
    scopeOwnerName: String(scope.ownerName || ""),
    scopeBucket: String(scope.bucket || ""),
    regionKey: String(scope.regionKey || node?.regionKey || ""),
    storySegmentId: String(node?.storySegmentId || node?.storyTime?.segmentId || ""),
    storyTimeLabel: String(node?.storyTime?.label || ""),
    text: String(entry?.text || ""),
    title: getNodeFieldText(node, ["title"]),
    name: getNodeFieldText(node, ["name"]),
    summaryPreview: getNodeFieldText(node, ["summary", "insight", "state"]),
    contentHash: String(entry?.hash || ""),
    modelScope,
    revision: Math.max(0, Math.floor(Number(revision) || 0)),
  };
}

function buildAuthorityVectorItems(graph, entries = [], options = {}) {
  const nodesById = new Map(toArray(graph?.nodes).map((node) => [String(node?.id || ""), node]));
  return toArray(entries)
    .map((entry) => {
      const nodeId = normalizeRecordId(entry?.nodeId);
      const node = nodesById.get(nodeId);
      if (!node) return null;
      const payload = buildAuthorityNodePayload(node, entry, options);
      return {
        id: nodeId,
        externalId: nodeId,
        nodeId,
        text: String(entry?.text || ""),
        index: Number(entry?.index || 0) || 0,
        hash: String(entry?.hash || ""),
        vector: normalizeVector(entry?.vector || entry?.embedding || node?.embedding),
        payload,
      };
    })
    .filter((item) => item?.nodeId && item.text);
}

function buildAuthorityLinkItems(graph, { chatId = "", revision = 0 } = {}) {
  return toArray(graph?.edges)
    .filter((edge) => edge && !edge.invalidAt && !edge.expiredAt && !edge.deletedAt)
    .map((edge) => {
      const fromId = normalizeRecordId(edge.fromId || edge.sourceId || edge.from);
      const toId = normalizeRecordId(edge.toId || edge.targetId || edge.to);
      if (!fromId || !toId) return null;
      return {
        id: normalizeRecordId(edge.id) || `${fromId}->${toId}:${String(edge.relation || "related")}`,
        fromId,
        toId,
        relation: String(edge.relation || edge.type || "related"),
        weight: Number(edge.strength ?? edge.weight ?? 1) || 1,
        payload: {
          chatId,
          edgeId: normalizeRecordId(edge.id),
          relation: String(edge.relation || edge.type || "related"),
          strength: Number(edge.strength ?? edge.weight ?? 1) || 1,
          edgeType: String(edge.type || edge.edgeType || ""),
          revision: Math.max(0, Math.floor(Number(revision) || 0)),
          raw: clonePlain(edge, {}),
        },
      };
    })
    .filter(Boolean);
}

export function isAuthorityVectorConfig(config = null) {
  return config?.mode === AUTHORITY_VECTOR_MODE || config?.source === AUTHORITY_VECTOR_SOURCE;
}

export function normalizeAuthorityVectorConfig(settings = {}, overrides = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const hasAuthorityEmbeddingOverride = [
    source.authorityEmbeddingApiUrl,
    source.authorityEmbeddingApiKey,
    source.authorityEmbeddingModel,
  ].some((value) => String(value ?? "").trim());
  const embeddingMode = hasAuthorityEmbeddingOverride
    ? "direct"
    : String(source.embeddingTransportMode || "direct").trim().toLowerCase() === "backend"
      ? "backend"
      : "direct";
  const embeddingSource = embeddingMode === "backend"
    ? String(source.embeddingBackendSource || DEFAULT_AUTHORITY_EMBEDDING_BACKEND_SOURCE).trim().toLowerCase() || DEFAULT_AUTHORITY_EMBEDDING_BACKEND_SOURCE
    : "direct";
  return {
    mode: AUTHORITY_VECTOR_MODE,
    source: AUTHORITY_VECTOR_SOURCE,
    baseUrl: normalizeAuthorityBaseUrl(source.authorityBaseUrl ?? source.baseUrl),
    protocol: AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06,
    database: normalizeRecordId(source.authorityTriviumDatabase ?? source.triviumDatabase) || DEFAULT_AUTHORITY_TRIVIUM_DATABASE,
    dim: normalizePositiveInteger(source.authorityTriviumDim ?? source.triviumDim, 0),
    dtype: String(source.authorityTriviumDtype ?? source.triviumDtype ?? "").trim(),
    syncMode: String(source.authorityTriviumSyncMode ?? source.triviumSyncMode ?? "").trim(),
    storageMode: String(source.authorityTriviumStorageMode ?? source.triviumStorageMode ?? "").trim(),
    embeddingMode,
    embeddingSource,
    apiUrl: normalizeOpenAICompatibleBaseUrl(
      embeddingMode === "backend"
        ? source.embeddingBackendApiUrl
        : source.authorityEmbeddingApiUrl ?? source.embeddingApiUrl ?? source.embeddingBackendApiUrl,
    ),
    apiKey: embeddingMode === "backend"
      ? ""
      : String(source.authorityEmbeddingApiKey ?? source.embeddingApiKey ?? "").trim(),
    model: embeddingMode === "backend"
      ? String(source.embeddingBackendModel ?? source.embeddingModel ?? "").trim()
      : String(source.authorityEmbeddingModel ?? source.embeddingModel ?? source.embeddingBackendModel ?? "").trim(),
    autoSuffix: source.embeddingAutoSuffix !== false,
    chunkSize: clampInteger(
      source.authorityVectorSyncChunkSize ?? source.chunkSize,
      DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE,
      1,
      MAX_AUTHORITY_VECTOR_CHUNK_SIZE,
    ),
    purgePageSize: clampInteger(
      source.authorityTriviumPurgePageSize ?? source.authorityVectorPurgePageSize,
      DEFAULT_AUTHORITY_PURGE_PAGE_SIZE,
      1,
      1000,
    ),
    purgeMaxPages: clampInteger(
      source.authorityTriviumPurgeMaxPages ?? source.authorityVectorPurgeMaxPages,
      DEFAULT_AUTHORITY_PURGE_MAX_PAGES,
      1,
      100000,
    ),
    timeoutMs: Math.max(0, Number(source.timeoutMs || 0) || 0),
    failOpen: source.authorityVectorFailOpen !== false && source.failOpen !== false,
    ...overrides,
  };
}

export class AuthorityTriviumHttpClient {
  constructor(options = {}) {
    this.baseUrl = normalizeAuthorityBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.headerProvider = typeof options.headerProvider === "function" ? options.headerProvider : null;
    this.protocol = AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06;
    this.config = {
      database: normalizeRecordId(options.database) || DEFAULT_AUTHORITY_TRIVIUM_DATABASE,
      dim: normalizePositiveInteger(options.dim, 0),
      dtype: String(options.dtype || "").trim(),
      syncMode: String(options.syncMode || "").trim(),
      storageMode: String(options.storageMode || "").trim(),
      purgePageSize: clampInteger(options.purgePageSize, DEFAULT_AUTHORITY_PURGE_PAGE_SIZE, 1, 1000),
      purgeMaxPages: clampInteger(options.purgeMaxPages, DEFAULT_AUTHORITY_PURGE_MAX_PAGES, 1, 100000),
    };
    this.http = new AuthorityHttpClient({
      ...options,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      headerProvider: this.headerProvider,
      protocol: this.protocol,
    });
  }

  async request(action, payload = {}) {
    if (action === "purge") return await this.purge(payload);
    if (action === "bulkUpsert") return await this.bulkUpsert(payload);
    if (action === "deleteMany") return await this.deleteMany(payload);
    if (action === "linkMany") return await this.linkMany(payload);
    if (action === "search") return await this.search(payload);
    if (action === "filterWhere") return await this.filterWhere(payload);
    if (action === "queryPage") return await this.queryPage(payload);
    if (action === "neighbors") return await this.neighbors(payload);
    if (action === "stat") return await this.stat(payload);
    throw new Error(`Authority Trivium v0.6 action unavailable: ${action}`);
  }

  async requestV06(path, payload = {}, method = "POST") {
    return await this.http.requestJson(path, {
      method,
      body: payload,
      session: true,
      protocol: AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06,
    });
  }

  buildOpenOptions(payload = {}) {
    return buildOpenOptions(this.config, payload);
  }

  async purge(payload = {}) {
    const namespace = getNamespace(payload);
    const openOptions = this.buildOpenOptions(payload);
    const pageSize = clampInteger(
      payload.pageSize ?? payload.limit ?? payload.purgePageSize ?? this.config.purgePageSize,
      DEFAULT_AUTHORITY_PURGE_PAGE_SIZE,
      1,
      1000,
    );
    const maxPages = clampInteger(
      payload.maxPages ?? payload.purgeMaxPages ?? this.config.purgeMaxPages,
      DEFAULT_AUTHORITY_PURGE_MAX_PAGES,
      1,
      100000,
    );
    const startedAt = nowMs();
    let cursor = "";
    let deleted = 0;
    let scanned = 0;
    let pages = 0;
    let truncated = false;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await this.requestV06("/trivium/list-mappings", {
        ...openOptions,
        namespace,
        page: {
          ...(cursor ? { cursor } : {}),
          limit: pageSize,
        },
      });
      pages += 1;
      const mappings = toArray(page?.mappings);
      if (!mappings.length && !page?.page?.hasMore) break;
      scanned += mappings.length;
      const items = mappings
        .map((item) => buildNodeReference(item?.externalId, item?.namespace || namespace))
        .filter((item) => item.externalId);
      if (items.length) {
        const result = await this.requestV06("/trivium/bulk-delete", {
          ...openOptions,
          items,
        });
        deleted += Number(result?.successCount ?? items.length) || 0;
      }
      if (!page?.page?.hasMore) break;
      cursor = String(page?.page?.nextCursor || "");
      if (!cursor) break;
      if (pageIndex === maxPages - 1) truncated = true;
    }
    return {
      ok: !truncated,
      scanned,
      deleted,
      pages,
      truncated,
      nextCursor: truncated ? cursor : "",
      diagnostics: {
        operation: "purge",
        namespace,
        pageSize,
        maxPages,
        pages,
        scanned,
        deleted,
        truncated,
        nextCursor: truncated ? cursor : "",
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  async bulkUpsert(payload = {}) {
    const namespace = getNamespace(payload);
    const items = toArray(payload.items);
    const missingVector = items.find((item) => !normalizeVector(item?.vector || item?.embedding).length);
    if (missingVector) {
      throw new Error("Authority Trivium v0.6 bulkUpsert requires vector for every item");
    }
    const mappedItems = items.map((item) => {
      const nodeId = normalizeRecordId(item?.externalId || item?.nodeId || item?.id);
      const payloadSource = buildV06PayloadSource(item?.payload);
      return {
        externalId: nodeId,
        namespace,
        vector: normalizeVector(item?.vector || item?.embedding),
        payload: {
          ...payloadSource,
          nodeId: payloadSource.nodeId || nodeId,
          externalId: payloadSource.externalId || nodeId,
          collectionId: payload.collectionId || payloadSource.collectionId || "",
          text: payloadSource.text || item?.text || "",
          contentHash: payloadSource.contentHash || item?.hash || "",
          index: Number(item?.index || payloadSource.index || 0) || 0,
        },
      };
    });
    return await this.requestV06("/trivium/bulk-upsert", {
      ...this.buildOpenOptions(payload),
      items: mappedItems,
    });
  }

  async deleteMany(payload = {}) {
    const namespace = getNamespace(payload);
    const ids = [
      ...toArray(payload.ids),
      ...toArray(payload.externalIds),
      ...toArray(payload.items).map((item) => item?.externalId || item?.nodeId || item?.id),
    ].map(normalizeRecordId).filter(Boolean);
    return await this.requestV06("/trivium/bulk-delete", {
      ...this.buildOpenOptions(payload),
      items: ids.map((id) => buildNodeReference(id, namespace)),
    });
  }

  async linkMany(payload = {}) {
    const namespace = getNamespace(payload);
    const sourceLinks = toArray(payload.links || payload.items);
    return await this.requestV06("/trivium/bulk-link", {
      ...this.buildOpenOptions(payload),
      items: sourceLinks
        .map((link) => {
          const src = normalizeRecordId(link?.fromId || link?.src || link?.sourceId);
          const dst = normalizeRecordId(link?.toId || link?.dst || link?.targetId);
          if (!src || !dst) return null;
          return {
            src: buildNodeReference(src, namespace),
            dst: buildNodeReference(dst, namespace),
            label: String(link?.relation || link?.label || "related"),
            weight: Number(link?.weight ?? link?.strength ?? 1) || 1,
          };
        })
        .filter(Boolean),
    });
  }

  async search(payload = {}) {
    const vector = normalizeVector(payload.vector || payload.embedding || payload.queryVector);
    if (!vector.length) {
      throw new Error("Authority Trivium v0.6 search requires vector");
    }
    const queryText = String(payload.queryText || payload.text || payload.searchText || payload.query || "");
    const body = {
      ...this.buildOpenOptions(payload),
      vector,
      topK: Number(payload.topK || payload.limit || 0) || undefined,
      expandDepth: Number(payload.expandDepth || payload.depth || 0) || undefined,
      minScore: Number.isFinite(Number(payload.minScore)) ? Number(payload.minScore) : undefined,
      ...(payload.payloadFilter || payload.filter ? { payloadFilter: payload.payloadFilter || payload.filter } : {}),
    };
    if (queryText) {
      return await this.requestV06("/trivium/search-hybrid", {
        ...body,
        queryText,
        hybridAlpha: Number.isFinite(Number(payload.hybridAlpha)) ? Number(payload.hybridAlpha) : undefined,
      });
    }
    return await this.requestV06("/trivium/search", body);
  }

  async filterWhere(payload = {}) {
    const namespace = getNamespace(payload);
    const filters = payload.filters || payload.filter || payload.where || null;
    const payloadFilter = payload.payloadFilter || filters;
    const candidateIds = toArray(payload.candidateIds).map(normalizeRecordId).filter(Boolean);
    const query = String(payload.query || payload.searchText || "").trim();
    const result = await this.requestV06("/trivium/list-mappings", {
      ...this.buildOpenOptions(payload),
      namespace,
      page: {
        ...(payload.cursor ? { cursor: String(payload.cursor) } : {}),
        limit: Number(payload.limit || payload.topK || payload.pageSize || 100) || 100,
      },
      ...(hasPlainKeys(filters) ? { filters, where: filters } : {}),
      ...(hasPlainKeys(payloadFilter) ? { payloadFilter } : {}),
      ...(candidateIds.length ? { candidateIds } : {}),
      ...(query ? { query, searchText: query } : {}),
    });
    return { items: toArray(result?.mappings) };
  }

  async queryPage(payload = {}) {
    return await this.filterWhere(payload);
  }

  async neighbors(payload = {}) {
    const namespace = getNamespace(payload);
    const seedIds = [
      ...toArray(payload.ids),
      ...toArray(payload.nodeIds),
      ...toArray(payload.seedIds),
      payload.id,
    ].map(normalizeRecordId).filter(Boolean);
    const openOptions = this.buildOpenOptions(payload);
    const resolved = await this.requestV06("/trivium/resolve-many", {
      ...openOptions,
      items: seedIds.map((id) => buildNodeReference(id, namespace)),
    });
    const neighbors = [];
    for (const item of toArray(resolved?.items)) {
      const internalId = Number(item?.id);
      if (!Number.isFinite(internalId) || internalId <= 0) continue;
      const result = await this.requestV06("/trivium/neighbors", {
        ...openOptions,
        id: internalId,
        depth: Number(payload.depth || payload.expandDepth || 1) || 1,
      });
      for (const node of toArray(result?.nodes)) {
        neighbors.push({
          externalId: node?.externalId,
          nodeId: node?.externalId,
          id: node?.id,
          namespace: node?.namespace,
        });
      }
    }
    return { neighbors };
  }

  async stat(payload = {}) {
    return await this.requestV06("/trivium/stat", {
      ...this.buildOpenOptions(payload),
      ...(payload.includeMappingIntegrity ? { includeMappingIntegrity: true } : {}),
    });
  }
}

export function createAuthorityTriviumClient(config = {}, options = {}) {
  const injected = options.triviumClient || config.triviumClient || globalThis.__stBmeAuthorityTriviumClient;
  if (injected) return injected;
  return new AuthorityTriviumHttpClient({
    ...config,
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl || config.fetchImpl,
    headerProvider: options.headerProvider || config.headerProvider,
    protocol: config.protocol,
    sessionToken: options.sessionToken || config.sessionToken,
    sessionInitConfig: options.sessionInitConfig || config.sessionInitConfig,
  });
}

async function callClient(client, methodNames = [], action = "request", payload = {}) {
  for (const methodName of methodNames) {
    if (typeof client?.[methodName] === "function") {
      return await client[methodName](payload);
    }
  }
  if (typeof client?.request === "function") {
    return await client.request(action, payload);
  }
  if (typeof client === "function") {
    return await client({ action, ...payload });
  }
  throw new Error(`Authority Trivium ${action} unavailable`);
}

export async function purgeAuthorityTriviumNamespace(config = {}, options = {}) {
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  return await callClient(client, ["purge"], "purge", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    purgePageSize: options.purgePageSize,
    purgeMaxPages: options.purgeMaxPages,
  });
}

export async function deleteAuthorityTriviumNodes(config = {}, nodeIds = [], options = {}) {
  const ids = toArray(nodeIds).map(normalizeRecordId).filter(Boolean);
  if (!ids.length) {
    return {
      deleted: 0,
      diagnostics: {
        operation: "deleteMany",
        requested: 0,
        deleted: 0,
        totalMs: 0,
      },
    };
  }
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const startedAt = nowMs();
  const result = await callClient(client, ["deleteMany", "deleteNodes"], "deleteMany", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    ids,
    externalIds: ids,
  });
  return {
    ...result,
    deleted: Number(result?.deleted ?? result?.successCount ?? ids.length) || 0,
    diagnostics: {
      operation: "deleteMany",
      requested: ids.length,
      deleted: Number(result?.deleted ?? result?.successCount ?? ids.length) || 0,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}

export async function filterAuthorityTriviumNodes(config = {}, options = {}) {
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const payload = await callClient(
    client,
    ["filterWhere", "queryPage", "query"],
    "filterWhere",
    {
      namespace: options.namespace,
      collectionId: options.collectionId,
      chatId: options.chatId,
      limit: Number(options.limit || options.topK || 0) || undefined,
      topK: Number(options.topK || options.limit || 0) || undefined,
      pageSize: Number(options.limit || options.topK || 0) || undefined,
      filters: options.filters,
      filter: options.filter,
      where: options.where,
      query: String(options.query || options.searchText || ""),
      searchText: String(options.searchText || options.query || ""),
      candidateIds: toArray(options.candidateIds).map(normalizeRecordId).filter(Boolean),
    },
  );
  return normalizeNodeIdRows(payload);
}

export async function upsertAuthorityTriviumEntries(graph, config = {}, entries = [], options = {}) {
  const items = buildAuthorityVectorItems(graph, entries, options);
  if (!items.length) {
    return {
      upserted: 0,
      diagnostics: {
        operation: "bulkUpsert",
        totalItems: 0,
        chunkSize: 0,
        chunks: [],
        totalBytes: 0,
        totalMs: 0,
      },
    };
  }
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const chunkSize = clampInteger(config.chunkSize, DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE, 1, MAX_AUTHORITY_VECTOR_CHUNK_SIZE);
  let upserted = 0;
  let totalBytes = 0;
  const chunks = [];
  const startedAt = nowMs();
  for (let index = 0; index < items.length; index += chunkSize) {
    throwIfAborted(options.signal);
    const chunk = items.slice(index, index + chunkSize);
    const chunkStartedAt = nowMs();
    const estimatedBytes = estimateJsonBytes(chunk);
    totalBytes += estimatedBytes;
    try {
      const result = await callClient(client, ["bulkUpsert", "upsertMany", "upsert"], "bulkUpsert", {
        namespace: options.namespace,
        collectionId: options.collectionId,
        chatId: options.chatId,
        items: chunk,
      });
      const successCount = Number(result?.successCount ?? result?.upserted ?? chunk.length) || chunk.length;
      upserted += successCount;
      chunks.push({
        index: chunks.length,
        offset: index,
        itemCount: chunk.length,
        upserted: successCount,
        vectorDim: normalizeVector(chunk[0]?.vector || chunk[0]?.embedding).length,
        estimatedBytes,
        durationMs: roundMs(nowMs() - chunkStartedAt),
        ok: true,
      });
    } catch (error) {
      chunks.push({
        index: chunks.length,
        offset: index,
        itemCount: chunk.length,
        upserted: 0,
        vectorDim: normalizeVector(chunk[0]?.vector || chunk[0]?.embedding).length,
        estimatedBytes,
        durationMs: roundMs(nowMs() - chunkStartedAt),
        ok: false,
        error: error?.message || String(error),
      });
      error.authorityDiagnostics = {
        operation: "bulkUpsert",
        totalItems: items.length,
        chunkSize,
        chunks,
        totalBytes,
        totalMs: roundMs(nowMs() - startedAt),
      };
      throw error;
    }
  }
  return {
    upserted,
    diagnostics: {
      operation: "bulkUpsert",
      totalItems: items.length,
      chunkSize,
      chunks,
      totalBytes,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}

export async function syncAuthorityTriviumLinks(graph, config = {}, options = {}) {
  const links = buildAuthorityLinkItems(graph, options);
  if (!links.length) {
    return {
      linked: 0,
      diagnostics: {
        operation: "linkMany",
        totalItems: 0,
        estimatedBytes: 0,
        totalMs: 0,
      },
    };
  }
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const startedAt = nowMs();
  const estimatedBytes = estimateJsonBytes(links);
  const result = await callClient(client, ["linkMany", "upsertLinks"], "linkMany", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    links,
  });
  const linked = Number(result?.linked ?? result?.successCount ?? links.length) || links.length;
  return {
    ...result,
    linked,
    diagnostics: {
      operation: "linkMany",
      totalItems: links.length,
      linked,
      estimatedBytes,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}

export async function queryAuthorityTriviumNeighbors(config = {}, nodeIds = [], options = {}) {
  const ids = toArray(nodeIds).map(normalizeRecordId).filter(Boolean);
  if (!ids.length) return [];
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const payload = await callClient(
    client,
    ["neighbors", "queryLinks", "queryNeighbors"],
    "neighbors",
    {
      namespace: options.namespace,
      collectionId: options.collectionId,
      chatId: options.chatId,
      ids,
      nodeIds: ids,
      seedIds: ids,
      limit: Number(options.limit || options.topK || 0) || undefined,
      topK: Number(options.topK || options.limit || 0) || undefined,
      candidateIds: toArray(options.candidateIds).map(normalizeRecordId).filter(Boolean),
    },
  );
  return normalizeNeighborNodeIds(payload, ids);
}

export async function searchAuthorityTriviumNodes(graph, text, config = {}, options = {}) {
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const payload = await callClient(client, ["search", "query"], "search", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    text: String(text || ""),
    searchText: String(text || ""),
    vector: normalizeVector(options.vector || options.queryVector || options.embedding),
    queryVector: normalizeVector(options.queryVector || options.vector || options.embedding),
    topK: Math.max(1, Math.floor(Number(options.topK) || 1)),
    candidateIds: toArray(options.candidateIds).map(normalizeRecordId).filter(Boolean),
  });
  return normalizeSearchResults(payload);
}

export async function testAuthorityTriviumConnection(config = {}, options = {}) {
  const probeVector = await embedText("test connection", config, { isQuery: true });
  if (!probeVector || probeVector.length === 0) {
    return { success: false, dimensions: 0, error: "Embedding API 返回空结果" };
  }
  const client = createAuthorityTriviumClient(config, options);
  await callClient(client, ["stat"], "stat", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
  });
  return { success: true, dimensions: probeVector.length, error: "" };
}
