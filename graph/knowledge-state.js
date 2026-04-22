import {
  getScopeOwnerKey,
  getScopeRegionKey,
  normalizeMemoryScope,
} from "./memory-scope.js";
import {
  aliasSetMatchesValue,
  buildUserPovAliasNormalizedSet,
  collectAliasMatchVariants,
  getHostUserAliasHints,
} from "../runtime/user-alias-utils.js";

export const KNOWLEDGE_STATE_VERSION = 1;
export const REGION_STATE_VERSION = 1;

const OWNER_TYPE_CHARACTER = "character";
const OWNER_TYPE_USER = "user";
const KNOWLEDGE_OWNER_PREFIX = {
  [OWNER_TYPE_CHARACTER]: "character",
  [OWNER_TYPE_USER]: "user",
};

const DEFAULT_VISIBILITY_SCORE = 0;
const KNOWLEDGE_ENTRY_LIMIT = 512;
const RECENT_REGION_LIMIT = 8;
const RECENT_RECALL_OWNER_LIMIT = 8;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase();
}

function clampScore(value, fallback = DEFAULT_VISIBILITY_SCORE) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeString(value);
    const key = normalizeKey(normalized);
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function uniqueIds(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.slice(0, KNOWLEDGE_ENTRY_LIMIT);
}

function buildExistingGraphNodeIdSet(graph) {
  const nodeIds = new Set();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const nodeId = normalizeString(node?.id);
    if (nodeId) nodeIds.add(nodeId);
  }
  return nodeIds;
}

function pruneKnowledgeOwnerNodeRefs(entry, graph = null) {
  const normalizedEntry = createDefaultKnowledgeOwnerState(entry);
  if (!graph || typeof graph !== "object") {
    return normalizedEntry;
  }

  const existingNodeIds = buildExistingGraphNodeIdSet(graph);
  const filterNodeIds = (values = []) =>
    uniqueIds(values).filter((nodeId) => existingNodeIds.has(nodeId));

  let ownerNodeId = normalizeString(normalizedEntry.nodeId);
  if (ownerNodeId && !existingNodeIds.has(ownerNodeId)) {
    const matches = findCharacterNodeByName(graph, normalizedEntry.ownerName);
    ownerNodeId = matches.length === 1 ? normalizeString(matches[0]?.id) : "";
  }

  const visibilityScores = {};
  for (const [nodeId, score] of Object.entries(
    normalizedEntry.visibilityScores || {},
  )) {
    const normalizedNodeId = normalizeString(nodeId);
    if (!normalizedNodeId || !existingNodeIds.has(normalizedNodeId)) continue;
    visibilityScores[normalizedNodeId] = clampScore(score);
  }

  return createDefaultKnowledgeOwnerState({
    ...normalizedEntry,
    nodeId: ownerNodeId,
    knownNodeIds: filterNodeIds(normalizedEntry.knownNodeIds),
    mistakenNodeIds: filterNodeIds(normalizedEntry.mistakenNodeIds),
    manualKnownNodeIds: filterNodeIds(normalizedEntry.manualKnownNodeIds),
    manualHiddenNodeIds: filterNodeIds(normalizedEntry.manualHiddenNodeIds),
    visibilityScores,
  });
}

function buildOwnerAliasVariantSet(values = []) {
  const variants = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    for (const variant of collectAliasMatchVariants(value)) {
      variants.add(variant);
    }
  }
  return variants;
}

function getKnowledgeOwnerAliasVariantSet(owner = {}) {
  return buildOwnerAliasVariantSet([
    owner?.ownerName,
    ...(Array.isArray(owner?.aliases) ? owner.aliases : []),
  ]);
}

function aliasVariantSetsOverlap(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set) || !left.size || !right.size) {
    return false;
  }
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function getKnowledgeOwnerEvidenceScore(owner = {}) {
  const knownCount = Number(
    owner?.knownCount ??
      owner?.knownNodeIds?.length ??
      0,
  );
  const mistakenCount = Number(
    owner?.mistakenCount ??
      owner?.mistakenNodeIds?.length ??
      0,
  );
  const manualKnownCount = Number(
    owner?.manualKnownCount ??
      owner?.manualKnownNodeIds?.length ??
      0,
  );
  const manualHiddenCount = Number(
    owner?.manualHiddenCount ??
      owner?.manualHiddenNodeIds?.length ??
      0,
  );
  return (
    (normalizeString(owner?.nodeId) ? 8 : 0) +
    knownCount * 4 +
    mistakenCount * 3 +
    manualKnownCount * 2 +
    manualHiddenCount * 2 +
    (Number(owner?.updatedAt || 0) > 0 ? 1 : 0)
  );
}

function findEquivalentCharacterOwnerEntry(
  ownerCollection,
  candidate = {},
  graph = null,
) {
  const normalizedCandidate = pruneKnowledgeOwnerNodeRefs(candidate, graph);
  if (normalizeOwnerType(normalizedCandidate?.ownerType) !== OWNER_TYPE_CHARACTER) {
    return null;
  }

  const candidateKey = normalizeString(normalizedCandidate?.ownerKey);
  const candidateNodeId = normalizeString(normalizedCandidate?.nodeId);
  const candidateAliasSet = getKnowledgeOwnerAliasVariantSet(normalizedCandidate);
  const matches = [];
  const values =
    ownerCollection instanceof Map
      ? ownerCollection.values()
      : Object.values(ownerCollection || {});

  for (const rawEntry of values) {
    const entry = pruneKnowledgeOwnerNodeRefs(rawEntry, graph);
    if (!entry.ownerKey || normalizeOwnerType(entry.ownerType) !== OWNER_TYPE_CHARACTER) {
      continue;
    }
    if (candidateKey && entry.ownerKey === candidateKey) continue;

    if (candidateNodeId && entry.nodeId && entry.nodeId === candidateNodeId) {
      matches.push({ entry, reason: "nodeId" });
      continue;
    }

    const entryAliasSet = getKnowledgeOwnerAliasVariantSet(entry);
    if (aliasVariantSetsOverlap(candidateAliasSet, entryAliasSet)) {
      matches.push({ entry, reason: "alias" });
    }
  }

  const nodeIdMatches = matches.filter((match) => match.reason === "nodeId");
  if (nodeIdMatches.length === 1) {
    return nodeIdMatches[0].entry;
  }
  if (nodeIdMatches.length > 1) {
    return [...nodeIdMatches]
      .sort(
        (left, right) =>
          getKnowledgeOwnerEvidenceScore(right.entry) -
          getKnowledgeOwnerEvidenceScore(left.entry),
      )[0]?.entry || null;
  }
  if (matches.length === 1) {
    return matches[0].entry;
  }
  if (matches.length > 1) {
    return [...matches]
      .sort(
        (left, right) =>
          getKnowledgeOwnerEvidenceScore(right.entry) -
          getKnowledgeOwnerEvidenceScore(left.entry),
      )[0]?.entry || null;
  }
  return null;
}

function mergeListedKnowledgeOwnerEntry(baseEntry, incomingEntry) {
  return {
    ...baseEntry,
    ownerName: normalizeString(baseEntry?.ownerName || incomingEntry?.ownerName),
    nodeId: normalizeString(baseEntry?.nodeId || incomingEntry?.nodeId),
    aliases: uniqueStrings([
      ...(baseEntry?.aliases || []),
      ...(incomingEntry?.aliases || []),
      incomingEntry?.ownerName || "",
      baseEntry?.ownerName || "",
    ]),
    knownCount: Math.max(
      Number(baseEntry?.knownCount || 0),
      Number(incomingEntry?.knownCount || 0),
    ),
    mistakenCount: Math.max(
      Number(baseEntry?.mistakenCount || 0),
      Number(incomingEntry?.mistakenCount || 0),
    ),
    manualKnownCount: Math.max(
      Number(baseEntry?.manualKnownCount || 0),
      Number(incomingEntry?.manualKnownCount || 0),
    ),
    manualHiddenCount: Math.max(
      Number(baseEntry?.manualHiddenCount || 0),
      Number(incomingEntry?.manualHiddenCount || 0),
    ),
    updatedAt: Math.max(
      Number(baseEntry?.updatedAt || 0),
      Number(incomingEntry?.updatedAt || 0),
    ),
    lastSource: normalizeString(
      baseEntry?.lastSource || incomingEntry?.lastSource,
    ),
  };
}

function normalizeOwnerType(ownerType = "") {
  const normalized = normalizeString(ownerType);
  if (normalized === OWNER_TYPE_CHARACTER) return OWNER_TYPE_CHARACTER;
  if (normalized === OWNER_TYPE_USER) return OWNER_TYPE_USER;
  return "";
}

