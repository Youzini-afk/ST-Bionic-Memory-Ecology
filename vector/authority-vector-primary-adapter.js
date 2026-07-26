import { createAuthorityHttpClient } from "../runtime/authority-http-client.js";
import { deriveVectorSpace } from "./vector-space.js";

export const AUTHORITY_VECTOR_MODE = "authority";
export const AUTHORITY_VECTOR_SOURCE = "authority-trivium";
const MODULE_ID = "third-party.st-bme";

function text(value) {
  return String(value ?? "").trim();
}

function finiteVector(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const vector = value.map(Number);
  return vector.every(Number.isFinite) ? vector : [];
}

function getClient(config, options = {}) {
  const client = options.triviumClient || config.authorityClient || config.client;
  if (client?.requestModuleTransaction) return client;
  return createAuthorityHttpClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    fetchImpl: options.fetchImpl,
    headerProvider: options.headerProvider,
    version: "9.0.0",
  });
}

async function request(config, transaction, input, options = {}) {
  const response = await getClient(config, options).requestModuleTransaction(
    MODULE_ID,
    transaction,
    input,
    {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    },
  );
  const result = response?.result ?? response;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`Authority ${transaction} response is invalid`);
  }
  if (result.ok === false) throw new Error(result.error?.message || `Authority ${transaction} failed`);
  return result;
}

export function isAuthorityVectorConfig(config = null) {
  return config?.mode === AUTHORITY_VECTOR_MODE || config?.source === AUTHORITY_VECTOR_SOURCE;
}

export function normalizeAuthorityVectorConfig(settings = {}, overrides = {}) {
  const embeddingMode = text(
    overrides.embeddingMode || settings.embeddingMode || settings.embeddingAuthorityMode || "backend",
  ).toLowerCase();
  return {
    mode: AUTHORITY_VECTOR_MODE,
    source: AUTHORITY_VECTOR_SOURCE,
    baseUrl: text(overrides.baseUrl || settings.authorityBaseUrl || "/api/plugins/authority"),
    embeddingMode: embeddingMode === "direct" ? "direct" : "backend",
    embeddingSource: text(
      overrides.embeddingSource || settings.embeddingSource || settings.embeddingBackendSource || "openai",
    ).toLowerCase(),
    apiUrl: text(overrides.apiUrl || settings.embeddingApiUrl || settings.embeddingBackendApiUrl),
    apiKey: text(overrides.apiKey || settings.embeddingApiKey),
    model: text(overrides.model || settings.embeddingModel || settings.embeddingBackendModel),
    dimensions: Number(overrides.dimensions ?? settings.embeddingDimensions) || undefined,
    embeddingBatchSize: Number(
      overrides.embeddingBatchSize ?? settings.embeddingBatchSize,
    ) || undefined,
    timeoutMs: Number(overrides.timeoutMs ?? settings.timeoutMs) || 300000,
    authorityClient: overrides.authorityClient || settings.authorityClient || null,
  };
}

function buildNodePayload(node, entry) {
  const scope = node?.scope && typeof node.scope === "object" ? node.scope : {};
  const seqRange = Array.isArray(node?.seqRange)
    ? node.seqRange
    : [node?.seq ?? 0, node?.seq ?? 0];
  return {
    type: text(node?.type),
    archived: Boolean(node?.archived),
    seqStart: Number(seqRange[0]) || 0,
    seqEnd: Number(seqRange[1]) || 0,
    importance: Number(node?.importance) || 0,
    scopeLayer: text(scope.layer),
    scopeOwnerType: text(scope.ownerType),
    scopeOwnerId: text(scope.ownerId),
    scopeOwnerName: text(scope.ownerName),
    scopeBucket: text(scope.bucket),
    regionKey: text(scope.regionKey || node?.regionKey),
    storySegmentId: text(node?.storySegmentId || node?.storyTime?.segmentId),
    storyTimeLabel: text(node?.storyTime?.label),
    text: String(entry.text || ""),
    contentHash: text(entry.hash),
    index: Number(entry.index) || 0,
  };
}

function vectorSpaceFor(config, observedDim) {
  return deriveVectorSpace(config, observedDim, {
    providerKind: config.embeddingMode === "backend"
      ? "st-backend"
      : "direct-openai-compatible",
    embeddingMode: "client",
    apiUrl: config.apiUrl,
  });
}

