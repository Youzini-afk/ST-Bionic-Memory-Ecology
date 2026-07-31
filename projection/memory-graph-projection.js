import { fingerprintMaterializedMemoryState } from "../domain/memory-changeset.js";
import { MEMORY_RECORD_KIND, MEMORY_REVISION_STATUS } from "../domain/memory-contract.js";
import { cloneDomainValue, createDomainId } from "../domain/memory-id.js";
import { buildMemoryLedgerIndex } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import {
  createDefaultKnowledgeOwnerState,
  createDefaultKnowledgeState,
  createDefaultRegionState,
  normalizeKnowledgeState,
  resolveKnowledgeOwner,
} from "../graph/knowledge-state.js";
import {
  getScopeOwnerKey,
  getScopeRegionKey,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { createDefaultSummaryState } from "../graph/summary-state.js";
import {
  createDefaultStoryTimeSpan,
  createDefaultTimelineSegment,
  normalizeStoryTime,
  normalizeStoryTimeSpan,
  normalizeTimelineState,
} from "../graph/story-timeline.js";
import { createEmptyGraph } from "../graph/graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";

// Graph compatibility is a rebuildable projection, never the durable authority.
export const MEMORY_GRAPH_PROJECTION_AUTHORITY = "vnext-ledger";
const PROJECTED_TIMELINE_PREFIX = "bme-timeline_";

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function finiteFloor(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function compareRevisionOrder(left, right) {
  const revisionDelta = Number(left?.ledgerRevision || 0) - Number(right?.ledgerRevision || 0);
  if (revisionDelta !== 0) return revisionDelta;
  const ordinalDelta = Number(left?.ledgerOrdinal || 0) - Number(right?.ledgerOrdinal || 0);
  if (ordinalDelta !== 0) return ordinalDelta;
  return String(left?.id || "").localeCompare(String(right?.id || ""), "en");
}

function collectEffectiveEvidence(index, revision, cache = new Map(), visiting = new Set()) {
  const revisionId = String(revision?.id || "");
  if (!revisionId) return [];
  if (cache.has(revisionId)) return cache.get(revisionId);
  if (visiting.has(revisionId)) return [];
  visiting.add(revisionId);
  const evidenceIds = new Set(revision.evidenceIds || []);
  for (const dependencyId of revision.dependencyRevisionIds || []) {
    const dependency = index.recordsById.get(dependencyId);
    if (
      dependency?.kind !== MEMORY_RECORD_KIND.MEMORY_REVISION &&
      dependency?.kind !== MEMORY_RECORD_KIND.RELATION_REVISION
    ) {
      continue;
    }
    for (const evidenceId of collectEffectiveEvidence(index, dependency, cache, visiting)) {
      evidenceIds.add(evidenceId);
    }
  }
  visiting.delete(revisionId);
  const result = [...evidenceIds];
  cache.set(revisionId, result);
  return result;
}

function deriveRevisionRange(index, revision, evidenceCache) {
  const effectiveEvidenceIds = collectEffectiveEvidence(index, revision, evidenceCache);
  const floors = effectiveEvidenceIds
    .map((evidenceId) => index.recordsById.get(evidenceId))
    .filter((record) => record?.kind === MEMORY_RECORD_KIND.EVIDENCE)
    .map((record) => finiteFloor(record.source?.assistantFloor ?? record.source?.userFloor))
    .filter((value) => value !== null);
  if (floors.length === 0) {
    const fallback = finiteFloor(revision?.ledgerRevision) ?? 0;
    return { seq: fallback, seqRange: [fallback, fallback], sourceFloor: fallback, effectiveEvidenceIds };
  }
  const start = Math.min(...floors);
  const end = Math.max(...floors);
  return { seq: end, seqRange: [start, end], sourceFloor: end, effectiveEvidenceIds };
}

function buildOriginTimes(records, identity) {
  const origins = new Map();
  for (const record of records || []) {
    const key = String(identity(record) || "");
    if (!key) continue;
    const createdAt = Number(record.createdAt || 0);
    const current = origins.get(key);
    if (!Number.isFinite(current) || createdAt < current) origins.set(key, createdAt);
  }
  return origins;
}

function normalizeRevisionScope(revision) {
  const layer = revision?.layer === "pov" ? "pov" : "objective";
  return normalizeMemoryScope({ layer, ...(revision?.scope || {}) });
}

function createProjectedNode({ revision, active, existing, range, originTime }) {
  const sameRevision = existing?.memoryRevisionId === revision.id;
  const storyTime = normalizeStoryTime(revision.storyTime || {});
  const storyTimeSpan = normalizeStoryTimeSpan(
    revision.fields?.storyTimeSpan ||
      (storyTime.segmentId || storyTime.label
        ? {
            startSegmentId: storyTime.segmentId,
            endSegmentId: storyTime.segmentId,
            startLabel: storyTime.label,
            endLabel: storyTime.label,
            source: storyTime.source,
          }
        : createDefaultStoryTimeSpan()),
  );
  return {
    id: revision.memoryId,
    type: revision.memoryType,
    level: 0,
    parentId: null,
    childIds: [],
    seq: range.seq,
    seqRange: range.seqRange,
    sourceFloor: range.sourceFloor,
    archived: !active,
    fields: cloneDomainValue(revision.fields, {}),
    embedding: sameRevision ? cloneDomainValue(existing.embedding, null) : null,
    importance: Number(revision.importance ?? 5),
    accessCount: Number(existing?.accessCount || 0),
    updatedAt: Number(revision.createdAt || 0),
    lastAccessTime: Number(existing?.lastAccessTime || revision.createdAt || 0),
    createdTime: Number(originTime ?? revision.createdAt ?? 0),
    prevId: null,
    nextId: null,
    clusters: sameRevision ? cloneDomainValue(existing.clusters, []) : [],
    scope: normalizeRevisionScope(revision),
    storyTime,
    storyTimeSpan,
    memoryAuthority: MEMORY_GRAPH_PROJECTION_AUTHORITY,
    memoryRevisionId: revision.id,
    memoryLayer: revision.layer,
    memoryConfidence: revision.confidence,
    memoryEvidenceIds: [...(revision.evidenceIds || [])],
    memoryEffectiveEvidenceIds: [...range.effectiveEvidenceIds],
    memoryDependencyRevisionIds: [...(revision.dependencyRevisionIds || [])],
    memoryAgentTaskId: revision.agentTaskId || "",
    memoryLedgerRevision: Number(revision.ledgerRevision || 0),
  };
}

function scopeChainKey(node) {
  const scope = normalizeMemoryScope(node.scope);
  return scope.layer === "pov"
    ? `pov:${getScopeOwnerKey(scope)}`
    : `objective:${getScopeRegionKey(scope)}`;
}

function rebuildNodeChains(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    node.prevId = null;
    node.nextId = null;
    if (node.archived || Number(node.level || 0) !== 0) continue;
    const key = `${node.type}::${scopeChainKey(node)}`;
    const bucket = groups.get(key) || [];
    bucket.push(node);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    bucket.sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0) || left.id.localeCompare(right.id, "en"));
    bucket.forEach((node, index) => {
      node.prevId = bucket[index - 1]?.id || null;
      node.nextId = bucket[index + 1]?.id || null;
    });
  }
}