function appendAliasHintStrings(target, value) {
  if (value == null) return;
  if (typeof value === "string") {
    const normalized = normalizeString(value);
    if (normalized) target.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendAliasHintStrings(target, item);
    return;
  }
  if (typeof value === "object") {
    appendAliasHintStrings(target, value.name1);
    appendAliasHintStrings(target, value.userName);
    appendAliasHintStrings(target, value.personaName);
    appendAliasHintStrings(target, value.name);
    appendAliasHintStrings(target, value.aliases);
  }
}

function buildUserAliasContext(graph = null, extraHints = []) {
  const aliasHints = [];
  appendAliasHintStrings(aliasHints, graph?.historyState?.activeUserPovOwner);
  appendAliasHintStrings(aliasHints, getHostUserAliasHints());
  appendAliasHintStrings(aliasHints, extraHints);
  const uniqueAliasHints = uniqueStrings(aliasHints);
  return {
    aliasHints: uniqueAliasHints,
    aliasSet: buildUserPovAliasNormalizedSet(uniqueAliasHints),
    preferredName: uniqueAliasHints[0] || "",
  };
}

function shouldResolveCharacterOwnerAsUser(
  graph,
  ownerName = "",
  nodeId = "",
  userAliasContext = null,
) {
  const normalizedOwnerName = normalizeString(ownerName);
  if (!normalizedOwnerName) return false;
  const aliasContext = userAliasContext || buildUserAliasContext(graph);
  if (!aliasSetMatchesValue(aliasContext.aliasSet, normalizedOwnerName)) {
    return false;
  }
  const normalizedNodeId = normalizeString(nodeId);
  if (normalizedNodeId) {
    const explicitNode = findCharacterNodeById(graph, normalizedNodeId);
    if (explicitNode) {
      return false;
    }
  }
  return true;
}

function getCharacterNodes(graph) {
  return Array.isArray(graph?.nodes)
    ? graph.nodes.filter(
        (node) =>
          node &&
          !node.archived &&
          node.type === "character" &&
          normalizeString(node?.fields?.name),
      )
    : [];
}