export async function applyAuthorityBmeVectorManifest(
  graph,
  config = {},
  entries = [],
  options = {},
) {
  if (!isAuthorityVectorConfig(config)) throw new TypeError("Authority vector config is required");
  const nodes = new Map((graph?.nodes || []).map((node) => [String(node?.id || ""), node]));
  let observedDim = 0;
  const items = entries.map((entry, index) => {
    const nodeId = text(entry?.nodeId);
    const node = nodes.get(nodeId);
    if (!node) throw new TypeError(`missing vector node ${nodeId || index}`);
    const vector = finiteVector(entry?.vector || entry?.embedding || node.embedding);
    if (!vector.length) throw new TypeError(`missing embedding for vector node ${nodeId}`);
    if (!observedDim) observedDim = vector.length;
    if (vector.length !== observedDim) throw new TypeError("vector dimensions must match");
    return {
      externalId: nodeId,
      vector,
      text: String(entry.text || ""),
      hash: text(entry.hash),
      index: Number(entry.index) || 0,
      payload: buildNodePayload(node, entry),
    };
  });
  if (!observedDim) {
    observedDim = Math.max(
      0,
      Number(graph?.vectorIndexState?.manifest?.observedDim || config.dimensions || 0),
    );
  }
  const vectorSpace = observedDim > 0 ? vectorSpaceFor(config, observedDim) : null;
  const itemIds = new Set(items.map(({ externalId }) => externalId));
  const links = (graph?.edges || []).flatMap((edge) => {
    const fromId = text(edge?.fromId || edge?.sourceId || edge?.from);
    const toId = text(edge?.toId || edge?.targetId || edge?.to);
    if (
      !fromId ||
      !toId ||
      !itemIds.has(fromId) ||
      !itemIds.has(toId) ||
      edge?.invalidAt ||
      edge?.expiredAt ||
      edge?.deletedAt
    ) return [];
    return [{
      fromId,
      toId,
      relation: text(edge?.relation || edge?.type) || "related",
      weight: Number(edge?.strength ?? edge?.weight ?? 1) || 1,
    }];
  });
  const payload = {
    collectionId: text(options.collectionId || options.namespace),
    chatId: text(options.chatId || graph?.historyState?.chatId),
    graphRevision: Math.max(0, Math.trunc(Number(options.revision ?? graph?.revision) || 0)),
    modelScope: text(options.modelScope || graph?.vectorIndexState?.modelScope),
    vectorSpaceId: vectorSpace?.vectorSpaceId || "",
    observedDim,
    items,
    links,
  };
  if (!payload.collectionId || !payload.chatId || !payload.modelScope) {
    throw new TypeError("Authority vector apply requires collectionId, chatId, and modelScope");
  }
  const result = await request(config, "vector.apply", payload, {
    ...options,
    idempotencyKey: options.idempotencyKey || [
      "vector",
      payload.chatId,
      payload.graphRevision,
      payload.modelScope,
      payload.vectorSpaceId || "empty",
    ].join(":"),
  });
  return {
    ...result,
    diagnostics: {
      operation: "vector.apply",
      totalItems: items.length,
      linkItems: links.length,
      upserted: Number(result.upsert?.successCount || 0),
      linked: Number(result.links?.successCount || 0),
      manifest: result.manifest || null,
    },
  };
}

export async function fetchAuthorityBmeVectorManifest(config = {}, options = {}) {
  return await request(config, "vector.manifest", {
    collectionId: text(options.collectionId || options.namespace),
    includeMappingIntegrity: Boolean(options.includeMappingIntegrity),
  }, options);
}

export async function searchAuthorityTriviumNodes(graph, queryText, config = {}, options = {}) {
  const vector = finiteVector(options.queryVector);
  if (!vector.length) throw new TypeError("Authority candidate search requires queryVector");
  const manifest = graph?.vectorIndexState?.manifest || {};
  const collectionId = text(options.collectionId || options.namespace || graph?.vectorIndexState?.collectionId);
  const candidateIds = [...new Set((options.candidateIds || []).map(text).filter(Boolean))];
  const payloadFilter = candidateIds.length
    ? { nodeId: { $in: candidateIds } }
    : undefined;
  const result = await request(config, "recall.candidates", {
    collectionId,
    chatId: text(options.chatId || graph?.historyState?.chatId),
    graphRevision: Math.max(0, Math.trunc(Number(options.revision ?? graph?.revision) || 0)),
    modelScope: text(options.modelScope || graph?.vectorIndexState?.modelScope),
    vectorSpaceId: text(options.vectorSpaceId || manifest.vectorSpaceId),
    observedDim: Math.max(0, Math.trunc(Number(options.observedDim || manifest.observedDim || vector.length))),
    queryTexts: [String(queryText || "")],
    queryVectors: [vector],
    topK: Math.max(1, Math.trunc(Number(options.topK) || 10)),
    expandDepth: Math.max(0, Math.trunc(Number(options.expandDepth) || 0)),
    ...(payloadFilter ? { payloadFilter } : {}),
  }, options);
  return (result.candidates || []).map((candidate) => ({
    nodeId: text(candidate.externalId),
    score: Math.max(0, Number(candidate.score) || 0),
    source: text(candidate.source) || "search",
  }));
}

export async function testAuthorityTriviumConnection(config = {}, options = {}) {
  const result = await fetchAuthorityBmeVectorManifest(config, options);
  return {
    success: true,
    dimensions: Number(result.manifest?.observedDim || 0),
    vectorStoreCapable: true,
    vectorManifest: result.manifest || null,
    error: "",
  };
}
