import { normalizeAuthorityBaseUrl } from "../runtime/authority-capabilities.js";

export const AUTHORITY_VECTOR_MODE = "authority";
export const AUTHORITY_VECTOR_SOURCE = "authority-trivium";

const AUTHORITY_TRIVIUM_ENDPOINT = "/v1/trivium";
const DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE = 1000;
const MAX_AUTHORITY_VECTOR_CHUNK_SIZE = 2000;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.hits)
        ? payload.hits
        : Array.isArray(payload?.items)
          ? payload.items
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
  return rows
    .map((item, index) => {
      const nodeId = normalizeRecordId(
        item?.nodeId || item?.externalId || item?.id || item?.payload?.nodeId,
      );
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
  return {
    mode: AUTHORITY_VECTOR_MODE,
    source: AUTHORITY_VECTOR_SOURCE,
    baseUrl: normalizeAuthorityBaseUrl(source.authorityBaseUrl ?? source.baseUrl),
    model: String(source.embeddingBackendModel || source.embeddingModel || "").trim(),
    chunkSize: clampInteger(
      source.authorityVectorSyncChunkSize ?? source.chunkSize,
      DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE,
      1,
      MAX_AUTHORITY_VECTOR_CHUNK_SIZE,
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
  }

  async request(action, payload = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Authority Trivium fetch unavailable");
    }
    const response = await this.fetchImpl(`${this.baseUrl}${AUTHORITY_TRIVIUM_ENDPOINT}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.headerProvider ? this.headerProvider() || {} : {}),
      },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!response?.ok) {
      throw new Error(`Authority Trivium HTTP ${response?.status || "unknown"}`);
    }
    return await response.json().catch(() => ({}));
  }

  async purge(payload = {}) {
    return await this.request("purge", payload);
  }

  async bulkUpsert(payload = {}) {
    return await this.request("bulkUpsert", payload);
  }

  async deleteMany(payload = {}) {
    return await this.request("deleteMany", payload);
  }

  async linkMany(payload = {}) {
    return await this.request("linkMany", payload);
  }

  async search(payload = {}) {
    return await this.request("search", payload);
  }

  async stat(payload = {}) {
    return await this.request("stat", payload);
  }
}

export function createAuthorityTriviumClient(config = {}, options = {}) {
  const injected = options.triviumClient || config.triviumClient || globalThis.__stBmeAuthorityTriviumClient;
  if (injected) return injected;
  return new AuthorityTriviumHttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl || config.fetchImpl,
    headerProvider: options.headerProvider || config.headerProvider,
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
  });
}

export async function deleteAuthorityTriviumNodes(config = {}, nodeIds = [], options = {}) {
  const ids = toArray(nodeIds).map(normalizeRecordId).filter(Boolean);
  if (!ids.length) return { deleted: 0 };
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  return await callClient(client, ["deleteMany", "deleteNodes"], "deleteMany", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    ids,
    externalIds: ids,
  });
}

export async function upsertAuthorityTriviumEntries(graph, config = {}, entries = [], options = {}) {
  const items = buildAuthorityVectorItems(graph, entries, options);
  if (!items.length) return { upserted: 0 };
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  const chunkSize = clampInteger(config.chunkSize, DEFAULT_AUTHORITY_VECTOR_CHUNK_SIZE, 1, MAX_AUTHORITY_VECTOR_CHUNK_SIZE);
  let upserted = 0;
  for (let index = 0; index < items.length; index += chunkSize) {
    throwIfAborted(options.signal);
    const chunk = items.slice(index, index + chunkSize);
    await callClient(client, ["bulkUpsert", "upsertMany", "upsert"], "bulkUpsert", {
      namespace: options.namespace,
      collectionId: options.collectionId,
      chatId: options.chatId,
      items: chunk,
    });
    upserted += chunk.length;
  }
  return { upserted };
}

export async function syncAuthorityTriviumLinks(graph, config = {}, options = {}) {
  const links = buildAuthorityLinkItems(graph, options);
  if (!links.length) return { linked: 0 };
  throwIfAborted(options.signal);
  const client = createAuthorityTriviumClient(config, options);
  await callClient(client, ["linkMany", "upsertLinks"], "linkMany", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
    links,
  });
  return { linked: links.length };
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
    topK: Math.max(1, Math.floor(Number(options.topK) || 1)),
    candidateIds: toArray(options.candidateIds).map(normalizeRecordId).filter(Boolean),
  });
  return normalizeSearchResults(payload);
}

export async function testAuthorityTriviumConnection(config = {}, options = {}) {
  const client = createAuthorityTriviumClient(config, options);
  await callClient(client, ["stat"], "stat", {
    namespace: options.namespace,
    collectionId: options.collectionId,
    chatId: options.chatId,
  });
  return { success: true, dimensions: 0, error: "" };
}