function buildCharacterNameCountMap(graph) {
  const counts = new Map();
  for (const node of getCharacterNodes(graph)) {
    const key = normalizeKey(node?.fields?.name);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function findCharacterNodeByName(graph, ownerName = "") {
  const normalizedOwnerName = normalizeKey(ownerName);
  if (!normalizedOwnerName) return [];
  return getCharacterNodes(graph).filter(
    (node) => normalizeKey(node?.fields?.name) === normalizedOwnerName,
  );
}

function findCharacterNodeById(graph, nodeId = "") {
  const normalizedNodeId = normalizeString(nodeId);
  if (!normalizedNodeId) return null;
  return getCharacterNodes(graph).find((node) => node.id === normalizedNodeId) || null;
}

function buildOwnerKey(ownerType, ownerNameOrId = "", nodeId = "", graph = null) {
  const normalizedOwnerType = normalizeOwnerType(ownerType);
  const normalizedOwnerNameOrId = normalizeKey(ownerNameOrId);
  if (!normalizedOwnerType || !normalizedOwnerNameOrId) return "";

  if (normalizedOwnerType === OWNER_TYPE_USER) {
    return `${KNOWLEDGE_OWNER_PREFIX[OWNER_TYPE_USER]}:${normalizedOwnerNameOrId}`;
  }

  const duplicateCounts = graph ? buildCharacterNameCountMap(graph) : new Map();
  const isDuplicated = (duplicateCounts.get(normalizedOwnerNameOrId) || 0) > 1;
  const normalizedNodeId = normalizeString(nodeId);
  if (isDuplicated && normalizedNodeId) {
    return `${KNOWLEDGE_OWNER_PREFIX[OWNER_TYPE_CHARACTER]}:${normalizedOwnerNameOrId}#${normalizedNodeId}`;
  }

  return `${KNOWLEDGE_OWNER_PREFIX[OWNER_TYPE_CHARACTER]}:${normalizedOwnerNameOrId}`;
}

export function createDefaultKnowledgeOwnerState(overrides = {}) {
  const ownerType = normalizeOwnerType(overrides.ownerType);
  const ownerName = normalizeString(overrides.ownerName);
  const nodeId = normalizeString(overrides.nodeId);
  const ownerKey =
    normalizeString(overrides.ownerKey) ||
    buildOwnerKey(ownerType, ownerName || overrides.ownerId, nodeId);

  const visibilityScores = {};
  if (
    overrides.visibilityScores &&
    typeof overrides.visibilityScores === "object" &&
    !Array.isArray(overrides.visibilityScores)
  ) {
    for (const [nodeIdKey, score] of Object.entries(overrides.visibilityScores)) {
      const normalizedNodeId = normalizeString(nodeIdKey);
      if (!normalizedNodeId) continue;
      visibilityScores[normalizedNodeId] = clampScore(score);
    }
  }

  return {
    ownerType,
    ownerKey,
    ownerName,
    nodeId,
    aliases: uniqueStrings(overrides.aliases || [ownerName]),
    knownNodeIds: uniqueIds(overrides.knownNodeIds),
    mistakenNodeIds: uniqueIds(overrides.mistakenNodeIds),
    visibilityScores,
    manualKnownNodeIds: uniqueIds(overrides.manualKnownNodeIds),
    manualHiddenNodeIds: uniqueIds(overrides.manualHiddenNodeIds),
    updatedAt: Number.isFinite(overrides.updatedAt) ? overrides.updatedAt : 0,
    lastSource: normalizeString(overrides.lastSource),
  };
}

export function createDefaultKnowledgeState(overrides = {}) {
  return {
    version: KNOWLEDGE_STATE_VERSION,
    owners:
      overrides.owners &&
      typeof overrides.owners === "object" &&
      !Array.isArray(overrides.owners)
        ? { ...overrides.owners }
        : {},
  };
}

function normalizeRegionAdjacencyEntry(regionName = "", entry = {}) {
  return {
    adjacent: uniqueStrings(entry.adjacent),
    aliases: uniqueStrings(entry.aliases),
    source: normalizeString(entry.source),
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    region: normalizeString(regionName),
  };
}

export function createDefaultRegionState(overrides = {}) {
  return {
    version: REGION_STATE_VERSION,
    adjacencyMap:
      overrides.adjacencyMap &&
      typeof overrides.adjacencyMap === "object" &&
      !Array.isArray(overrides.adjacencyMap)
        ? { ...overrides.adjacencyMap }
        : {},
    manualActiveRegion: normalizeString(overrides.manualActiveRegion),
    recentRegions: uniqueStrings(overrides.recentRegions).slice(0, RECENT_REGION_LIMIT),
  };
}

function mergeKnowledgeOwnerEntries(baseEntry, incomingEntry) {
  const merged = createDefaultKnowledgeOwnerState({
    ...baseEntry,
    ...incomingEntry,
    aliases: uniqueStrings([
      ...(baseEntry?.aliases || []),
      ...(incomingEntry?.aliases || []),
      incomingEntry?.ownerName || "",
      baseEntry?.ownerName || "",
    ]),
    knownNodeIds: uniqueIds([
      ...(baseEntry?.knownNodeIds || []),
      ...(incomingEntry?.knownNodeIds || []),
    ]),
    mistakenNodeIds: uniqueIds([
      ...(baseEntry?.mistakenNodeIds || []),
      ...(incomingEntry?.mistakenNodeIds || []),
    ]),
    manualKnownNodeIds: uniqueIds([
      ...(baseEntry?.manualKnownNodeIds || []),
      ...(incomingEntry?.manualKnownNodeIds || []),
    ]),
    manualHiddenNodeIds: uniqueIds([
      ...(baseEntry?.manualHiddenNodeIds || []),
      ...(incomingEntry?.manualHiddenNodeIds || []),
    ]),
    updatedAt: Math.max(
      Number(baseEntry?.updatedAt || 0),
      Number(incomingEntry?.updatedAt || 0),
    ),
    lastSource:
      normalizeString(incomingEntry?.lastSource) ||
      normalizeString(baseEntry?.lastSource),
  });

  const visibilityScores = {
    ...(baseEntry?.visibilityScores || {}),
  };
  for (const [nodeId, value] of Object.entries(incomingEntry?.visibilityScores || {})) {
    visibilityScores[nodeId] = Math.max(
      clampScore(visibilityScores[nodeId]),
      clampScore(value),
    );
  }
  merged.visibilityScores = visibilityScores;
  return merged;
}

function resolveCanonicalKnowledgeEntry(
  graph,
  ownerKey,
  entry,
  userAliasContext = null,
) {
  const normalizedEntry = pruneKnowledgeOwnerNodeRefs({
    ...entry,
    ownerKey,
  }, graph);
  const resolvedOwner = resolveKnowledgeOwner(graph, {
    ownerType: normalizedEntry.ownerType,
    ownerName: normalizedEntry.ownerName,
    ownerId: normalizedEntry.ownerName,
    nodeId: normalizedEntry.nodeId,
    aliases: normalizedEntry.aliases,
    userAliasContext,
  });
  return createDefaultKnowledgeOwnerState({
    ...normalizedEntry,
    ownerType: resolvedOwner.ownerType || normalizedEntry.ownerType,
    ownerKey: resolvedOwner.ownerKey || normalizedEntry.ownerKey,
    ownerName: resolvedOwner.ownerName || normalizedEntry.ownerName,
    nodeId: resolvedOwner.nodeId || normalizedEntry.nodeId,
    aliases: uniqueStrings([
      ...(normalizedEntry.aliases || []),
      ...(resolvedOwner.aliases || []),
      resolvedOwner.ownerName || "",
    ]),
  });
}

export function normalizeKnowledgeState(state = {}, graph = null) {
  const normalized = createDefaultKnowledgeState(state);
  const owners = {};
  const userAliasContext = buildUserAliasContext(graph);
  for (const [ownerKey, rawEntry] of Object.entries(normalized.owners || {})) {
    const canonicalEntry = resolveCanonicalKnowledgeEntry(
      graph,
      ownerKey,
      rawEntry,
      userAliasContext,
    );
    if (!canonicalEntry.ownerKey) continue;
    const equivalentEntry =
      owners[canonicalEntry.ownerKey] ||
      findEquivalentCharacterOwnerEntry(owners, canonicalEntry, graph);
    const targetKey = equivalentEntry?.ownerKey || canonicalEntry.ownerKey;
    owners[targetKey] = owners[targetKey]
      ? mergeKnowledgeOwnerEntries(owners[targetKey], canonicalEntry)
      : canonicalEntry;
  }
  return {
    version: KNOWLEDGE_STATE_VERSION,
    owners,
  };
}

export function normalizeRegionState(state = {}) {
  const normalized = createDefaultRegionState(state);
  const adjacencyMap = {};
  for (const [regionName, entry] of Object.entries(normalized.adjacencyMap || {})) {
    const normalizedRegion = normalizeString(regionName || entry?.region);
    if (!normalizedRegion) continue;
    adjacencyMap[normalizedRegion] = normalizeRegionAdjacencyEntry(
      normalizedRegion,
      entry,
    );
  }
  return {
    version: REGION_STATE_VERSION,
    adjacencyMap,
    manualActiveRegion: normalized.manualActiveRegion,
    recentRegions: uniqueStrings(normalized.recentRegions).slice(0, RECENT_REGION_LIMIT),
  };
}

export function normalizeGraphCognitiveState(graph) {
  if (!graph || typeof graph !== "object") return graph;
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  graph.regionState = normalizeRegionState(graph.regionState);
  return graph;
}

export function resolveKnowledgeOwner(graph, input = {}) {
  const ownerType = normalizeOwnerType(input.ownerType);
  if (!ownerType) {
    return {
      ownerType: "",
      ownerKey: "",
      ownerName: "",
      nodeId: "",
      aliases: [],
    };
  }

  const userAliasContext =
    input?.userAliasContext &&
    input.userAliasContext.aliasSet instanceof Set
      ? input.userAliasContext
      : buildUserAliasContext(graph);

  if (ownerType === OWNER_TYPE_USER) {
    const fallbackOwnerName = normalizeString(
      input.ownerName || input.ownerId || input.ownerKey,
    );
    const ownerName = userAliasContext.preferredName || fallbackOwnerName;
    return {
      ownerType,
      ownerKey: buildOwnerKey(ownerType, ownerName),
      ownerName,
      nodeId: "",
      aliases: uniqueStrings([
        ...(Array.isArray(input.aliases) ? input.aliases : [input.aliases]),
        ...userAliasContext.aliasHints,
        ownerName,
      ]),
    };
  }

  let ownerName = normalizeString(input.ownerName || input.ownerId);
  let nodeId = normalizeString(input.nodeId || input.ownerNodeId);
  const explicitNode = findCharacterNodeById(graph, nodeId);
  if (explicitNode) {
    nodeId = explicitNode.id;
    ownerName = ownerName || normalizeString(explicitNode?.fields?.name);
  }

  if (
    shouldResolveCharacterOwnerAsUser(
      graph,
      ownerName || input.ownerId,
      nodeId,
      userAliasContext,
    )
  ) {
    const userOwnerName =
      userAliasContext.preferredName ||
      normalizeString(ownerName || input.ownerId || input.ownerKey);
    return {
      ownerType: OWNER_TYPE_USER,
      ownerKey: buildOwnerKey(OWNER_TYPE_USER, userOwnerName),
      ownerName: userOwnerName,
      nodeId: "",
      aliases: uniqueStrings([
        ...(Array.isArray(input.aliases) ? input.aliases : [input.aliases]),
        ...userAliasContext.aliasHints,
        ownerName,
        userOwnerName,
      ]),
    };
  }

  if (!nodeId && ownerName) {
    const matches = findCharacterNodeByName(graph, ownerName);
    if (matches.length === 1) {
      nodeId = matches[0].id;
    }
  }

  const aliases = uniqueStrings(input.aliases || [ownerName]);
  const equivalentOwner = findEquivalentCharacterOwnerEntry(
    graph?.knowledgeState?.owners || {},
    {
      ownerKey: input.ownerKey,
      ownerType,
      ownerName,
      nodeId,
      aliases,
    },
    graph,
  );
  if (equivalentOwner?.ownerKey) {
    return {
      ownerType,
      ownerKey: equivalentOwner.ownerKey,
      ownerName: equivalentOwner.ownerName || ownerName,
      nodeId: equivalentOwner.nodeId || nodeId,
      aliases: uniqueStrings([
        ...aliases,
        ...(equivalentOwner.aliases || []),
        equivalentOwner.ownerName || "",
      ]),
    };
  }
  const ownerKey = buildOwnerKey(ownerType, ownerName || input.ownerId, nodeId, graph);
  return {
    ownerType,
    ownerKey,
    ownerName,
    nodeId,
    aliases,
  };
}

export function resolveKnowledgeOwnerKeyFromScope(graph, scope = {}) {
  const normalizedScope = normalizeMemoryScope(scope);
  return resolveKnowledgeOwner(graph, {
    ownerType: normalizedScope.ownerType,
    ownerName: normalizedScope.ownerName,
    ownerId: normalizedScope.ownerId,
  }).ownerKey;
}

export function ensureKnowledgeOwnerState(graph, input = {}, patch = {}) {
  normalizeGraphCognitiveState(graph);
  const requestedOwnerKey = normalizeString(input.ownerKey);
  if (requestedOwnerKey && graph.knowledgeState.owners[requestedOwnerKey]) {
    const existingEntry = graph.knowledgeState.owners[requestedOwnerKey];
    const nextEntry = mergeKnowledgeOwnerEntries(
      existingEntry,
      createDefaultKnowledgeOwnerState({
        ...existingEntry,
        ...patch,
        ownerKey: requestedOwnerKey,
      }),
    );
    graph.knowledgeState.owners[requestedOwnerKey] = nextEntry;
    return {
      ownerKey: requestedOwnerKey,
      ownerState: nextEntry,
      owner: {
        ownerKey: requestedOwnerKey,
        ownerType: existingEntry.ownerType,
        ownerName: existingEntry.ownerName,
        nodeId: existingEntry.nodeId,
        aliases: existingEntry.aliases || [],
      },
    };
  }

  const owner = resolveKnowledgeOwner(graph, input);
  if (!owner.ownerKey) {
    return { ownerKey: "", ownerState: null, owner };
  }

  const existing = graph.knowledgeState.owners[owner.ownerKey];
  const nextEntry = mergeKnowledgeOwnerEntries(
    existing || createDefaultKnowledgeOwnerState(owner),
    createDefaultKnowledgeOwnerState({
      ...(existing || {}),
      ...owner,
      ...patch,
      aliases: uniqueStrings([
        ...(existing?.aliases || []),
        ...(owner.aliases || []),
        ...(patch.aliases || []),
      ]),
    }),
  );
  graph.knowledgeState.owners[owner.ownerKey] = nextEntry;
  return {
    ownerKey: owner.ownerKey,
    ownerState: nextEntry,
    owner,
  };
}

function pushRecentRegion(regionState, region) {
  const normalizedRegion = normalizeString(region);
  if (!normalizedRegion) return;
  regionState.recentRegions = uniqueStrings([
    normalizedRegion,
    ...(regionState.recentRegions || []),
  ]).slice(0, RECENT_REGION_LIMIT);
}

function buildRegionAliasLookup(regionState = {}) {
  const lookup = new Map();
  for (const [regionName, entry] of Object.entries(regionState.adjacencyMap || {})) {
    const normalizedRegionName = normalizeString(regionName);
    if (!normalizedRegionName) continue;
    lookup.set(normalizeKey(normalizedRegionName), normalizedRegionName);
    for (const alias of uniqueStrings(entry?.aliases)) {
      lookup.set(normalizeKey(alias), normalizedRegionName);
    }
  }
  return lookup;
}

export function resolveCanonicalRegionName(regionState = {}, region = "") {
  const normalizedRegion = normalizeString(region);
  if (!normalizedRegion) return "";
  const aliasLookup = buildRegionAliasLookup(regionState);
  return aliasLookup.get(normalizeKey(normalizedRegion)) || normalizedRegion;
}

export function resolveAdjacentRegions(graph, activeRegion = "") {
  const regionState = normalizeRegionState(graph?.regionState);
  const canonicalRegion = resolveCanonicalRegionName(regionState, activeRegion);
  const entry = canonicalRegion
    ? regionState.adjacencyMap?.[canonicalRegion] || null
    : null;
  return {
    canonicalRegion,
    adjacentRegions: uniqueStrings(entry?.adjacent || []),
  };
}

export function resolveActiveRegionContext(graph, preferredRegion = "") {
  const regionState = normalizeRegionState(graph?.regionState);
  const manualActiveRegion = normalizeString(regionState.manualActiveRegion);
  if (manualActiveRegion) {
    return {
      activeRegion: resolveCanonicalRegionName(regionState, manualActiveRegion),
      source: "manual",
    };
  }

  const preferred = normalizeString(preferredRegion);
  if (preferred) {
    return {
      activeRegion: resolveCanonicalRegionName(regionState, preferred),
      source: normalizeString(graph?.historyState?.activeRegionSource) || "runtime",
    };
  }

  const historyRegion = normalizeString(graph?.historyState?.activeRegion);
  if (historyRegion) {
    return {
      activeRegion: resolveCanonicalRegionName(regionState, historyRegion),
      source: normalizeString(graph?.historyState?.activeRegionSource) || "history",
    };
  }

  const extractedRegion = normalizeString(graph?.historyState?.lastExtractedRegion);
  if (extractedRegion) {
    return {
      activeRegion: resolveCanonicalRegionName(regionState, extractedRegion),
      source: "extract",
    };
  }

  const recentRegion = uniqueStrings(regionState.recentRegions)[0] || "";
  if (recentRegion) {
    return {
      activeRegion: resolveCanonicalRegionName(regionState, recentRegion),
      source: "recent",
    };
  }

  const fallbackRegion = (Array.isArray(graph?.nodes) ? graph.nodes : [])
    .filter((node) => node && !node.archived)
    .map((node) => getScopeRegionKey(node?.scope))
    .map((region) => normalizeString(region))
    .find(Boolean);

  return {
    activeRegion: resolveCanonicalRegionName(regionState, fallbackRegion),
    source: fallbackRegion ? "graph" : "",
  };
}

function resolveNodeIdRef(ref, refMap = null) {
  const normalizedRef = normalizeString(ref);
  if (!normalizedRef) return "";
  if (refMap instanceof Map && refMap.has(normalizedRef)) {
    return normalizeString(refMap.get(normalizedRef));
  }
  return normalizedRef;
}

function collectRefNodeIds(refs = [], refMap = null) {
  return uniqueIds(
    (Array.isArray(refs) ? refs : [refs]).map((ref) => resolveNodeIdRef(ref, refMap)),
  );
}

function normalizeVisibilityEntries(entries = [], refMap = null) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const nodeId = resolveNodeIdRef(entry?.ref || entry?.nodeId || "", refMap);
    if (!nodeId) continue;
    result.push({
      nodeId,
      score: clampScore(entry?.score, DEFAULT_VISIBILITY_SCORE),
      reason: normalizeString(entry?.reason),
    });
  }
  return result;
}

