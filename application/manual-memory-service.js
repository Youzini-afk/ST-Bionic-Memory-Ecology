import {
  MEMORY_LAYER,
  MEMORY_RECORD_KIND,
  MEMORY_REVISION_STATUS,
} from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  createDomainId,
  hashDomainValue,
  stableStringify,
} from "../domain/memory-id.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import {
  createMemoryRevision,
  createRelationRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function finiteFloor(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function nodeRange(node = {}) {
  const range = Array.isArray(node?.seqRange) ? node.seqRange : [];
  const start = finiteFloor(range[0] ?? node?.seq);
  const end = finiteFloor(range[1] ?? node?.seq);
  const safeStart = start ?? end ?? 0;
  const safeEnd = end ?? start ?? safeStart;
  return safeStart <= safeEnd ? [safeStart, safeEnd] : [safeEnd, safeStart];
}

function nodeDescription(node = {}) {
  const fields = node?.fields || {};
  return String(
    fields.summary ||
      fields.content ||
      fields.description ||
      fields.name ||
      `${String(node?.type || "memory")} ${String(node?.id || "")}`,
  ).trim();
}

function normalizedNode(node = {}) {
  const id = String(node?.id || "").trim();
  const memoryType = String(node?.type || "").trim();
  if (!id || !memoryType) return null;
  return {
    id,
    memoryType,
    layer: node?.scope?.layer === MEMORY_LAYER.POV ? MEMORY_LAYER.POV : MEMORY_LAYER.OBJECTIVE,
    status: node?.archived === true
      ? MEMORY_REVISION_STATUS.ARCHIVED
      : MEMORY_REVISION_STATUS.ACTIVE,
    fields: cloneDomainValue(node?.fields, {}),
    scope: cloneDomainValue(node?.scope, {}),
    storyTime: cloneDomainValue(node?.storyTime, {}),
    importance: Number.isFinite(Number(node?.importance)) ? Number(node.importance) : 5,
    range: nodeRange(node),
  };
}

function normalizedEdge(edge = {}, nodeIds = new Set()) {
  const id = String(edge?.id || "").trim();
  const fromMemoryId = String(edge?.fromId || "").trim();
  const toMemoryId = String(edge?.toId || "").trim();
  const relation = String(edge?.relation || "").trim();
  if (
    !id ||
    !fromMemoryId ||
    !toMemoryId ||
    !relation ||
    !nodeIds.has(fromMemoryId) ||
    !nodeIds.has(toMemoryId)
  ) {
    return null;
  }
  return {
    id,
    fromMemoryId,
    toMemoryId,
    relation,
    status: edge?.invalidAt || edge?.expiredAt
      ? MEMORY_REVISION_STATUS.ARCHIVED
      : MEMORY_REVISION_STATUS.ACTIVE,
    strength: Number.isFinite(Number(edge?.strength)) ? Number(edge.strength) : 0.5,
    metadata: {
      provenance: "manual-graph-import",
      importedEdgeType: edge?.edgeType ?? 0,
      importedScope: cloneDomainValue(edge?.scope, {}),
      importedTemporal: {
        validAt: edge?.validAt ?? null,
        invalidAt: edge?.invalidAt ?? null,
        expiredAt: edge?.expiredAt ?? null,
      },
    },
  };
}

function sameMemorySnapshot(head, node) {
  return Boolean(
    head &&
      head.memoryType === node.memoryType &&
      head.layer === node.layer &&
      head.status === node.status &&
      Number(head.importance) === Math.max(0, Math.min(10, Number(node.importance))) &&
      stableStringify(head.fields || {}) === stableStringify(node.fields || {}) &&
      stableStringify(head.scope || {}) === stableStringify(node.scope || {}) &&
      stableStringify(head.storyTime || {}) === stableStringify(node.storyTime || {}),
  );
}

function sameRelationSnapshot(head, edge) {
  return Boolean(
    head &&
      head.fromMemoryId === edge.fromMemoryId &&
      head.toMemoryId === edge.toMemoryId &&
      head.relation === edge.relation &&
      head.status === edge.status &&
      Number(head.strength) === Math.max(0, Math.min(1, Number(edge.strength))),
  );
}

function latestRawRevisionHeads(ledger, kind, identityKey) {
  const heads = new Map();
  for (const record of ledger?.records || []) {
    if (record?.kind !== kind) continue;
    const key = String(record?.[identityKey] || "").trim();
    if (key) heads.set(key, record);
  }
  return heads;
}

function createManualActionEvidence(chatId, actionId, reason, createdAt) {
  return createTurnEvidence({
    chatId,
    turnId: createDomainId("manual-memory-action-turn", { chatId, actionId }),
    userText: "",
    assistantText: `Manual memory action: ${String(reason || "update")}`,
    metadata: {
      provenance: "manual-memory-action",
      historyManaged: false,
      actionId,
      reason: String(reason || "update"),
    },
    createdAt,
  });
}

function archiveMemoryRevision(chatId, head, reason, createdAt, evidenceIds = null) {
  const hasManualEvidence = Array.isArray(evidenceIds) && evidenceIds.length > 0;
  return createMemoryRevision({
    chatId,
    memoryId: head.memoryId,
    parentRevisionId: head.id,
    memoryType: head.memoryType,
    layer: head.layer,
    status: MEMORY_REVISION_STATUS.ARCHIVED,
    fields: cloneDomainValue(head.fields, {}),
    scope: cloneDomainValue(head.scope, {}),
    storyTime: cloneDomainValue(head.storyTime, {}),
    evidenceIds: hasManualEvidence ? evidenceIds : head.evidenceIds,
    dependencyRevisionIds: hasManualEvidence ? [] : head.dependencyRevisionIds,
    importance: head.importance,
    confidence: head.confidence,
    reason,
    createdAt,
  });
}

function archiveRelationRevision(chatId, head, reason, createdAt, evidenceIds = null) {
  const hasManualEvidence = Array.isArray(evidenceIds) && evidenceIds.length > 0;
  return createRelationRevision({
    chatId,
    relationId: head.relationId,
    parentRevisionId: head.id,
    fromMemoryId: head.fromMemoryId,
    toMemoryId: head.toMemoryId,
    relation: head.relation,
    status: MEMORY_REVISION_STATUS.ARCHIVED,
    evidenceIds: hasManualEvidence ? evidenceIds : head.evidenceIds,
    dependencyRevisionIds: hasManualEvidence ? [] : head.dependencyRevisionIds,
    strength: head.strength,
    metadata: { ...cloneDomainValue(head.metadata, {}), archivedBy: reason },
    createdAt,
  });
}

export class ManualMemoryService {
  constructor({ repository, now = () => Date.now() } = {}) {
    if (!repository || typeof repository.transact !== "function") {
      throw new TypeError("ManualMemoryService requires a memory ledger repository");
    }
    this.repository = repository;
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  async revise(chatId, memoryId, updates = {}) {
    let revision = null;
    const committed = await this.repository.transact(chatId, (ledger) => {
      const head = materializeMemoryLedger(ledger).memories.heads.get(memoryId);
      if (!head) throw new Error(`memory not found: ${memoryId}`);
      const fields = updates.fields && typeof updates.fields === "object"
        ? { ...cloneDomainValue(head.fields, {}), ...cloneDomainValue(updates.fields, {}) }
        : cloneDomainValue(head.fields, {});
      revision = createMemoryRevision({
        chatId,
        memoryId,
        parentRevisionId: head.id,
        memoryType: String(updates.type || updates.memoryType || head.memoryType),
        layer: updates.layer || updates.scope?.layer || head.layer,
        status: updates.archived === true
          ? MEMORY_REVISION_STATUS.ARCHIVED
          : MEMORY_REVISION_STATUS.ACTIVE,
        fields,
        scope: updates.scope
          ? { ...cloneDomainValue(head.scope, {}), ...cloneDomainValue(updates.scope, {}) }
          : cloneDomainValue(head.scope, {}),
        storyTime: updates.storyTime
          ? { ...cloneDomainValue(head.storyTime, {}), ...cloneDomainValue(updates.storyTime, {}) }
          : cloneDomainValue(head.storyTime, {}),
        evidenceIds: head.evidenceIds,
        dependencyRevisionIds: head.dependencyRevisionIds,
        importance: updates.importance ?? head.importance,
        confidence: updates.confidence ?? head.confidence,
        reason: "manual-memory-edit",
        createdAt: this.now(),
      });
      return {
        baseRevision: ledger.revision,
        idempotencyKey: `manual-memory-edit:${hashDomainValue({ parent: head.id, revision })}`,
        records: [revision],
        readRecordIds: [head.id],
        sourceEvidenceIds: revision.evidenceIds,
        reason: "manual-memory-edit",
        now: revision.createdAt,
      };
    });
    return { ...committed, revision };
  }

  async archive(chatId, memoryId) {
    return await this.revise(chatId, memoryId, { archived: true });
  }

  async archiveMany(
    chatId,
    memoryIds = [],
    { reason = "manual-memory-archive-many", all = false } = {},
  ) {
    const requestedIds = new Set(uniqueStrings(memoryIds));
    let archivedMemoryIds = [];
    let archivedRelationIds = [];
    const committed = await this.repository.transact(chatId, (ledger) => {
      const createdAt = this.now();
      const memoryHeads = latestRawRevisionHeads(
        ledger,
        MEMORY_RECORD_KIND.MEMORY_REVISION,
        "memoryId",
      );
      const relationHeads = latestRawRevisionHeads(
        ledger,
        MEMORY_RECORD_KIND.RELATION_REVISION,
        "relationId",
      );
      const selectedHeads = [...memoryHeads.values()].filter(
        (head) =>
          (all === true || requestedIds.has(head.memoryId)) &&
          head.status !== MEMORY_REVISION_STATUS.ARCHIVED,
      );
      archivedMemoryIds = selectedHeads.map((head) => head.memoryId);
      const selectedMemoryIds = new Set(archivedMemoryIds);
      const selectedRelations = [...relationHeads.values()].filter(
        (head) =>
          head.status !== MEMORY_REVISION_STATUS.ARCHIVED &&
          (all === true ||
            selectedMemoryIds.has(head.fromMemoryId) ||
            selectedMemoryIds.has(head.toMemoryId)),
      );
      archivedRelationIds = selectedRelations.map((head) => head.relationId);
      if (selectedHeads.length === 0 && selectedRelations.length === 0) return null;
      const actionId = createDomainId("manual-memory-archive", {
        chatId,
        reason,
        memoryHeadIds: selectedHeads.map((head) => head.id),
        relationHeadIds: selectedRelations.map((head) => head.id),
      });
      const actionEvidence = createManualActionEvidence(
        chatId,
        actionId,
        reason,
        createdAt,
      );
      const records = [
        actionEvidence,
        ...selectedHeads.map((head) =>
          archiveMemoryRevision(chatId, head, reason, createdAt, [actionEvidence.id]),
        ),
        ...selectedRelations.map((head) =>
          archiveRelationRevision(chatId, head, reason, createdAt, [actionEvidence.id]),
        ),
      ];
      return {
        baseRevision: ledger.revision,
        idempotencyKey: `${reason}:${hashDomainValue({
          memoryHeads: selectedHeads.map((head) => head.id),
          relationHeads: selectedRelations.map((head) => head.id),
        })}`,
        records,
        readRecordIds: [
          ...selectedHeads.map((head) => head.id),
          ...selectedRelations.map((head) => head.id),
        ],
        sourceEvidenceIds: [actionEvidence.id],
        reason,
        now: createdAt,
      };
    });
    return { ...committed, archivedMemoryIds, archivedRelationIds };
  }

  async archiveAll(chatId, options = {}) {
    return await this.archiveMany(chatId, [], {
      reason: options.reason || "manual-memory-archive-all",
      all: true,
    });
  }

  async replaceWithGraphSnapshot(
    chatId,
    graph = {},
    { reason = "manual-graph-import" } = {},
  ) {
    const sourceNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const nodes = sourceNodes
      .map(normalizedNode)
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (nodes.length !== sourceNodes.length) {
      throw new TypeError("graph import contains a memory without id or type");
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length) {
      throw new TypeError("graph import contains duplicate memory ids");
    }
    const sourceEdges = Array.isArray(graph?.edges) ? graph.edges : [];
    const edges = sourceEdges
      .map((edge) => normalizedEdge(edge, nodeIds))
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (edges.length !== sourceEdges.length) {
      throw new TypeError("graph import contains an invalid relation or endpoint");
    }
    if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
      throw new TypeError("graph import contains duplicate relation ids");
    }
    const sourceFingerprint = hashDomainValue({ nodes, edges });
    const importId = createDomainId("manual-graph-import", {
      chatId,
      sourceFingerprint,
    });
    let diagnostics = null;
    const committed = await this.repository.transact(chatId, (ledger) => {
      const view = materializeMemoryLedger(ledger);
      const memoryHeads = latestRawRevisionHeads(
        ledger,
        MEMORY_RECORD_KIND.MEMORY_REVISION,
        "memoryId",
      );
      const relationHeads = latestRawRevisionHeads(
        ledger,
        MEMORY_RECORD_KIND.RELATION_REVISION,
        "relationId",
      );
      const createdAt = this.now();
      const existingRecordIds = new Set((ledger.records || []).map((record) => record.id));
      const records = [];
      const evidenceIdsByMemoryId = new Map();
      const effectiveMemoryRevisionById = new Map();
      const importedRelationIds = new Set(edges.map((edge) => edge.id));

      for (const node of nodes) {
        const head = memoryHeads.get(node.id) || null;
        const headValidation = head ? view.validationByRevisionId.get(head.id) : null;
        if (sameMemorySnapshot(head, node) && headValidation?.valid === true) {
          evidenceIdsByMemoryId.set(node.id, uniqueStrings(head.evidenceIds));
          effectiveMemoryRevisionById.set(node.id, head);
          continue;
        }
        const evidence = createTurnEvidence({
          chatId,
          turnId: createDomainId("manual-graph-import-turn", {
            chatId,
            importId,
            memoryId: node.id,
          }),
          userText: "",
          assistantText: nodeDescription(node) || `Imported memory ${node.id}`,
          userFloor: node.range[0],
          assistantFloor: node.range[1],
          metadata: {
            provenance: "manual-graph-import",
            historyManaged: false,
            importId,
            importedMemoryId: node.id,
            importedSeqRange: node.range,
          },
          createdAt,
        });
        if (!existingRecordIds.has(evidence.id)) {
          records.push(evidence);
          existingRecordIds.add(evidence.id);
        }
        const revision = createMemoryRevision({
          chatId,
          memoryId: node.id,
          parentRevisionId: head?.id || "",
          memoryType: node.memoryType,
          layer: node.layer,
          status: node.status,
          fields: node.fields,
          scope: node.scope,
          storyTime: node.storyTime,
          evidenceIds: [evidence.id],
          importance: node.importance,
          confidence: 1,
          reason,
          createdAt,
        });
        if (!existingRecordIds.has(revision.id)) {
          records.push(revision);
          existingRecordIds.add(revision.id);
        }
        evidenceIdsByMemoryId.set(node.id, [evidence.id]);
        effectiveMemoryRevisionById.set(node.id, revision);
      }

      const importedMemoryIds = new Set(nodes.map((node) => node.id));
      const removedMemoryHeads = [...memoryHeads.values()].filter(
        (head) =>
          head.status !== MEMORY_REVISION_STATUS.ARCHIVED &&
          !importedMemoryIds.has(head.memoryId),
      );
      const removedRelationHeads = [...relationHeads.values()].filter(
        (head) =>
          head.status !== MEMORY_REVISION_STATUS.ARCHIVED &&
          !importedRelationIds.has(head.relationId),
      );
      let removalEvidence = null;
      if (removedMemoryHeads.length > 0 || removedRelationHeads.length > 0) {
        removalEvidence = createManualActionEvidence(
          chatId,
          createDomainId("manual-graph-import-removal", { chatId, importId }),
          `${reason}:remove-missing`,
          createdAt,
        );
        if (!existingRecordIds.has(removalEvidence.id)) {
          records.push(removalEvidence);
          existingRecordIds.add(removalEvidence.id);
        }
      }
      for (const head of removedMemoryHeads) {
        const revision = archiveMemoryRevision(
          chatId,
          head,
          reason,
          createdAt,
          [removalEvidence.id],
        );
        if (!existingRecordIds.has(revision.id)) {
          records.push(revision);
          existingRecordIds.add(revision.id);
        }
      }

      let importedRelationCount = 0;
      for (const edge of edges) {
        const head = relationHeads.get(edge.id) || null;
        const headValidation = head ? view.validationByRevisionId.get(head.id) : null;
        if (sameRelationSnapshot(head, edge) && headValidation?.valid === true) continue;
        const evidenceIds = uniqueStrings([
          ...(evidenceIdsByMemoryId.get(edge.fromMemoryId) || []),
          ...(evidenceIdsByMemoryId.get(edge.toMemoryId) || []),
        ]);
        const dependencyRevisionIds = evidenceIds.length > 0
          ? []
          : uniqueStrings([
              effectiveMemoryRevisionById.get(edge.fromMemoryId)?.id,
              effectiveMemoryRevisionById.get(edge.toMemoryId)?.id,
            ]);
        const revision = createRelationRevision({
          chatId,
          relationId: edge.id,
          parentRevisionId: head?.id || "",
          fromMemoryId: edge.fromMemoryId,
          toMemoryId: edge.toMemoryId,
          relation: edge.relation,
          status: edge.status,
          evidenceIds,
          dependencyRevisionIds,
          strength: edge.strength,
          metadata: edge.metadata,
          createdAt,
        });
        if (!existingRecordIds.has(revision.id)) {
          records.push(revision);
          existingRecordIds.add(revision.id);
          importedRelationCount += 1;
        }
      }

      for (const head of removedRelationHeads) {
        const revision = archiveRelationRevision(
          chatId,
          head,
          reason,
          createdAt,
          [removalEvidence.id],
        );
        if (!existingRecordIds.has(revision.id)) {
          records.push(revision);
          existingRecordIds.add(revision.id);
        }
      }

      diagnostics = {
        sourceFingerprint,
        sourceNodeCount: nodes.length,
        sourceEdgeCount: edges.length,
        appendedRecordCount: records.length,
        importedMemoryCount: nodes.filter(
          (node) => {
            const head = memoryHeads.get(node.id);
            return !(
              sameMemorySnapshot(head, node) &&
              view.validationByRevisionId.get(head?.id)?.valid === true
            );
          },
        ).length,
        importedRelationCount,
        archivedMemoryCount: removedMemoryHeads.length,
        archivedRelationCount: removedRelationHeads.length,
      };
      if (records.length === 0) return null;
      return {
        baseRevision: ledger.revision,
        idempotencyKey: `${reason}:${sourceFingerprint}:${hashDomainValue(
          records.map((record) => record.id),
        )}`,
        records,
        readRecordIds: uniqueStrings([
          ...nodes.map((node) => memoryHeads.get(node.id)?.id),
          ...edges.map((edge) => relationHeads.get(edge.id)?.id),
          ...removedMemoryHeads.map((head) => head.id),
          ...removedRelationHeads.map((head) => head.id),
        ]),
        sourceEvidenceIds: uniqueStrings(
          records.flatMap((record) =>
            record.kind === MEMORY_RECORD_KIND.EVIDENCE
              ? [record.id]
              : record.evidenceIds || [],
          ),
        ),
        reason,
        now: createdAt,
      };
    });
    return { ...committed, diagnostics };
  }
}
