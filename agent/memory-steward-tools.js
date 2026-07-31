import {
  createMemoryChangeSet,
  fingerprintMaterializedMemoryState,
  planMemoryChangeSetCommit,
  validateMemoryChangeSet,
} from "../domain/memory-changeset.js";
import { MEMORY_RECORD_KIND } from "../domain/memory-contract.js";
import { cloneDomainValue, createDomainId } from "../domain/memory-id.js";
import { MemoryLedgerConflictError } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import {
  createMemoryCatalogSnapshot,
  inspectMemoryNeighbors,
  inspectMemoryRecords,
  searchMemoryCatalog,
} from "../domain/memory-query.js";
import { BmeAgentError } from "./errors.js";

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function toolDefinition(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function stringArraySchema(description = "") {
  return { type: "array", items: { type: "string" }, description };
}

function parseEvidenceCursor(cursor, fingerprint) {
  const normalized = String(cursor || "").trim();
  if (!normalized) return 0;
  const [cursorFingerprint, rawOffset] = normalized.split(":");
  const offset = Number(rawOffset);
  if (cursorFingerprint !== fingerprint || !Number.isInteger(offset) || offset < 0) {
    throw new BmeAgentError("Evidence cursor is stale or invalid", {
      code: "memory_steward_cursor_stale",
    });
  }
  return offset;
}

export class MemoryStewardStateChangedError extends BmeAgentError {
  constructor(details = {}) {
    super("Memory state changed while the Memory Steward was working; refresh and replan", {
      code: "memory_steward_state_changed",
      details,
    });
    this.name = "MemoryStewardStateChangedError";
  }
}

export class MemoryStewardToolset {
  constructor({ repository, semanticSearch = null, now = () => Date.now() } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("MemoryStewardToolset requires a memory ledger repository");
    }
    this.repository = repository;
    this.semanticSearch = typeof semanticSearch === "function" ? semanticSearch : null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.workspaces = new Map();
  }

  openTask({ runId, chatId, taskId, inboxIds = [], sourceEvidenceIds = [] } = {}) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) throw new TypeError("Memory Steward task requires runId");
    if (this.workspaces.has(normalizedRunId)) {
      throw new Error(`Memory Steward workspace already exists: ${normalizedRunId}`);
    }
    const workspace = {
      runId: normalizedRunId,
      chatId: String(chatId || "").trim(),
      taskId: String(taskId || "").trim(),
      inboxIds: [...new Set((inboxIds || []).map(String).filter(Boolean))],
      sourceEvidenceIds: new Set((sourceEvidenceIds || []).map(String).filter(Boolean)),
      readRecordIds: new Set((sourceEvidenceIds || []).map(String).filter(Boolean)),
      observedStateFingerprint: "",
      observedLedgerRevision: 0,
      stagedChangeSet: null,
      stageSequence: 0,
      outcome: { kind: "pending" },
    };
    if (!workspace.chatId || !workspace.taskId) {
      throw new TypeError("Memory Steward task requires chatId and taskId");
    }
    this.workspaces.set(normalizedRunId, workspace);
    return workspace;
  }

  getOutcome(runId) {
    return cloneDomainValue(
      this.workspaces.get(String(runId || ""))?.outcome || { kind: "missing" },
      { kind: "missing" },
    );
  }

  closeTask(runId) {
    const key = String(runId || "").trim();
    const workspace = this.workspaces.get(key) || null;
    this.workspaces.delete(key);
    return workspace ? cloneDomainValue(workspace.outcome, { kind: "pending" }) : null;
  }

  _workspace(scope) {
    const runId = String(scope?.runId || "").trim();
    const workspace = this.workspaces.get(runId);
    if (!workspace) {
      throw new BmeAgentError(`Memory Steward workspace not found: ${runId}`, {
        code: "memory_steward_workspace_missing",
      });
    }
    return workspace;
  }

  _assertMutable(workspace) {
    if (workspace.outcome.kind !== "pending") {
      throw new BmeAgentError(`Memory Steward task is already ${workspace.outcome.kind}`, {
        code: "memory_steward_task_settled",
      });
    }
  }

  _observe(workspace, ledger, { refresh = false } = {}) {
    const snapshot = createMemoryCatalogSnapshot(ledger);
    if (refresh || !workspace.observedStateFingerprint) {
      workspace.observedStateFingerprint = snapshot.stateFingerprint;
      workspace.observedLedgerRevision = ledger.revision;
      if (refresh) workspace.stagedChangeSet = null;
      return snapshot;
    }
    if (workspace.observedStateFingerprint !== snapshot.stateFingerprint) {
      throw new MemoryStewardStateChangedError({
        expected: workspace.observedStateFingerprint,
        actual: snapshot.stateFingerprint,
        observedLedgerRevision: workspace.observedLedgerRevision,
        actualLedgerRevision: ledger.revision,
      });
    }
    return snapshot;
  }

  _track(workspace, recordIds = []) {
    for (const recordId of recordIds || []) {
      const normalized = String(recordId || "").trim();
      if (normalized) workspace.readRecordIds.add(normalized);
    }
  }

  async _loadObserved(workspace, options = {}) {
    const ledger = await this.repository.load(workspace.chatId, { fresh: true });
    const snapshot = this._observe(workspace, ledger, options);
    return { ledger, snapshot };
  }

  registerInto(registry) {
    const unregister = [];
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_task_context",
          "Read the assigned durable inbox items, their source evidence, recent evidence, and current memory-state statistics. Use refresh=true after a state_changed result.",
          {
            refresh: { type: "boolean" },
            recentEvidenceLimit: { type: "integer", minimum: 1 },
          },
        ),
        async (args, scope) => await this.taskContext(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_search",
          "Search active objective, POV, and derived memories. Combines lexical ranking with configured semantic search when available and returns a stable cursor.",
          {
            query: { type: "string" },
            memoryTypes: stringArraySchema(),
            layers: stringArraySchema(),
            ownerIds: stringArraySchema(),
            limit: { type: "integer", minimum: 1 },
            cursor: { type: "string" },
          },
          ["query"],
        ),
        async (args, scope) => await this.search(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_get",
          "Read complete current revisions and optional version/evidence history for specific stable memory IDs.",
          {
            memoryIds: stringArraySchema(),
            includeHistory: { type: "boolean" },
            includeEvidence: { type: "boolean" },
          },
          ["memoryIds"],
        ),
        async (args, scope) => await this.getMemories(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_neighbors",
          "Read active relations and neighboring memory revisions for a stable memory ID.",
          {
            memoryId: { type: "string", minLength: 1 },
            direction: { type: "string", enum: ["in", "out", "both"] },
            relations: stringArraySchema(),
          },
          ["memoryId"],
        ),
        async (args, scope) => await this.neighbors(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_evidence",
          "Read immutable conversation evidence by ID, or page through recent active evidence when IDs are omitted.",
          {
            evidenceIds: stringArraySchema(),
            limit: { type: "integer", minimum: 1 },
            cursor: { type: "string" },
          },
        ),
        async (args, scope) => await this.evidence(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_stage_changes",
          "Replace the staged atomic memory change set. Operations are memory_revision or relation_revision records and must cite active evidence or dependency revision IDs.",
          {
            operations: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["type"],
                properties: { type: { type: "string", enum: ["memory_revision", "relation_revision"] } },
                additionalProperties: true,
              },
            },
            reason: { type: "string" },
          },
          ["operations"],
        ),
        async (args, scope) => await this.stage(args, scope),
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition("memory_validate_changes", "Validate the currently staged atomic change set against the latest durable memory state."),
        async (_args, scope) => await this.validate(scope),
        { idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition("memory_commit_changes", "Commit the validated staged change set as one durable transaction."),
        async (_args, scope) => await this.commit(scope),
        { idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "memory_complete_without_changes",
          "Record that the assigned evidence was inspected and requires no memory mutation.",
          { reason: { type: "string", minLength: 1 } },
          ["reason"],
        ),
        async (args, scope) => await this.completeWithoutChanges(args, scope),
        { idempotent: true },
      ),
    );
    return () => unregister.reverse().forEach((dispose) => dispose());
  }

  async taskContext({ refresh = false, recentEvidenceLimit = 12 } = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger, snapshot } = await this._loadObserved(workspace, { refresh });
    const index = new Map(ledger.records.map((record) => [record.id, record]));
    const inboxItems = workspace.inboxIds
      .map((inboxId) => snapshot.view.inbox.latestByInboxId.get(inboxId))
      .filter(Boolean);
    const assignedEvidenceIds = new Set([
      ...workspace.sourceEvidenceIds,
      ...inboxItems.flatMap((item) => item.sourceRecordIds || []),
    ]);
    const assignedEvidence = [...assignedEvidenceIds]
      .map((id) => index.get(id))
      .filter((record) => record?.kind === MEMORY_RECORD_KIND.EVIDENCE);
    const recentEvidence = snapshot.view.evidence.activeEvidence
      .slice(-positiveInteger(recentEvidenceLimit, 12));
    this._track(workspace, [
      ...inboxItems.map((item) => item.id),
      ...assignedEvidence.map((record) => record.id),
      ...recentEvidence.map((record) => record.id),
    ]);
    return {
      chatId: workspace.chatId,
      taskId: workspace.taskId,
      inboxItems: cloneDomainValue(inboxItems, []),
      assignedEvidence: cloneDomainValue(assignedEvidence, []),
      recentEvidence: cloneDomainValue(recentEvidence, []),
      ledgerRevision: ledger.revision,
      stateFingerprint: snapshot.stateFingerprint,
      stats: snapshot.stats,
      staged: workspace.stagedChangeSet
        ? {
            id: workspace.stagedChangeSet.id,
            operationCount: workspace.stagedChangeSet.operations.length,
          }
        : null,
    };
  }

  async search(args = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger } = await this._loadObserved(workspace);
    let semanticMatches = [];
    let semanticStatus = this.semanticSearch ? "available" : "unavailable";
    if (this.semanticSearch && String(args.query || "").trim()) {
      try {
        const result = await this.semanticSearch({
          chatId: workspace.chatId,
          query: args.query,
          limit: positiveInteger(args.limit, 20),
          signal: scope?.signal,
        });
        semanticMatches = Array.isArray(result) ? result : result?.items || [];
      } catch (error) {
        semanticStatus = `failed:${error?.message || String(error)}`;
      }
    }
    const result = searchMemoryCatalog(ledger, { ...args, semanticMatches });
    this._track(
      workspace,
      result.items.flatMap((item) => [
        item.revisionId,
        ...(item.evidenceIds || []),
        ...(item.dependencyRevisionIds || []),
      ]),
    );
    return { ...result, semanticStatus };
  }

  async getMemories(args = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger } = await this._loadObserved(workspace);
    const result = inspectMemoryRecords(ledger, args);
    this._track(workspace, [
      ...result.memories.flatMap((memory) => [
        ...(memory.head ? [memory.head.id] : []),
        ...(memory.history || []).map((revision) => revision.id),
      ]),
      ...result.evidence.map((record) => record.id),
    ]);
    return result;
  }

  async neighbors(args = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger } = await this._loadObserved(workspace);
    const result = inspectMemoryNeighbors(ledger, args);
    this._track(workspace, [
      ...result.relations.map((relation) => relation.id),
      ...result.neighbors.map((memory) => memory.id),
    ]);
    return result;
  }

  async evidence(args = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger, snapshot } = await this._loadObserved(workspace);
    const requested = new Set((args.evidenceIds || []).map(String).filter(Boolean));
    const records = requested.size > 0
      ? ledger.records.filter(
          (record) =>
            record.kind === MEMORY_RECORD_KIND.EVIDENCE && requested.has(record.id),
        )
      : [...snapshot.view.evidence.activeEvidence].reverse();
    const offset = parseEvidenceCursor(args.cursor, snapshot.stateFingerprint);
    const limit = positiveInteger(args.limit, 20);
    const items = records.slice(offset, offset + limit);
    this._track(workspace, items.map((record) => record.id));
    return {
      chatId: workspace.chatId,
      ledgerRevision: ledger.revision,
      stateFingerprint: snapshot.stateFingerprint,
      total: records.length,
      nextCursor:
        offset + items.length < records.length
          ? `${snapshot.stateFingerprint}:${offset + items.length}`
          : "",
      items: cloneDomainValue(items, []),
    };
  }

  async stage({ operations = [], reason = "" } = {}, scope) {
    const workspace = this._workspace(scope);
    this._assertMutable(workspace);
    const { ledger } = await this._loadObserved(workspace);
    workspace.stageSequence += 1;
    const operationEvidenceIds = operations.flatMap((operation) => operation?.evidenceIds || []);
    const changeSet = createMemoryChangeSet({
      id: createDomainId("steward-change-set", {
        runId: workspace.runId,
        stageSequence: workspace.stageSequence,
        operations,
      }),
      chatId: workspace.chatId,
      baseRevision: workspace.observedLedgerRevision,
      taskId: workspace.taskId,
      idempotencyKey: `memory-steward:${workspace.taskId}:stage:${workspace.stageSequence}`,
      readRecordIds: [...workspace.readRecordIds],
      readStateFingerprint: workspace.observedStateFingerprint,
      sourceEvidenceIds: [...new Set(operationEvidenceIds)],
      operations,
      reason: reason || "memory-steward-change-set",
      createdAt: this.now(),
    });
    const validation = validateMemoryChangeSet(ledger, changeSet);
    workspace.stagedChangeSet = validation.valid ? changeSet : null;
    return {
      staged: validation.valid,
      changeSetId: changeSet.id,
      operationCount: operations.length,
      issues: validation.issues,
      memoryRevisionIds: validation.records
        .filter((record) => record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION)
        .map((record) => record.id),
      relationRevisionIds: validation.records
        .filter((record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION)
        .map((record) => record.id),
    };
  }

  async validate(scope) {
    const workspace = this._workspace(scope);
    this._assertMutable(workspace);
    if (!workspace.stagedChangeSet) {
      return { valid: false, issues: ["no staged memory change set"] };
    }
    const ledger = await this.repository.load(workspace.chatId, { fresh: true });
    const validation = validateMemoryChangeSet(ledger, workspace.stagedChangeSet);
    if (!validation.valid) workspace.stagedChangeSet = null;
    return {
      valid: validation.valid,
      issues: validation.issues,
      operationCount: validation.records.length,
      currentLedgerRevision: ledger.revision,
    };
  }

  async commit(scope) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "committed") return cloneDomainValue(workspace.outcome, workspace.outcome);
    this._assertMutable(workspace);
    if (!workspace.stagedChangeSet) {
      return { committed: false, issues: ["no staged memory change set"] };
    }
    let planned = null;
    try {
      const persisted = await this.repository.transact(workspace.chatId, (ledger) => {
        planned = planMemoryChangeSetCommit(ledger, workspace.stagedChangeSet);
        return planned.transaction;
      });
      workspace.outcome = {
        kind: "committed",
        committed: true,
        changeSetId: workspace.stagedChangeSet.id,
        commitId: persisted.commit?.id || "",
        ledgerRevision: persisted.ledger?.revision || 0,
        replayed: persisted.replayed === true,
        rebased: planned?.rebased === true,
        memoryRevisionIds: (persisted.appendedRecords || [])
          .filter((record) => record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION)
          .map((record) => record.id),
        relationRevisionIds: (persisted.appendedRecords || [])
          .filter((record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION)
          .map((record) => record.id),
      };
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    } catch (error) {
      if (error instanceof MemoryLedgerConflictError || error?.code === "memory_ledger_conflict") {
        workspace.stagedChangeSet = null;
        return {
          committed: false,
          conflict: true,
          issues: cloneDomainValue(error?.details?.issues, [error.message]),
          instruction: "Call memory_task_context with refresh=true, then search and stage again.",
        };
      }
      throw error;
    }
  }

  async completeWithoutChanges({ reason = "" } = {}, scope) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "no_change") return cloneDomainValue(workspace.outcome, workspace.outcome);
    this._assertMutable(workspace);
    if (!workspace.observedStateFingerprint) {
      throw new BmeAgentError("Inspect memory_task_context before completing without changes", {
        code: "memory_steward_not_inspected",
      });
    }
    if (workspace.stagedChangeSet) {
      throw new BmeAgentError("A staged change set exists; commit it or refresh before completing", {
        code: "memory_steward_stage_pending",
      });
    }
    await this._loadObserved(workspace);
    workspace.outcome = {
      kind: "no_change",
      committed: false,
      reason: String(reason || "").trim(),
      stateFingerprint: workspace.observedStateFingerprint,
    };
    return cloneDomainValue(workspace.outcome, workspace.outcome);
  }
}