function collectCharacterMentionOwners(graph, node) {
  const text = [
    node?.fields?.name,
    node?.fields?.title,
    node?.fields?.summary,
    node?.fields?.participants,
    node?.fields?.state,
    node?.fields?.belief,
    node?.fields?.attitude,
    node?.fields?.about,
  ]
    .filter((value) => value != null)
    .join(" ");
  if (!text) return [];

  const loweredText = normalizeKey(text);
  const owners = [];
  for (const characterNode of getCharacterNodes(graph)) {
    const ownerName = normalizeString(characterNode?.fields?.name);
    if (!ownerName) continue;
    if (!loweredText.includes(normalizeKey(ownerName))) continue;
    owners.push(
      resolveKnowledgeOwner(graph, {
        ownerType: OWNER_TYPE_CHARACTER,
        ownerName,
        nodeId: characterNode.id,
      }),
    );
  }
  return owners.filter((owner) => owner.ownerKey);
}

function applyVisibilityPatch(ownerState, nodeId, score) {
  const normalizedNodeId = normalizeString(nodeId);
  if (!normalizedNodeId) return;
  ownerState.visibilityScores[normalizedNodeId] = Math.max(
    clampScore(ownerState.visibilityScores[normalizedNodeId]),
    clampScore(score),
  );
}

function applyKnowledgeNodeIds(ownerState, fieldName, nodeIds = []) {
  ownerState[fieldName] = uniqueIds([
    ...(ownerState[fieldName] || []),
    ...nodeIds,
  ]);
}

function inferKnowledgeFromChangedNodes(
  graph,
  {
    changedNodeIds = [],
    scopeRuntime = {},
    refMap = null,
    source = "extract-infer",
  } = {},
) {
  const normalizedChangedNodeIds = uniqueIds(changedNodeIds);
  if (normalizedChangedNodeIds.length === 0) return;

  const activeUserOwner = resolveKnowledgeOwner(graph, {
    ownerType: OWNER_TYPE_USER,
    ownerName: scopeRuntime.activeUserOwner,
  });

  for (const nodeId of normalizedChangedNodeIds) {
    const node = Array.isArray(graph?.nodes)
      ? graph.nodes.find((item) => item?.id === nodeId)
      : null;
    if (!node || node.archived) continue;

    const nodeScope = normalizeMemoryScope(node.scope);
    if (node.type === "pov_memory" && nodeScope.layer === "pov") {
      const ownerResult = ensureKnowledgeOwnerState(
        graph,
        {
          ownerType: nodeScope.ownerType,
          ownerName: nodeScope.ownerName,
          ownerId: nodeScope.ownerId,
        },
        {
          updatedAt: Date.now(),
          lastSource: source,
        },
      );
      if (!ownerResult.ownerState) continue;
      applyKnowledgeNodeIds(ownerResult.ownerState, "knownNodeIds", [node.id]);
      applyVisibilityPatch(ownerResult.ownerState, node.id, 1);

      const aboutNodeIds = collectRefNodeIds(node?.fields?.about, refMap);
      if (String(node?.fields?.certainty || "").trim() === "mistaken") {
        applyKnowledgeNodeIds(
          ownerResult.ownerState,
          "mistakenNodeIds",
          aboutNodeIds,
        );
      } else {
        applyKnowledgeNodeIds(ownerResult.ownerState, "knownNodeIds", aboutNodeIds);
        aboutNodeIds.forEach((aboutNodeId) =>
          applyVisibilityPatch(ownerResult.ownerState, aboutNodeId, 0.95),
        );
      }
      continue;
    }

    if (node.type === "character") {
      continue;
    }

    const mentionedOwners = collectCharacterMentionOwners(graph, node);
    for (const mentionedOwner of mentionedOwners) {
      const ownerResult = ensureKnowledgeOwnerState(graph, mentionedOwner, {
        updatedAt: Date.now(),
        lastSource: source,
      });
      if (!ownerResult.ownerState) continue;
      applyKnowledgeNodeIds(ownerResult.ownerState, "knownNodeIds", [node.id]);
      applyVisibilityPatch(ownerResult.ownerState, node.id, 0.92);
    }

    if (activeUserOwner.ownerKey) {
      const ownerResult = ensureKnowledgeOwnerState(graph, activeUserOwner, {
        updatedAt: Date.now(),
        lastSource: source,
      });
      if (ownerResult.ownerState) {
        applyVisibilityPatch(ownerResult.ownerState, node.id, 0.7);
      }
    }
  }
}

export function applyCognitionUpdates(
  graph,
  cognitionUpdates = [],
  {
    refMap = null,
    changedNodeIds = [],
    scopeRuntime = {},
    source = "extract",
  } = {},
) {
  normalizeGraphCognitiveState(graph);
  const now = Date.now();

  for (const update of Array.isArray(cognitionUpdates) ? cognitionUpdates : []) {
    const ownerResult = ensureKnowledgeOwnerState(
      graph,
      {
        ownerType: update?.ownerType,
        ownerName: update?.ownerName,
        ownerId: update?.ownerId,
        nodeId: update?.ownerNodeId,
      },
      {
        updatedAt: now,
        lastSource: source,
      },
    );
    const ownerState = ownerResult.ownerState;
    if (!ownerState) continue;

    const knownNodeIds = collectRefNodeIds(update?.knownRefs, refMap);
    const mistakenNodeIds = collectRefNodeIds(update?.mistakenRefs, refMap);
    const visibilityEntries = normalizeVisibilityEntries(update?.visibility, refMap);

    applyKnowledgeNodeIds(ownerState, "knownNodeIds", knownNodeIds);
    applyKnowledgeNodeIds(ownerState, "mistakenNodeIds", mistakenNodeIds);

    for (const nodeId of knownNodeIds) {
      applyVisibilityPatch(ownerState, nodeId, 1);
    }
    for (const entry of visibilityEntries) {
      applyVisibilityPatch(ownerState, entry.nodeId, entry.score);
    }
  }

  inferKnowledgeFromChangedNodes(graph, {
    changedNodeIds,
    scopeRuntime,
    refMap,
    source: `${source}-heuristic`,
  });

  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return graph.knowledgeState;
}