function createProjectedEdge({ revision, active, existing, range, originTime, nodeById }) {
  const fromFloor = finiteFloor(nodeById.get(revision.fromMemoryId)?.sourceFloor);
  const toFloor = finiteFloor(nodeById.get(revision.toMemoryId)?.sourceFloor);
  const endpointFloor = fromFloor === null ? toFloor : toFloor === null ? fromFloor : Math.max(fromFloor, toFloor);
  const sourceFloor = Math.max(range.sourceFloor, endpointFloor ?? 0);
  return {
    id: revision.relationId,
    fromId: revision.fromMemoryId,
    toId: revision.toMemoryId,
    relation: revision.relation,
    strength: Number(revision.strength ?? 0.5),
    edgeType: Number(existing?.edgeType || 0),
    seq: sourceFloor,
    seqRange: range.seqRange,
    sourceFloor,
    createdTime: Number(originTime ?? revision.createdAt ?? 0),
    updatedAt: Number(revision.createdAt || 0),
    validAt: Number(revision.createdAt || 0),
    invalidAt: active ? null : Number(revision.createdAt || 0),
    expiredAt: null,
    scope: normalizeMemoryScope(revision.scope || {}),
    metadata: cloneDomainValue(revision.metadata, {}),
    memoryAuthority: MEMORY_GRAPH_PROJECTION_AUTHORITY,
    relationRevisionId: revision.id,
    relationEvidenceIds: [...(revision.evidenceIds || [])],
    relationEffectiveEvidenceIds: [...range.effectiveEvidenceIds],
    relationDependencyRevisionIds: [...(revision.dependencyRevisionIds || [])],
    memoryLedgerRevision: Number(revision.ledgerRevision || 0),
  };
}

