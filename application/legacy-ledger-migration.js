import {
  MEMORY_LAYER,
  MEMORY_RECORD_KIND,
  MEMORY_REVISION_STATUS,
} from "../domain/memory-contract.js";
import { assignHistoryTurnIds } from "../domain/history-reconciliation.js";
import {
  cloneDomainValue,
  createDomainId,
  hashDomainValue,
} from "../domain/memory-id.js";
import { buildMemoryLedgerIndex } from "../domain/memory-ledger.js";
import {
  createMemoryRevision,
  createMigrationRecord,
  createRelationRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";

export const LEGACY_GRAPH_MIGRATION_ID = "legacy-graph-to-ledger";
export const LEGACY_GRAPH_CONVERTER_VERSION = "1";

function finiteFloor(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function legacyRange(value = {}, fallback = 0) {
  const raw = Array.isArray(value?.seqRange) ? value.seqRange : [];
  const start = finiteFloor(raw[0] ?? value?.seq ?? fallback);
  const end = finiteFloor(raw[1] ?? value?.seq ?? fallback);
  const safeStart = start ?? end ?? Math.max(0, Number(fallback) || 0);
  const safeEnd = end ?? start ?? safeStart;
  return safeStart <= safeEnd ? [safeStart, safeEnd] : [safeEnd, safeStart];
}

function validTimestamp(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return 0;
}

function activeLegacyNodes(graph = {}) {
  return (Array.isArray(graph?.nodes) ? graph.nodes : [])
    .filter((node) => node && String(node.id || "").trim() && String(node.type || "").trim())
    .map((node) => cloneDomainValue(node, {}));
}

function canonicalLegacySource(graph = {}) {
  const nodes = activeLegacyNodes(graph)
    .map((node) => ({
      id: String(node.id || ""),
      type: String(node.type || ""),
      archived: node.archived === true,
      fields: cloneDomainValue(node.fields, {}),
      scope: cloneDomainValue(node.scope, {}),
      storyTime: cloneDomainValue(node.storyTime, {}),
      seqRange: legacyRange(node),
      importance: Number(node.importance ?? 5),
      createdTime: Number(node.createdTime || 0),
      updatedAt: Number(node.updatedAt || 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(graph?.edges) ? graph.edges : [])
    .filter(
      (edge) =>
        edge &&
        String(edge.id || "").trim() &&
        String(edge.relation || "").trim() &&
        nodeIds.has(String(edge.fromId || "")) &&
        nodeIds.has(String(edge.toId || "")),
    )
    .map((edge) => ({
      id: String(edge.id || ""),
      fromId: String(edge.fromId || ""),
      toId: String(edge.toId || ""),
      relation: String(edge.relation || ""),
      strength: Number(edge.strength ?? 0.5),
      invalidAt: edge.invalidAt ?? null,
      expiredAt: edge.expiredAt ?? null,
      scope: cloneDomainValue(edge.scope, {}),
      edgeType: edge.edgeType ?? 0,
      validAt: edge.validAt ?? null,
      createdTime: Number(edge.createdTime || 0),
      updatedAt: Number(edge.updatedAt || 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return { version: Number(graph?.version || 0), nodes, edges };
}

function evidenceForRange(assignedTurns, range) {
  const [start, end] = range;
  return assignedTurns
    .filter((turn) => {
      const floor = finiteFloor(turn?.assistantFloor);
      return floor !== null && floor >= start && floor <= end;
    })
    .map((turn) => turn.evidence);
}

function syntheticEvidence({ chatId, node, range, now }) {
  const legacyNodeId = String(node.id || "");
  const description = String(
    node?.fields?.summary ||
      node?.fields?.content ||
      node?.fields?.description ||
      node?.fields?.name ||
      `${node.type} ${legacyNodeId}`,
  ).trim();
  return createTurnEvidence({
    chatId,
    turnId: createDomainId("legacy-evidence-turn", { chatId, legacyNodeId }),
    userText: "",
    assistantText: description || `Imported legacy memory ${legacyNodeId}`,
    userFloor: range[0],
    assistantFloor: range[1],
    metadata: {
      provenance: "legacy-graph-import",
      historyManaged: false,
      legacyUnmatched: true,
      legacyNodeId,
      legacySeqRange: range,
    },
    createdAt: validTimestamp(node.createdTime, node.updatedAt, now),
  });
}

function withManagedHistoryMetadata(evidence) {
  return {
    ...cloneDomainValue(evidence, evidence),
    metadata: {
      ...cloneDomainValue(evidence?.metadata, {}),
      provenance: "chat-history",
      historyManaged: true,
    },
  };
}

export function planLegacyGraphMigration(
  ledger,
  {
    legacyGraph = {},
    conversationSnapshot = {},
    legacySourceReady = false,
    converterVersion = LEGACY_GRAPH_CONVERTER_VERSION,
    now = Date.now(),
  } = {},
) {
  const index = buildMemoryLedgerIndex(ledger);
  const previous = (index.recordsByKind.get(MEMORY_RECORD_KIND.MIGRATION) || [])
    .find((record) => record.migrationId === LEGACY_GRAPH_MIGRATION_ID);
  if (previous) {
    return {
      changed: false,
      migrated: false,
      alreadyMigrated: true,
      marker: previous,
      transaction: null,
      diagnostics: cloneDomainValue(previous.metadata?.diagnostics, {}),
    };
  }

  // The host exposes an empty graph both for a genuinely empty chat and while
  // a legacy primary is still loading. Only the composition root can tell
  // those states apart, so never seal this one-time migration until it has
  // explicitly confirmed that the source load completed.
  if (legacySourceReady !== true) {
    return {
      changed: false,
      migrated: false,
      alreadyMigrated: false,
      migrationDeferred: true,
      reason: "legacy-source-not-ready",
      marker: null,
      transaction: null,
      diagnostics: {},
    };
  }

  const canonicalSource = canonicalLegacySource(legacyGraph);
  const sourceFingerprint = hashDomainValue(canonicalSource);
  const assignedTurns = assignHistoryTurnIds(
    ledger,
    conversationSnapshot?.turns || [],
    { now },
  );
  const existingRecordIds = index.recordsById;
  const records = [];
  const evidenceById = new Map();
  const memoryRevisionByLegacyId = new Map();
  const memoryIdByLegacyId = new Map();
  const unmatchedLegacyNodeIds = [];

  for (const node of canonicalSource.nodes) {
    const range = legacyRange(node);
    let evidence = evidenceForRange(assignedTurns, range).map(withManagedHistoryMetadata);
    if (evidence.length === 0) {
      evidence = [syntheticEvidence({ chatId: ledger.chatId, node, range, now })];
      unmatchedLegacyNodeIds.push(node.id);
    }
    for (const item of evidence) {
      if (!existingRecordIds.has(item.id) && !evidenceById.has(item.id)) {
        evidenceById.set(item.id, item);
      }
    }
    const memoryId = String(node.id || "");
    memoryIdByLegacyId.set(node.id, memoryId);
    const revision = createMemoryRevision({
      chatId: ledger.chatId,
      memoryId,
      memoryType: node.type,
      layer: node?.scope?.layer === MEMORY_LAYER.POV ? MEMORY_LAYER.POV : MEMORY_LAYER.OBJECTIVE,
      status: node.archived === true
        ? MEMORY_REVISION_STATUS.ARCHIVED
        : MEMORY_REVISION_STATUS.ACTIVE,
      fields: cloneDomainValue(node.fields, {}),
      scope: cloneDomainValue(node.scope, {}),
      storyTime: cloneDomainValue(node.storyTime, {}),
      evidenceIds: evidence.map((item) => item.id),
      importance: node.importance,
      confidence: 1,
      reason: "legacy-graph-import",
      createdAt: validTimestamp(node.createdTime, node.updatedAt, now),
    });
    const effectiveRevision = existingRecordIds.get(revision.id) || revision;
    memoryRevisionByLegacyId.set(node.id, effectiveRevision);
    if (!existingRecordIds.has(revision.id)) records.push(revision);
  }

  records.unshift(...evidenceById.values());

  const skippedEdgeIds = [];
  for (const edge of canonicalSource.edges) {
    const fromMemoryId = memoryIdByLegacyId.get(edge.fromId);
    const toMemoryId = memoryIdByLegacyId.get(edge.toId);
    const fromRevision = memoryRevisionByLegacyId.get(edge.fromId);
    const toRevision = memoryRevisionByLegacyId.get(edge.toId);
    if (!fromMemoryId || !toMemoryId) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const evidenceIds = [
      ...(fromRevision?.evidenceIds || []),
      ...(toRevision?.evidenceIds || []),
    ].filter((value, position, values) => value && values.indexOf(value) === position);
    const dependencyRevisionIds = evidenceIds.length > 0
      ? []
      : [fromRevision?.id, toRevision?.id].filter(Boolean);
    if (evidenceIds.length === 0 && dependencyRevisionIds.length === 0) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const revision = createRelationRevision({
      chatId: ledger.chatId,
      relationId: String(edge.id || ""),
      fromMemoryId,
      toMemoryId,
      relation: edge.relation,
      status: edge.invalidAt || edge.expiredAt
        ? MEMORY_REVISION_STATUS.ARCHIVED
        : MEMORY_REVISION_STATUS.ACTIVE,
      evidenceIds,
      dependencyRevisionIds,
      strength: edge.strength,
      metadata: {
        provenance: "legacy-graph-import",
        legacyEdgeType: edge.edgeType,
        legacyScope: cloneDomainValue(edge.scope, {}),
        legacyTemporal: {
          validAt: edge.validAt,
          invalidAt: edge.invalidAt,
          expiredAt: edge.expiredAt,
        },
      },
      createdAt: validTimestamp(edge.createdTime, edge.updatedAt, now),
    });
    if (!existingRecordIds.has(revision.id)) records.push(revision);
  }

  const diagnostics = {
    sourceNodeCount: canonicalSource.nodes.length,
    sourceEdgeCount: canonicalSource.edges.length,
    importedEvidenceCount: evidenceById.size,
    importedMemoryCount: memoryRevisionByLegacyId.size,
    importedRelationCount: records.filter(
      (record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION,
    ).length,
    unmatchedLegacyNodeIds,
    skippedEdgeIds,
  };
  const marker = createMigrationRecord({
    chatId: ledger.chatId,
    migrationId: LEGACY_GRAPH_MIGRATION_ID,
    sourceKind: "legacy-graph",
    sourceVersion: String(canonicalSource.version || ""),
    converterVersion,
    sourceFingerprint,
    importedRecordIds: records.map((record) => record.id),
    metadata: {
      legacySourceReady: true,
      historyFingerprint: String(conversationSnapshot?.historyFingerprint || ""),
      diagnostics,
    },
    createdAt: now,
  });
  records.push(marker);
  return {
    changed: true,
    migrated: true,
    alreadyMigrated: false,
    marker,
    records,
    diagnostics,
    sourceFingerprint,
    transaction: {
      baseRevision: ledger.revision,
      idempotencyKey: `legacy-graph-import:${converterVersion}:${sourceFingerprint}`,
      records,
      sourceEvidenceIds: [...evidenceById.keys()],
      reason: "legacy-graph-to-ledger",
      now,
    },
  };
}

export class LegacyLedgerMigrationService {
  constructor({ ledgerRepository, now = () => Date.now() } = {}) {
    if (!ledgerRepository || typeof ledgerRepository.transact !== "function") {
      throw new TypeError("LegacyLedgerMigrationService requires ledgerRepository");
    }
    this.ledgerRepository = ledgerRepository;
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  async migrate(chatId, legacyGraph, conversationSnapshot, options = {}) {
    const migratedAt = options.now ?? this.now();
    let latestPlan = null;
    const committed = await this.ledgerRepository.transact(chatId, (ledger) => {
      latestPlan = planLegacyGraphMigration(ledger, {
        legacyGraph,
        conversationSnapshot,
        legacySourceReady: options.legacySourceReady === true,
        converterVersion:
          options.converterVersion || LEGACY_GRAPH_CONVERTER_VERSION,
        now: migratedAt,
      });
      return latestPlan.transaction;
    });
    return { ...committed, plan: latestPlan };
  }
}