function mergeAdjacencyEntry(regionState, regionName, adjacent = [], source = "") {
  const normalizedRegionName = normalizeString(regionName);
  if (!normalizedRegionName) return;
  const existingEntry = regionState.adjacencyMap[normalizedRegionName];
  regionState.adjacencyMap[normalizedRegionName] = normalizeRegionAdjacencyEntry(
    normalizedRegionName,
    {
      ...(existingEntry || {}),
      adjacent: uniqueStrings([...(existingEntry?.adjacent || []), ...adjacent]),
      source: normalizeString(source) || normalizeString(existingEntry?.source),
      updatedAt: Date.now(),
    },
  );
}

export function applyRegionUpdates(
  graph,
  regionUpdates = null,
  {
    changedNodeIds = [],
    source = "extract",
  } = {},
) {
  normalizeGraphCognitiveState(graph);
  const regionState = graph.regionState;
  const historyState = graph.historyState || {};

  const normalizedUpdates =
    regionUpdates && typeof regionUpdates === "object" && !Array.isArray(regionUpdates)
      ? regionUpdates
      : {};

  for (const entry of Array.isArray(normalizedUpdates.adjacency)
    ? normalizedUpdates.adjacency
    : []) {
    const regionName = normalizeString(entry?.region);
    const adjacent = uniqueStrings(entry?.adjacent);
    if (!regionName || adjacent.length === 0) continue;
    mergeAdjacencyEntry(regionState, regionName, adjacent, entry?.source || source);
    for (const adjacentRegion of adjacent) {
      mergeAdjacencyEntry(regionState, adjacentRegion, [regionName], entry?.source || source);
    }
  }

  const candidateRegion =
    normalizeString(normalizedUpdates.activeRegionHint) ||
    uniqueStrings(
      changedNodeIds
        .map((nodeId) =>
          (Array.isArray(graph?.nodes) ? graph.nodes : []).find(
            (node) => node?.id === nodeId,
          ),
        )
        .filter(Boolean)
        .map((node) => getScopeRegionKey(node?.scope)),
    )[0] ||
    "";

  if (candidateRegion) {
    const canonicalRegion = resolveCanonicalRegionName(regionState, candidateRegion);
    pushRecentRegion(regionState, canonicalRegion);
    historyState.lastExtractedRegion = canonicalRegion;
    if (!normalizeString(regionState.manualActiveRegion)) {
      historyState.activeRegion = canonicalRegion;
      historyState.activeRegionSource = source;
    }
  } else if (normalizeString(regionState.manualActiveRegion)) {
    historyState.activeRegion = resolveCanonicalRegionName(
      regionState,
      regionState.manualActiveRegion,
    );
    historyState.activeRegionSource = "manual";
  }

  graph.historyState = historyState;
  graph.regionState = normalizeRegionState(regionState);
  return graph.regionState;
}

function listToSet(values = []) {
  return new Set(uniqueIds(values));
}

function normalizeOwnerKeyList(ownerKeys = []) {
  return uniqueIds(Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys]);
}

function computeKnowledgeGateForSingleOwner(
  graph,
  node,
  ownerKey = "",
  {
    vectorScore = 0,
    graphScore = 0,
    lexicalScore = 0,
    scopeBucket = "",
    injectLowConfidenceObjectiveMemory = false,
  } = {},
) {
  const normalizedOwnerKey = normalizeString(ownerKey);
  const scope = normalizeMemoryScope(node?.scope);
  const knowledgeState = normalizeKnowledgeState(graph?.knowledgeState, graph);
  const ownerState = knowledgeState.owners?.[normalizedOwnerKey] || null;

  if (!normalizedOwnerKey || !ownerState) {
    return {
      visible: true,
      anchored: false,
      rescued: false,
      suppressed: false,
      suppressedReason: "",
      visibilityScore: 0,
      mode: "no-owner-state",
      threshold: 0,
    };
  }

  const manualKnownSet = listToSet(ownerState.manualKnownNodeIds);
  const knownSet = listToSet(ownerState.knownNodeIds);
  const mistakenSet = listToSet(ownerState.mistakenNodeIds);
  const manualHiddenSet = listToSet(ownerState.manualHiddenNodeIds);
  const ownerNodeKey = ownerState.nodeId
    ? `${OWNER_TYPE_CHARACTER}:${normalizeKey(ownerState.ownerName)}#${ownerState.nodeId}`
    : ownerState.ownerKey;
  const nodeOwnerKey = scope.layer === "pov" ? getScopeOwnerKey(scope) : "";

  if (manualHiddenSet.has(node.id)) {
    return {
      visible: false,
      anchored: false,
      rescued: false,
      suppressed: true,
      suppressedReason: "manual-hidden",
      visibilityScore: 0,
      mode: "manual-hidden",
      threshold: 1,
    };
  }

  if (scope.layer === "objective" && mistakenSet.has(node.id)) {
    return {
      visible: false,
      anchored: false,
      rescued: false,
      suppressed: true,
      suppressedReason: "mistaken-objective",
      visibilityScore: 0,
      mode: "mistaken-objective",
      threshold: 1,
    };
  }

  const manualKnown = manualKnownSet.has(node.id);
  const anchored =
    manualKnown ||
    knownSet.has(node.id) ||
    (node.type === "character" &&
      ownerState.nodeId &&
      ownerState.nodeId === node.id) ||
    (scope.layer === "pov" && nodeOwnerKey && nodeOwnerKey === ownerNodeKey);
  const baseVisibility = Math.max(
    clampScore(ownerState.visibilityScores?.[node.id]),
    anchored ? 1 : 0,
  );

  let threshold = 0.4;
  if (scope.layer === "pov") {
    threshold = 0.18;
  } else if (scopeBucket === "objectiveCurrentRegion") {
    threshold = 0.34;
  } else if (scopeBucket === "objectiveAdjacentRegion") {
    threshold = 0.42;
  } else if (scopeBucket === "objectiveGlobal") {
    threshold = injectLowConfidenceObjectiveMemory ? 0 : 0.56;
  }

  const strongVector = Number(vectorScore) >= 0.82;
  const strongLexical = Number(lexicalScore) >= 0.85;
  const strongGraph = Number(graphScore) >= 1.1;
  const regionRescue =
    scopeBucket === "objectiveCurrentRegion" &&
    (Number(vectorScore) >= 0.48 || Number(graphScore) >= 0.82);
  const rescued =
    !anchored &&
    scope.layer === "objective" &&
    !mistakenSet.has(node.id) &&
    (strongVector || strongLexical || strongGraph || regionRescue);

  const visibilityScore = rescued ? Math.max(baseVisibility, 0.68) : baseVisibility;
  const visible = anchored || visibilityScore >= threshold || rescued;

  return {
    visible,
    anchored,
    rescued,
    suppressed: !visible,
    suppressedReason: visible ? "" : "low-visibility",
    visibilityScore,
    mode: anchored
      ? manualKnown
        ? "manual-known"
        : "anchored"
      : rescued
        ? "rescued"
        : visible
          ? "soft-visible"
          : "suppressed",
    threshold,
  };
}