function timelineKey(storyTime = {}) {
  return [storyTime.label, storyTime.anchorLabel, storyTime.relation]
    .map((value) => String(value || "").trim().toLocaleLowerCase())
    .join("::");
}

function projectTimeline(graph, chatId) {
  const base = normalizeTimelineState(graph.timelineState || {});
  const preserved = base.segments.filter(
    (segment) => !String(segment.id || "").startsWith(PROJECTED_TIMELINE_PREFIX),
  );
  const segments = [...preserved];
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const byKey = new Map(segments.map((segment) => [timelineKey(segment), segment]));
  const orderedNodes = [...graph.nodes]
    .filter((node) => !node.archived)
    .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0) || left.id.localeCompare(right.id, "en"));
  const recentIds = [];
  let nextOrder = Math.max(1, ...segments.map((segment) => Number(segment.order || 0) + 1));
  for (const node of orderedNodes) {
    const storyTime = normalizeStoryTime(node.storyTime || {});
    if (!storyTime.segmentId && !storyTime.label) continue;
    let segment = (storyTime.segmentId && byId.get(storyTime.segmentId)) || byKey.get(timelineKey(storyTime));
    if (!segment) {
      const segmentId = storyTime.segmentId || createDomainId("bme-timeline", {
        chatId,
        key: timelineKey(storyTime),
      });
      segment = createDefaultTimelineSegment({
        id: segmentId,
        label: storyTime.label || storyTime.anchorLabel || "Memory timeline",
        aliases: [storyTime.label],
        order: nextOrder,
        relationToParent: storyTime.relation,
        anchorLabel: storyTime.anchorLabel,
        confidence: storyTime.confidence,
        source: storyTime.source,
        updatedAt: node.updatedAt,
      });
      nextOrder += 1;
      segments.push(segment);
      byId.set(segment.id, segment);
      byKey.set(timelineKey(storyTime), segment);
    }
    node.storyTime = normalizeStoryTime({
      ...storyTime,
      segmentId: segment.id,
      label: segment.label || storyTime.label,
    });
    if (!node.storyTimeSpan?.startSegmentId && !node.storyTimeSpan?.endSegmentId) {
      node.storyTimeSpan = normalizeStoryTimeSpan({
        startSegmentId: segment.id,
        endSegmentId: segment.id,
        startLabel: segment.label,
        endLabel: segment.label,
        source: storyTime.source,
      });
    }
    recentIds.push(segment.id);
  }
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const manualActiveSegmentId = segmentIds.has(base.manualActiveSegmentId)
    ? base.manualActiveSegmentId
    : "";
  const latestId = recentIds.at(-1) || "";
  graph.timelineState = normalizeTimelineState({
    ...base,
    segments,
    nextOrder,
    manualActiveSegmentId,
    lastExtractedSegmentId: latestId,
    recentSegmentIds: [...new Set([...recentIds].reverse())].slice(0, 12),
  });
  graph.historyState ||= {};
  const activeId = manualActiveSegmentId || (segmentIds.has(graph.historyState.activeStorySegmentId) ? graph.historyState.activeStorySegmentId : latestId);
  const activeSegment = byId.get(activeId) || segments.find((segment) => segment.id === activeId) || null;
  graph.historyState.activeStorySegmentId = activeId;
  graph.historyState.activeStoryTimeLabel = activeSegment?.label || "";
  graph.historyState.activeStoryTimeSource = activeId ? MEMORY_GRAPH_PROJECTION_AUTHORITY : "";
  graph.historyState.lastExtractedStorySegmentId = latestId;
}

function dependencyMemoryIds(index, revision) {
  return uniqueStrings(
    (revision.dependencyRevisionIds || []).map((id) => {
      const dependency = index.recordsById.get(id);
      return dependency?.kind === MEMORY_RECORD_KIND.MEMORY_REVISION ? dependency.memoryId : "";
    }),
  );
}

function projectSummaries(graph, index, heads) {
  const synopsisNodes = heads
    .filter((revision) => revision.memoryType === "synopsis" && revision.status !== MEMORY_REVISION_STATUS.ARCHIVED)
    .map((revision) => ({ revision, node: graph.nodes.find((node) => node.id === revision.memoryId) }))
    .filter(({ node }) => node && String(node.fields?.summary || "").trim());
  const entries = synopsisNodes.map(({ revision, node }) => ({
    id: revision.memoryId,
    level: Number.isFinite(Number(node.fields?.level)) ? Math.max(0, Number(node.fields.level)) : 0,
    kind: Number(node.fields?.level || 0) > 0 ? "rollup" : "small",
    status: "active",
    text: String(node.fields.summary || "").trim(),
    sourceTask: "memory-steward",
    extractionRange: [...node.seqRange],
    messageRange: [...node.seqRange],
    dialogueRange: [...node.seqRange],
    sourceBatchIds: [],
    sourceSummaryIds: dependencyMemoryIds(index, revision).filter((memoryId) =>
      synopsisNodes.some((entry) => entry.revision.memoryId === memoryId),
    ),
    sourceNodeIds: dependencyMemoryIds(index, revision),
    storyTimeSpan: cloneDomainValue(node.storyTimeSpan, createDefaultStoryTimeSpan()),
    regionHints: uniqueStrings([node.scope?.regionPrimary, ...(node.scope?.regionPath || [])]),
    ownerHints: uniqueStrings([node.scope?.ownerId, node.scope?.ownerName]),
    createdAt: node.createdTime,
    updatedAt: node.updatedAt,
  }));
  const lastFloor = entries.reduce((max, entry) => Math.max(max, Number(entry.messageRange?.[1] ?? -1)), -1);
  graph.summaryState = createDefaultSummaryState({
    enabled: graph.summaryState?.enabled !== false,
    entries,
    activeEntryIds: entries.map((entry) => entry.id),
    lastSummarizedExtractionCount: entries.length,
    lastSummarizedAssistantFloor: lastFloor,
  });
}

function collectMemoryRefs(value, availableIds, target = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMemoryRefs(entry, availableIds, target));
  } else if (value && typeof value === "object") {
    for (const key of ["memoryId", "nodeId", "ref", "id"]) {
      if (value[key] != null) collectMemoryRefs(value[key], availableIds, target);
    }
  } else {
    const normalized = String(value || "").trim();
    if (availableIds.has(normalized)) target.add(normalized);
  }
  return target;
}

function projectKnowledge(graph) {
  const availableIds = new Set(graph.nodes.map((node) => node.id));
  const preservedOwners = {};
  for (const [ownerKey, owner] of Object.entries(graph.knowledgeState?.owners || {})) {
    if (!(owner.manualKnownNodeIds?.length || owner.manualHiddenNodeIds?.length)) continue;
    preservedOwners[ownerKey] = createDefaultKnowledgeOwnerState({
      ...owner,
      knownNodeIds: [],
      mistakenNodeIds: [],
      visibilityScores: {},
      lastSource: "manual",
    });
  }
  graph.knowledgeState = createDefaultKnowledgeState({ owners: preservedOwners });
  const povNodes = graph.nodes.filter((node) => !node.archived && node.scope?.layer === "pov");
  for (const node of povNodes) {
    const owner = resolveKnowledgeOwner(graph, {
      ownerType: node.scope.ownerType,
      ownerId: node.scope.ownerId,
      ownerName: node.scope.ownerName,
      nodeId: node.scope.ownerId,
    });
    if (!owner.ownerKey) continue;
    const current = graph.knowledgeState.owners[owner.ownerKey] || preservedOwners[owner.ownerKey] || {};
    const aboutIds = collectMemoryRefs(node.fields?.about, availableIds);
    const explicitKnown = collectMemoryRefs(
      node.fields?.knownMemoryIds || node.fields?.knownRefs,
      availableIds,
    );
    const explicitMistaken = collectMemoryRefs(
      node.fields?.mistakenMemoryIds || node.fields?.mistakenRefs,
      availableIds,
    );
    const mistaken = String(node.fields?.certainty || "").trim() === "mistaken";
    const knownNodeIds = uniqueStrings([
      ...(current.knownNodeIds || []),
      node.id,
      ...explicitKnown,
      ...(!mistaken ? aboutIds : []),
    ]);
    const mistakenNodeIds = uniqueStrings([
      ...(current.mistakenNodeIds || []),
      ...explicitMistaken,
      ...(mistaken ? aboutIds : []),
    ]);
    const visibilityScores = { ...(current.visibilityScores || {}), [node.id]: 1 };
    for (const memoryId of knownNodeIds) visibilityScores[memoryId] = Math.max(Number(visibilityScores[memoryId] || 0), 0.95);
    graph.knowledgeState.owners[owner.ownerKey] = createDefaultKnowledgeOwnerState({
      ...current,
      ...owner,
      knownNodeIds,
      mistakenNodeIds,
      visibilityScores,
      updatedAt: Math.max(Number(current.updatedAt || 0), Number(node.updatedAt || 0)),
      lastSource: MEMORY_GRAPH_PROJECTION_AUTHORITY,
    });
  }
  graph.knowledgeState = normalizeKnowledgeState(graph.knowledgeState, graph);
}