export function computeKnowledgeGateForNode(
  graph,
  node,
  ownerKey = "",
  {
    vectorScore = 0,
    graphScore = 0,
    lexicalScore = 0,
    scopeBucket = "",
    injectLowConfidenceObjectiveMemory = false,
  } = {},
) {
  const normalizedOwnerKeys = normalizeOwnerKeyList(ownerKey);
  if (normalizedOwnerKeys.length <= 1) {
    const singleGate = computeKnowledgeGateForSingleOwner(
      graph,
      node,
      normalizedOwnerKeys[0] || "",
      {
        vectorScore,
        graphScore,
        lexicalScore,
        scopeBucket,
        injectLowConfidenceObjectiveMemory,
      },
    );
    return {
      ...singleGate,
      ownerCoverage: singleGate.visible ? 1 : 0,
      visibleOwnerKeys: singleGate.visible && normalizedOwnerKeys[0]
        ? [normalizedOwnerKeys[0]]
        : [],
      suppressedOwnerKeys:
        singleGate.visible || !normalizedOwnerKeys[0]
          ? []
          : [normalizedOwnerKeys[0]],
      ownerResults: normalizedOwnerKeys[0]
        ? { [normalizedOwnerKeys[0]]: singleGate }
        : {},
    };
  }

  const ownerResults = {};
  const visibleOwnerKeys = [];
  const suppressedOwnerKeys = [];
  let bestVisibilityScore = 0;
  let bestThreshold = 0;
  let anchored = false;
  let rescued = false;
  let bestMode = "suppressed";
  let bestSuppressedReason = "";

  for (const candidateOwnerKey of normalizedOwnerKeys) {
    const result = computeKnowledgeGateForSingleOwner(
      graph,
      node,
      candidateOwnerKey,
      {
        vectorScore,
        graphScore,
        lexicalScore,
        scopeBucket,
        injectLowConfidenceObjectiveMemory,
      },
    );
    ownerResults[candidateOwnerKey] = result;
    bestVisibilityScore = Math.max(
      bestVisibilityScore,
      Number(result.visibilityScore || 0),
    );
    bestThreshold = Math.max(bestThreshold, Number(result.threshold || 0));
    if (result.visible) {
      visibleOwnerKeys.push(candidateOwnerKey);
      anchored ||= Boolean(result.anchored);
      rescued ||= Boolean(result.rescued);
      if (
        bestMode === "suppressed" ||
        (result.anchored && bestMode !== "manual-known") ||
        (result.mode === "manual-known")
      ) {
        bestMode = String(result.mode || bestMode);
      }
    } else {
      suppressedOwnerKeys.push(candidateOwnerKey);
      if (!bestSuppressedReason && result.suppressedReason) {
        bestSuppressedReason = String(result.suppressedReason || "");
      }
    }
  }

  const visible = visibleOwnerKeys.length > 0;
  return {
    visible,
    anchored,
    rescued,
    suppressed: !visible,
    suppressedReason: visible ? "" : bestSuppressedReason || "low-visibility",
    visibilityScore: bestVisibilityScore,
    mode: visible ? bestMode : "suppressed",
    threshold: bestThreshold,
    ownerCoverage: normalizedOwnerKeys.length
      ? visibleOwnerKeys.length / normalizedOwnerKeys.length
      : 0,
    visibleOwnerKeys,
    suppressedOwnerKeys,
    ownerResults,
  };
}

export function applyManualKnowledgeOverride(
  graph,
  { ownerKey = "", ownerType = "", ownerName = "", nodeId = "", mode = "known" } = {},
) {
  normalizeGraphCognitiveState(graph);
  const resolvedOwner =
    normalizeString(ownerKey) ||
    resolveKnowledgeOwner(graph, {
      ownerType,
      ownerName,
    }).ownerKey;
  if (!resolvedOwner || !normalizeString(nodeId)) {
    return { ok: false, reason: "missing-owner-or-node" };
  }

  const ownerState = ensureKnowledgeOwnerState(
    graph,
    { ownerKey: resolvedOwner, ownerType, ownerName },
    {
      updatedAt: Date.now(),
      lastSource: "manual",
    },
  ).ownerState;
  if (!ownerState) {
    return { ok: false, reason: "owner-not-found" };
  }

  ownerState.manualKnownNodeIds = uniqueIds(ownerState.manualKnownNodeIds);
  ownerState.manualHiddenNodeIds = uniqueIds(ownerState.manualHiddenNodeIds);
  ownerState.mistakenNodeIds = uniqueIds(ownerState.mistakenNodeIds);

  ownerState.manualKnownNodeIds = ownerState.manualKnownNodeIds.filter(
    (value) => value !== nodeId,
  );
  ownerState.manualHiddenNodeIds = ownerState.manualHiddenNodeIds.filter(
    (value) => value !== nodeId,
  );
  ownerState.mistakenNodeIds = ownerState.mistakenNodeIds.filter(
    (value) => value !== nodeId,
  );

  if (mode === "known") {
    ownerState.manualKnownNodeIds.push(nodeId);
  } else if (mode === "hidden") {
    ownerState.manualHiddenNodeIds.push(nodeId);
  } else if (mode === "mistaken") {
    ownerState.mistakenNodeIds.push(nodeId);
  }

  ownerState.updatedAt = Date.now();
  ownerState.lastSource = "manual";
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return { ok: true, ownerKey: resolvedOwner };
}

export function clearManualKnowledgeOverride(
  graph,
  { ownerKey = "", ownerType = "", ownerName = "", nodeId = "" } = {},
) {
  normalizeGraphCognitiveState(graph);
  const resolvedOwner =
    normalizeString(ownerKey) ||
    resolveKnowledgeOwner(graph, {
      ownerType,
      ownerName,
    }).ownerKey;
  if (!resolvedOwner || !normalizeString(nodeId)) {
    return { ok: false, reason: "missing-owner-or-node" };
  }

  const ownerState = graph.knowledgeState.owners?.[resolvedOwner];
  if (!ownerState) {
    return { ok: false, reason: "owner-not-found" };
  }

  ownerState.manualKnownNodeIds = (ownerState.manualKnownNodeIds || []).filter(
    (value) => value !== nodeId,
  );
  ownerState.manualHiddenNodeIds = (ownerState.manualHiddenNodeIds || []).filter(
    (value) => value !== nodeId,
  );
  ownerState.mistakenNodeIds = (ownerState.mistakenNodeIds || []).filter(
    (value) => value !== nodeId,
  );
  ownerState.updatedAt = Date.now();
  ownerState.lastSource = "manual-clear";
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return { ok: true, ownerKey: resolvedOwner };
}

export function setManualActiveRegion(graph, region = "") {
  normalizeGraphCognitiveState(graph);
  const normalizedRegion = normalizeString(region);
  graph.regionState.manualActiveRegion = normalizedRegion;
  if (normalizedRegion) {
    graph.historyState.activeRegion = resolveCanonicalRegionName(
      graph.regionState,
      normalizedRegion,
    );
    graph.historyState.activeRegionSource = "manual";
    pushRecentRegion(graph.regionState, graph.historyState.activeRegion);
  } else if (graph.historyState.activeRegionSource === "manual") {
    graph.historyState.activeRegion = normalizeString(
      graph.historyState.lastExtractedRegion,
    );
    graph.historyState.activeRegionSource = graph.historyState.activeRegion
      ? "extract"
      : "";
  }
  graph.regionState = normalizeRegionState(graph.regionState);
  return {
    ok: true,
    activeRegion: normalizeString(graph.historyState.activeRegion),
  };
}

export function updateRegionAdjacencyManual(graph, region = "", adjacent = []) {
  normalizeGraphCognitiveState(graph);
  const normalizedRegion = normalizeString(region);
  if (!normalizedRegion) {
    return { ok: false, reason: "missing-region" };
  }

  mergeAdjacencyEntry(graph.regionState, normalizedRegion, adjacent, "manual");
  for (const adjacentRegion of uniqueStrings(adjacent)) {
    mergeAdjacencyEntry(graph.regionState, adjacentRegion, [normalizedRegion], "manual");
  }
  graph.regionState = normalizeRegionState(graph.regionState);
  return { ok: true, region: normalizedRegion };
}

function buildKnowledgeOwnerAliasVariantSet(owner = {}) {
  return buildOwnerAliasVariantSet([
    owner?.ownerName,
    ...(Array.isArray(owner?.aliases) ? owner.aliases : []),
  ]);
}

function doesKnowledgeOwnerVariantSetMatchValue(variantSet, value = "") {
  if (!(variantSet instanceof Set) || variantSet.size === 0) return false;
  for (const variant of collectAliasMatchVariants(value)) {
    if (variantSet.has(variant)) return true;
  }
  return false;
}

function doesScopeReferenceCharacterOwner(graph, scope = {}, owner = {}) {
  const normalizedScope = normalizeMemoryScope(scope);
  if (normalizeOwnerType(normalizedScope.ownerType) !== OWNER_TYPE_CHARACTER) {
    return false;
  }

  const normalizedOwnerKey = normalizeString(owner?.ownerKey);
  if (normalizedOwnerKey) {
    const resolvedOwnerKey = resolveKnowledgeOwner(graph, {
      ownerType: OWNER_TYPE_CHARACTER,
      ownerName: normalizedScope.ownerName || normalizedScope.ownerId,
      ownerId: normalizedScope.ownerId,
    }).ownerKey;
    if (resolvedOwnerKey && resolvedOwnerKey === normalizedOwnerKey) {
      return true;
    }
  }

  const aliasVariantSet = buildKnowledgeOwnerAliasVariantSet(owner);
  return (
    doesKnowledgeOwnerVariantSetMatchValue(aliasVariantSet, normalizedScope.ownerName) ||
    doesKnowledgeOwnerVariantSetMatchValue(aliasVariantSet, normalizedScope.ownerId)
  );
}