function projectRegions(graph) {
  const regions = uniqueStrings(
    [...graph.nodes]
      .filter((node) => !node.archived)
      .sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
      .flatMap((node) => [node.scope?.regionPrimary, ...(node.scope?.regionPath || [])]),
  );
  graph.regionState = createDefaultRegionState({
    ...graph.regionState,
    recentRegions: regions,
  });
  graph.historyState ||= {};
  if (!graph.regionState.manualActiveRegion) {
    graph.historyState.activeRegion = regions[0] || "";
    graph.historyState.activeRegionSource = regions[0] ? MEMORY_GRAPH_PROJECTION_AUTHORITY : "";
  }
  graph.historyState.lastExtractedRegion = regions[0] || "";
  const latestPov = [...graph.nodes]
    .filter((node) => !node.archived && node.scope?.layer === "pov")
    .sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))[0];
  if (latestPov?.scope?.ownerType === "character") {
    graph.historyState.activeCharacterPovOwner = latestPov.scope.ownerName || latestPov.scope.ownerId || "";
  } else if (latestPov?.scope?.ownerType === "user") {
    graph.historyState.activeUserPovOwner = latestPov.scope.ownerName || latestPov.scope.ownerId || "";
  }
}

function projectVectorState(graph, previousGraph, changedNodeIds, deletedNodeIds) {
  const activeNodeIds = new Set(graph.nodes.filter((node) => !node.archived).map((node) => node.id));
  const invalidated = new Set([...changedNodeIds, ...deletedNodeIds]);
  const previousState = cloneDomainValue(previousGraph?.vectorIndexState, {}) || {};
  const nodeToHash = {};
  for (const [nodeId, hash] of Object.entries(previousState.nodeToHash || {})) {
    if (activeNodeIds.has(nodeId) && !invalidated.has(nodeId)) nodeToHash[nodeId] = hash;
  }
  const hashToNodeId = {};
  for (const [hash, nodeId] of Object.entries(previousState.hashToNodeId || {})) {
    if (nodeToHash[nodeId] === hash) hashToNodeId[hash] = nodeId;
  }
  graph.vectorIndexState = {
    ...previousState,
    nodeToHash,
    hashToNodeId,
    replayRequiredNodeIds: uniqueStrings([
      ...(previousState.replayRequiredNodeIds || []).filter((nodeId) => activeNodeIds.has(nodeId)),
      ...changedNodeIds.filter((nodeId) => activeNodeIds.has(nodeId)),
    ]),
  };
  if (invalidated.size > 0) {
    const floors = graph.nodes
      .filter((node) => changedNodeIds.includes(node.id))
      .map((node) => finiteFloor(node.sourceFloor))
      .filter((value) => value !== null);
    graph.vectorIndexState.dirty = true;
    graph.vectorIndexState.dirtyReason = "memory-ledger-projection";
    graph.vectorIndexState.pendingRepairFromFloor = floors.length > 0 ? Math.min(...floors) : 0;
  }
}