function doesCharacterNodeReferenceOwner(graph, node = {}, owner = {}) {
  if (
    !node ||
    node.archived === true ||
    normalizeString(node?.type) !== "character" ||
    !normalizeString(node?.fields?.name)
  ) {
    return false;
  }

  const normalizedOwnerKey = normalizeString(owner?.ownerKey);
  if (normalizedOwnerKey) {
    const resolvedOwnerKey = resolveKnowledgeOwner(graph, {
      ownerType: OWNER_TYPE_CHARACTER,
      ownerName: node?.fields?.name,
      nodeId: node?.id,
    }).ownerKey;
    if (resolvedOwnerKey && resolvedOwnerKey === normalizedOwnerKey) {
      return true;
    }
  }

  const aliasVariantSet = buildKnowledgeOwnerAliasVariantSet(owner);
  return (
    doesKnowledgeOwnerVariantSetMatchValue(aliasVariantSet, node?.fields?.name) ||
    normalizeString(owner?.nodeId) === normalizeString(node?.id)
  );
}

function collectCharacterNodesForOwner(graph, owner = {}) {
  return Array.isArray(graph?.nodes)
    ? graph.nodes.filter((node) => doesCharacterNodeReferenceOwner(graph, node, owner))
    : [];
}

function rewriteScopedCharacterOwnerReferences(
  graph,
  owner = {},
  { ownerName = "", ownerId = "" } = {},
) {
  const normalizedOwnerName = normalizeString(ownerName || ownerId);
  const normalizedOwnerId = normalizeString(ownerId || ownerName);
  if (!normalizedOwnerName || !normalizedOwnerId) {
    return {
      changedNodeIds: [],
      changedEdgeCount: 0,
    };
  }

  const changedNodeIds = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const normalizedScope = normalizeMemoryScope(node?.scope);
    if (!doesScopeReferenceCharacterOwner(graph, normalizedScope, owner)) {
      continue;
    }
    node.scope = normalizeMemoryScope({
      ...normalizedScope,
      layer: "pov",
      ownerType: OWNER_TYPE_CHARACTER,
      ownerName: normalizedOwnerName,
      ownerId: normalizedOwnerId,
    });
    const normalizedNodeId = normalizeString(node?.id);
    if (normalizedNodeId) changedNodeIds.push(normalizedNodeId);
  }

  let changedEdgeCount = 0;
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    const normalizedScope = normalizeMemoryScope(edge?.scope);
    if (!doesScopeReferenceCharacterOwner(graph, normalizedScope, owner)) {
      continue;
    }
    edge.scope = normalizeMemoryScope({
      ...normalizedScope,
      layer: "pov",
      ownerType: OWNER_TYPE_CHARACTER,
      ownerName: normalizedOwnerName,
      ownerId: normalizedOwnerId,
    });
    changedEdgeCount += 1;
  }

  return {
    changedNodeIds: uniqueIds(changedNodeIds),
    changedEdgeCount,
  };
}

function renameCharacterNodesForOwner(graph, owner = {}, nextName = "") {
  const normalizedNextName = normalizeString(nextName);
  if (!normalizedNextName) return [];

  const changedNodeIds = [];
  for (const node of collectCharacterNodesForOwner(graph, owner)) {
    node.fields = {
      ...(node?.fields || {}),
      name: normalizedNextName,
    };
    const normalizedNodeId = normalizeString(node?.id);
    if (normalizedNodeId) changedNodeIds.push(normalizedNodeId);
  }
  return uniqueIds(changedNodeIds);
}

function updateHistoryOwnerReferences(historyState, previousOwner = {}, nextOwner = null) {
  if (!historyState || typeof historyState !== "object") return;

  const previousOwnerKey = normalizeString(previousOwner?.ownerKey);
  const nextOwnerKey = normalizeString(nextOwner?.ownerKey);
  const nextOwnerName = normalizeString(nextOwner?.ownerName);
  const previousAliasVariants = buildKnowledgeOwnerAliasVariantSet(previousOwner);

  if (
    doesKnowledgeOwnerVariantSetMatchValue(
      previousAliasVariants,
      historyState.activeCharacterPovOwner,
    )
  ) {
    historyState.activeCharacterPovOwner = nextOwnerName;
  }

  if (normalizeString(historyState.activeRecallOwnerKey) === previousOwnerKey) {
    historyState.activeRecallOwnerKey = nextOwnerKey;
  }

  historyState.recentRecallOwnerKeys = uniqueStrings(
    (historyState.recentRecallOwnerKeys || [])
      .map((value) => {
        const normalizedValue = normalizeString(value);
        if (!normalizedValue) return "";
        return normalizedValue === previousOwnerKey ? nextOwnerKey : normalizedValue;
      })
      .filter(Boolean),
  ).slice(0, RECENT_RECALL_OWNER_LIMIT);
}

function archiveOwnerCharacterNodesForMerge(graph, sourceOwner = {}, targetOwner = {}) {
  const sourceNodes = collectCharacterNodesForOwner(graph, sourceOwner);
  const archivedNodeIds = [];
  let adoptedNodeId = normalizeString(targetOwner?.nodeId);

  if (!adoptedNodeId && sourceNodes.length > 0) {
    const keeper = sourceNodes[0];
    keeper.fields = {
      ...(keeper?.fields || {}),
      name: normalizeString(targetOwner?.ownerName || keeper?.fields?.name),
    };
    keeper.archived = false;
    adoptedNodeId = normalizeString(keeper?.id);

    for (const node of sourceNodes.slice(1)) {
      node.archived = true;
      const normalizedNodeId = normalizeString(node?.id);
      if (normalizedNodeId) archivedNodeIds.push(normalizedNodeId);
    }
    return {
      adoptedNodeId,
      archivedNodeIds: uniqueIds(archivedNodeIds),
    };
  }

  for (const node of sourceNodes) {
    node.archived = true;
    const normalizedNodeId = normalizeString(node?.id);
    if (normalizedNodeId) archivedNodeIds.push(normalizedNodeId);
  }
  return {
    adoptedNodeId,
    archivedNodeIds: uniqueIds(archivedNodeIds),
  };
}

function archiveCharacterNodesForOwner(graph, owner = {}) {
  const archivedNodeIds = [];
  for (const node of collectCharacterNodesForOwner(graph, owner)) {
    node.archived = true;
    const normalizedNodeId = normalizeString(node?.id);
    if (normalizedNodeId) archivedNodeIds.push(normalizedNodeId);
  }
  return uniqueIds(archivedNodeIds);
}

function archivePovNodesForOwner(graph, owner = {}) {
  const archivedNodeIds = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const normalizedScope = normalizeMemoryScope(node?.scope);
    if (normalizedScope.layer !== "pov") continue;
    if (!doesScopeReferenceCharacterOwner(graph, normalizedScope, owner)) continue;
    node.archived = true;
    const normalizedNodeId = normalizeString(node?.id);
    if (normalizedNodeId) archivedNodeIds.push(normalizedNodeId);
  }
  return uniqueIds(archivedNodeIds);
}

export function renameKnowledgeOwner(graph, ownerKey = "", nextName = "") {
  normalizeGraphCognitiveState(graph);
  const normalizedOwnerKey = normalizeString(ownerKey);
  const normalizedNextName = normalizeString(nextName);
  if (!normalizedOwnerKey || !normalizedNextName) {
    return { ok: false, reason: "missing-owner-or-name" };
  }

  const sourceEntry = createDefaultKnowledgeOwnerState(
    graph?.knowledgeState?.owners?.[normalizedOwnerKey] || {},
  );
  if (!sourceEntry.ownerKey) {
    return { ok: false, reason: "owner-not-found" };
  }
  if (normalizeOwnerType(sourceEntry.ownerType) !== OWNER_TYPE_CHARACTER) {
    return { ok: false, reason: "unsupported-owner-type" };
  }
  if (normalizeKey(sourceEntry.ownerName) === normalizeKey(normalizedNextName)) {
    return {
      ok: true,
      ownerKey: normalizedOwnerKey,
      unchanged: true,
    };
  }

  const scopeRewrite = rewriteScopedCharacterOwnerReferences(graph, sourceEntry, {
    ownerName: normalizedNextName,
    ownerId: normalizedNextName,
  });
  const renamedCharacterNodeIds = renameCharacterNodesForOwner(
    graph,
    sourceEntry,
    normalizedNextName,
  );
  const nextOwnerKey = buildOwnerKey(
    OWNER_TYPE_CHARACTER,
    normalizedNextName,
    sourceEntry.nodeId,
    graph,
  );
  const nextEntry = createDefaultKnowledgeOwnerState({
    ...sourceEntry,
    ownerKey: nextOwnerKey,
    ownerName: normalizedNextName,
    aliases: uniqueStrings([
      normalizedNextName,
      sourceEntry.ownerName,
      ...(sourceEntry.aliases || []),
    ]),
    updatedAt: Date.now(),
    lastSource: "manual-owner-rename",
  });

  delete graph.knowledgeState.owners[normalizedOwnerKey];
  graph.knowledgeState.owners[nextOwnerKey] = graph.knowledgeState.owners[nextOwnerKey]
    ? mergeKnowledgeOwnerEntries(graph.knowledgeState.owners[nextOwnerKey], nextEntry)
    : nextEntry;

  const resolvedNextOwner = createDefaultKnowledgeOwnerState(
    graph.knowledgeState.owners[nextOwnerKey],
  );
  updateHistoryOwnerReferences(graph.historyState, sourceEntry, resolvedNextOwner);
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return {
    ok: true,
    ownerKey: nextOwnerKey,
    previousOwnerKey: normalizedOwnerKey,
    renamedCharacterNodeIds,
    updatedPovNodeIds: scopeRewrite.changedNodeIds,
    updatedPovEdgeCount: scopeRewrite.changedEdgeCount,
  };
}