export function projectMemoryLedgerToGraph(ledger, previousGraph = null) {
  const view = materializeMemoryLedger(ledger);
  const index = buildMemoryLedgerIndex(ledger);
  const graph = cloneDomainValue(previousGraph, null) || createEmptyGraph();
  const existingNodes = new Map((previousGraph?.nodes || []).map((node) => [node.id, node]));
  const existingEdges = new Map((previousGraph?.edges || []).map((edge) => [edge.id, edge]));
  const memoryRecords = index.recordsByKind.get(MEMORY_RECORD_KIND.MEMORY_REVISION) || [];
  const relationRecords = index.recordsByKind.get(MEMORY_RECORD_KIND.RELATION_REVISION) || [];
  const memoryOrigins = buildOriginTimes(memoryRecords, (record) => record.memoryId);
  const relationOrigins = buildOriginTimes(relationRecords, (record) => record.relationId);
  const evidenceCache = new Map();
  const activeMemoryIds = new Set(view.memories.active.map((revision) => revision.memoryId));
  const activeRelationIds = new Set(view.relations.active.map((revision) => revision.relationId));
  const memoryHeads = [...view.memories.heads.values()].sort(compareRevisionOrder);
  graph.nodes = memoryHeads.map((revision) =>
    createProjectedNode({
      revision,
      active: activeMemoryIds.has(revision.memoryId),
      existing: existingNodes.get(revision.memoryId),
      range: deriveRevisionRange(index, revision, evidenceCache),
      originTime: memoryOrigins.get(revision.memoryId),
    }),
  );
  rebuildNodeChains(graph.nodes);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const relationHeads = [...view.relations.heads.values()]
    .filter((revision) => nodeById.has(revision.fromMemoryId) && nodeById.has(revision.toMemoryId))
    .sort(compareRevisionOrder);
  graph.edges = relationHeads.map((revision) =>
    createProjectedEdge({
      revision,
      active: activeRelationIds.has(revision.relationId),
      existing: existingEdges.get(revision.relationId),
      range: deriveRevisionRange(index, revision, evidenceCache),
      originTime: relationOrigins.get(revision.relationId),
      nodeById,
    }),
  );

  const nextNodeIds = new Set(graph.nodes.map((node) => node.id));
  const nextEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const changedNodeIds = graph.nodes
    .filter((node) => existingNodes.get(node.id)?.memoryRevisionId !== node.memoryRevisionId)
    .map((node) => node.id);
  const deletedNodeIds = [...existingNodes.keys()].filter((nodeId) => !nextNodeIds.has(nodeId));
  const changedEdgeIds = graph.edges
    .filter((edge) => existingEdges.get(edge.id)?.relationRevisionId !== edge.relationRevisionId)
    .map((edge) => edge.id);
  const deletedEdgeIds = [...existingEdges.keys()].filter((edgeId) => !nextEdgeIds.has(edgeId));

  graph.historyState ||= {};
  const activeFloors = view.evidence.activeEvidence
    .map((record) => finiteFloor(record.source?.assistantFloor ?? record.source?.userFloor))
    .filter((value) => value !== null);
  graph.historyState.chatId = ledger.chatId;
  graph.historyState.lastProcessedAssistantFloor = activeFloors.length > 0 ? Math.max(...activeFloors) : -1;
  graph.historyState.lastMutationSource = "memory-ledger-projection";
  graph.lastProcessedSeq = graph.historyState.lastProcessedAssistantFloor;

  projectTimeline(graph, ledger.chatId);
  projectSummaries(graph, index, memoryHeads);
  projectKnowledge(graph);
  projectRegions(graph);
  projectVectorState(graph, previousGraph, changedNodeIds, deletedNodeIds);

  const stateFingerprint = fingerprintMaterializedMemoryState(view);
  graph.memoryProjection = {
    authority: MEMORY_GRAPH_PROJECTION_AUTHORITY,
    chatId: ledger.chatId,
    ledgerRevision: Number(ledger.revision || 0),
    stateFingerprint,
    projectedAt: Number(ledger.updatedAt || 0),
  };
  normalizeGraphRuntimeState(graph, ledger.chatId);
  const changed =
    changedNodeIds.length > 0 ||
    deletedNodeIds.length > 0 ||
    changedEdgeIds.length > 0 ||
    deletedEdgeIds.length > 0 ||
    previousGraph?.memoryProjection?.stateFingerprint !== stateFingerprint;
  return {
    graph,
    view,
    changed,
    stateFingerprint,
    changedNodeIds,
    deletedNodeIds,
    changedEdgeIds,
    deletedEdgeIds,
  };
}