export function mergeKnowledgeOwners(
  graph,
  { sourceOwnerKey = "", targetOwnerKey = "" } = {},
) {
  normalizeGraphCognitiveState(graph);
  const normalizedSourceOwnerKey = normalizeString(sourceOwnerKey);
  const normalizedTargetOwnerKey = normalizeString(targetOwnerKey);
  if (!normalizedSourceOwnerKey || !normalizedTargetOwnerKey) {
    return { ok: false, reason: "missing-owner-key" };
  }
  if (normalizedSourceOwnerKey === normalizedTargetOwnerKey) {
    return { ok: false, reason: "same-owner" };
  }

  const sourceEntry = createDefaultKnowledgeOwnerState(
    graph?.knowledgeState?.owners?.[normalizedSourceOwnerKey] || {},
  );
  const targetEntry = createDefaultKnowledgeOwnerState(
    graph?.knowledgeState?.owners?.[normalizedTargetOwnerKey] || {},
  );
  if (!sourceEntry.ownerKey || !targetEntry.ownerKey) {
    return { ok: false, reason: "owner-not-found" };
  }
  if (
    normalizeOwnerType(sourceEntry.ownerType) !== OWNER_TYPE_CHARACTER ||
    normalizeOwnerType(targetEntry.ownerType) !== OWNER_TYPE_CHARACTER
  ) {
    return { ok: false, reason: "unsupported-owner-type" };
  }

  const scopeRewrite = rewriteScopedCharacterOwnerReferences(graph, sourceEntry, {
    ownerName: targetEntry.ownerName,
    ownerId: targetEntry.ownerName,
  });
  const characterNodeMerge = archiveOwnerCharacterNodesForMerge(
    graph,
    sourceEntry,
    targetEntry,
  );
  const mergedEntry = mergeKnowledgeOwnerEntries(
    createDefaultKnowledgeOwnerState({
      ...targetEntry,
      nodeId: targetEntry.nodeId || characterNodeMerge.adoptedNodeId || sourceEntry.nodeId,
      aliases: uniqueStrings([
        ...(targetEntry.aliases || []),
        ...(sourceEntry.aliases || []),
        targetEntry.ownerName,
        sourceEntry.ownerName,
      ]),
      updatedAt: Date.now(),
      lastSource: "manual-owner-merge",
    }),
    createDefaultKnowledgeOwnerState({
      ...sourceEntry,
      ownerKey: targetEntry.ownerKey,
      ownerName: targetEntry.ownerName,
      nodeId: targetEntry.nodeId || characterNodeMerge.adoptedNodeId || sourceEntry.nodeId,
      aliases: uniqueStrings([
        ...(targetEntry.aliases || []),
        ...(sourceEntry.aliases || []),
        targetEntry.ownerName,
        sourceEntry.ownerName,
      ]),
      updatedAt: Date.now(),
      lastSource: "manual-owner-merge",
    }),
  );

  graph.knowledgeState.owners[targetEntry.ownerKey] = mergedEntry;
  delete graph.knowledgeState.owners[sourceEntry.ownerKey];

  updateHistoryOwnerReferences(
    graph.historyState,
    sourceEntry,
    createDefaultKnowledgeOwnerState(graph.knowledgeState.owners[targetEntry.ownerKey]),
  );
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return {
    ok: true,
    ownerKey: targetEntry.ownerKey,
    sourceOwnerKey: sourceEntry.ownerKey,
    archivedCharacterNodeIds: characterNodeMerge.archivedNodeIds,
    adoptedCharacterNodeId: characterNodeMerge.adoptedNodeId || "",
    updatedPovNodeIds: scopeRewrite.changedNodeIds,
    updatedPovEdgeCount: scopeRewrite.changedEdgeCount,
  };
}

export function deleteKnowledgeOwner(
  graph,
  ownerKey = "",
  { mode = "owner-only" } = {},
) {
  normalizeGraphCognitiveState(graph);
  const normalizedOwnerKey = normalizeString(ownerKey);
  const normalizedMode = normalizeString(mode) || "owner-only";
  if (!normalizedOwnerKey) {
    return { ok: false, reason: "missing-owner-key" };
  }
  if (
    !["owner-only", "archive-character", "archive-all"].includes(
      normalizedMode,
    )
  ) {
    return { ok: false, reason: "invalid-delete-mode" };
  }

  const sourceEntry = createDefaultKnowledgeOwnerState(
    graph?.knowledgeState?.owners?.[normalizedOwnerKey] || {},
  );
  if (!sourceEntry.ownerKey) {
    return { ok: false, reason: "owner-not-found" };
  }
  if (normalizeOwnerType(sourceEntry.ownerType) !== OWNER_TYPE_CHARACTER) {
    return { ok: false, reason: "unsupported-owner-type" };
  }

  const archivedCharacterNodeIds =
    normalizedMode === "archive-character" || normalizedMode === "archive-all"
      ? archiveCharacterNodesForOwner(graph, sourceEntry)
      : [];
  const archivedPovNodeIds =
    normalizedMode === "archive-all"
      ? archivePovNodesForOwner(graph, sourceEntry)
      : [];

  delete graph.knowledgeState.owners[normalizedOwnerKey];
  updateHistoryOwnerReferences(graph.historyState, sourceEntry, null);
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
  return {
    ok: true,
    ownerKey: normalizedOwnerKey,
    mode: normalizedMode,
    archivedCharacterNodeIds,
    archivedPovNodeIds,
  };
}

export function getKnowledgeOwnerEntry(graph, ownerKey = "") {
  normalizeGraphCognitiveState(graph);
  const normalizedOwnerKey = normalizeString(ownerKey);
  return normalizedOwnerKey ? graph.knowledgeState.owners?.[normalizedOwnerKey] || null : null;
}

export function listKnowledgeOwners(graph) {
  normalizeGraphCognitiveState(graph);
  const owners = new Map();

  for (const entry of Object.values(graph.knowledgeState.owners || {})) {
    const normalizedEntry = createDefaultKnowledgeOwnerState(entry);
    if (!normalizedEntry.ownerKey) continue;
    const displayEntry = {
      ownerKey: normalizedEntry.ownerKey,
      ownerType: normalizedEntry.ownerType,
      ownerName: normalizedEntry.ownerName,
      nodeId: normalizedEntry.nodeId,
      aliases: [...(normalizedEntry.aliases || [])],
      knownCount: uniqueIds(normalizedEntry.knownNodeIds).length,
      mistakenCount: uniqueIds(normalizedEntry.mistakenNodeIds).length,
      manualKnownCount: uniqueIds(normalizedEntry.manualKnownNodeIds).length,
      manualHiddenCount: uniqueIds(normalizedEntry.manualHiddenNodeIds).length,
      updatedAt: Number(normalizedEntry.updatedAt || 0),
      lastSource: normalizeString(normalizedEntry.lastSource),
    };
    const equivalentEntry =
      owners.get(normalizedEntry.ownerKey) ||
      findEquivalentCharacterOwnerEntry(owners, displayEntry, graph);
    const targetKey = equivalentEntry?.ownerKey || normalizedEntry.ownerKey;
    owners.set(
      targetKey,
      owners.has(targetKey)
        ? mergeListedKnowledgeOwnerEntry(owners.get(targetKey), displayEntry)
        : displayEntry,
    );
  }

  return Array.from(owners.values()).sort((left, right) => {
      const updatedDelta = Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      if (updatedDelta !== 0) return updatedDelta;
      return String(left.ownerName || "").localeCompare(
        String(right.ownerName || ""),
        "zh-Hans-CN",
      );
    });
}

export function pushRecentRecallOwner(historyState, ownerKey = "") {
  if (!historyState || typeof historyState !== "object") return;
  const normalizedOwnerKey = normalizeString(ownerKey);
  if (!normalizedOwnerKey) return;
  historyState.recentRecallOwnerKeys = uniqueStrings([
    normalizedOwnerKey,
    ...(historyState.recentRecallOwnerKeys || []),
  ]).slice(0, RECENT_RECALL_OWNER_LIMIT);
  historyState.activeRecallOwnerKey = normalizedOwnerKey;
}
