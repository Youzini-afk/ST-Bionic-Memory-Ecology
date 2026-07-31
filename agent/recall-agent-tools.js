import { cloneDomainValue, normalizeStringArray } from "../domain/memory-id.js";
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Recall Agent tool call was cancelled");
  error.name = "AbortError";
  throw error;
}

export class RecallAgentStateChangedError extends BmeAgentError {
  constructor(details = {}) {
    super("Memory state changed while Recall Agent was working; refresh and reconsider", {
      code: "recall_agent_state_changed",
      details,
    });
    this.name = "RecallAgentStateChangedError";
  }
}

export class RecallAgentToolset {
  constructor({
    repository,
    semanticSearch = null,
    now = () => Date.now(),
  } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("RecallAgentToolset requires a memory ledger repository");
    }
    this.repository = repository;
    this.semanticSearch = typeof semanticSearch === "function" ? semanticSearch : null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.workspaces = new Map();
  }

  openTask({
    runId,
    chatId,
    taskId,
    turnId,
    inputFingerprint,
    historyFingerprint = "",
    userMessage = "",
    recentMessages = [],
    graph,
    schema = [],
    packet,
    stateFingerprint,
    refreshContext = null,
    publishSelection = null,
  } = {}) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) throw new TypeError("Recall Agent task requires runId");
    if (this.workspaces.has(normalizedRunId)) {
      throw new Error(`Recall Agent workspace already exists: ${normalizedRunId}`);
    }
    const workspace = {
      runId: normalizedRunId,
      chatId: String(chatId || "").trim(),
      taskId: String(taskId || "").trim(),
      turnId: String(turnId || "").trim(),
      inputFingerprint: String(inputFingerprint || "").trim(),
      historyFingerprint: String(historyFingerprint || "").trim(),
      userMessage: String(userMessage || ""),
      recentMessages: (recentMessages || []).map((message) => String(message || "")),
      graph,
      schema: cloneDomainValue(schema, []),
      packet: cloneDomainValue(packet, {}),
      observedStateFingerprint: String(stateFingerprint || "").trim(),
      observedLedgerRevision: 0,
      readRecordIds: new Set(),
      refreshContext: typeof refreshContext === "function" ? refreshContext : null,
      publishSelection:
        typeof publishSelection === "function" ? publishSelection : null,
      outcome: { kind: "pending" },
    };
    if (!workspace.chatId || !workspace.taskId || !workspace.turnId || !workspace.inputFingerprint) {
      throw new TypeError("Recall Agent task requires chatId, taskId, turnId, and inputFingerprint");
    }
    this.workspaces.set(normalizedRunId, workspace);
    return workspace;
  }

  closeTask(runId) {
    const key = String(runId || "").trim();
    const workspace = this.workspaces.get(key) || null;
    this.workspaces.delete(key);
    return workspace ? cloneDomainValue(workspace.outcome, { kind: "pending" }) : null;
  }

  getOutcome(runId) {
    return cloneDomainValue(
      this.workspaces.get(String(runId || ""))?.outcome || { kind: "missing" },
      { kind: "missing" },
    );
  }

  _workspace(scope) {
    const runId = String(scope?.runId || "").trim();
    const workspace = this.workspaces.get(runId);
    if (!workspace) {
      throw new BmeAgentError(`Recall Agent workspace not found: ${runId}`, {
        code: "recall_agent_workspace_missing",
      });
    }
    return workspace;
  }

  _track(workspace, recordIds = []) {
    for (const recordId of recordIds || []) {
      const normalized = String(recordId || "").trim();
      if (normalized) workspace.readRecordIds.add(normalized);
    }
  }

  _observe(workspace, ledger, { refresh = false } = {}) {
    const snapshot = createMemoryCatalogSnapshot(ledger);
    if (refresh || !workspace.observedStateFingerprint) {
      workspace.observedStateFingerprint = snapshot.stateFingerprint;
      workspace.observedLedgerRevision = ledger.revision;
      return snapshot;
    }
    if (workspace.observedStateFingerprint !== snapshot.stateFingerprint) {
      throw new RecallAgentStateChangedError({
        expected: workspace.observedStateFingerprint,
        actual: snapshot.stateFingerprint,
        observedLedgerRevision: workspace.observedLedgerRevision,
        actualLedgerRevision: ledger.revision,
      });
    }
    return snapshot;
  }

  async _loadObserved(workspace, { refresh = false, signal = null } = {}) {
    const ledger = await this.repository.load(workspace.chatId, { fresh: true });
    if (refresh && workspace.refreshContext) {
      const refreshed = await workspace.refreshContext(ledger, signal);
      workspace.graph = refreshed.graph;
      workspace.packet = cloneDomainValue(refreshed.packet, {});
    }
    const snapshot = this._observe(workspace, ledger, { refresh });
    return { ledger, snapshot };
  }

  registerInto(registry) {
    const unregister = [];
    unregister.push(
      registry.register(
        toolDefinition(
          "recall_context",
          "Read the turn and its programmatic multi-channel candidate packet. Use refresh=true after a state-changed result.",
          { refresh: { type: "boolean" } },
        ),
        async (args, scope) => await this.context(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    unregister.push(
      registry.register(
        toolDefinition(
          "recall_search",
          "Search the full active objective, POV, and derived memory catalog beyond the initial packet.",
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
          "recall_get",
          "Inspect exact current revisions and optional evidence for stable memoryId values.",
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
          "recall_neighbors",
          "Traverse durable relations around one stable memoryId.",
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
          "recall_publish",
          "Publish exactly one validated turn-scoped recall selection. An empty selectedMemoryIds array is a successful empty recall.",
          {
            selectedMemoryIds: stringArraySchema("Stable memoryId values only."),
            reason: { type: "string", minLength: 1 },
          },
          ["selectedMemoryIds", "reason"],
        ),
        async (args, scope) => await this.publish(args, scope),
        { idempotent: true },
      ),
    );
    return () => unregister.reverse().forEach((dispose) => dispose());
  }

  async context({ refresh = false } = {}, scope) {
    const workspace = this._workspace(scope);
    const { ledger, snapshot } = await this._loadObserved(workspace, {
      refresh,
      signal: scope?.signal,
    });
    const candidateRevisionIds = (workspace.packet.candidates || [])
      .map((candidate) => candidate.revisionId)
      .filter(Boolean);
    this._track(workspace, candidateRevisionIds);
    return {
      chatId: workspace.chatId,
      taskId: workspace.taskId,
      turnId: workspace.turnId,
      userMessage: workspace.userMessage,
      recentMessages: [...workspace.recentMessages],
      historyFingerprint: workspace.historyFingerprint,
      ledgerRevision: ledger.revision,
      stateFingerprint: snapshot.stateFingerprint,
      packet: cloneDomainValue(workspace.packet, {}),
      stats: snapshot.stats,
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

  async publish(
    { selectedMemoryIds = [], reason = "", source = "recall-agent" } = {},
    scope,
  ) {
    throwIfAborted(scope?.signal);
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "published") {
      return cloneDomainValue(workspace.outcome.result, workspace.outcome.result);
    }
    const selectedIds = normalizeStringArray(selectedMemoryIds);
    let ledger;
    try {
      ({ ledger } = await this._loadObserved(workspace));
    } catch (error) {
      if (error instanceof RecallAgentStateChangedError) {
        return {
          published: false,
          conflict: true,
          error: error.message,
          details: cloneDomainValue(error.details, {}),
          instruction: "Call recall_context with refresh=true, then reconsider and publish again.",
        };
      }
      throw error;
    }
    throwIfAborted(scope?.signal);
    const view = materializeMemoryLedger(ledger);
    const missingMemoryIds = selectedIds.filter(
      (memoryId) => !view.memories.byMemoryId.has(memoryId),
    );
    if (missingMemoryIds.length > 0) {
      return {
        published: false,
        invalidSelection: true,
        missingMemoryIds,
        instruction: "Use stable memoryId values returned by recall tools.",
      };
    }
    if (!workspace.publishSelection) {
      throw new BmeAgentError("Recall Agent publish boundary is unavailable", {
        code: "recall_agent_publish_boundary_missing",
      });
    }
    try {
      const recallResult = await workspace.publishSelection({
        workspace,
        ledger,
        selectedMemoryIds: selectedIds,
        reason: String(reason || "").trim(),
        source,
        signal: scope?.signal,
      });
      if (!recallResult?.published) return recallResult;
      workspace.outcome = {
        kind: "published",
        artifactId: recallResult.artifactId || "",
        result: recallResult,
      };
      return cloneDomainValue(recallResult, recallResult);
    } catch (error) {
      if (error?.code === "memory_ledger_conflict") {
        return {
          published: false,
          conflict: true,
          error: error.message,
          details: cloneDomainValue(error.details, {}),
          instruction: "Call recall_context with refresh=true, then reconsider and publish again.",
        };
      }
      throw error;
    }
  }

  async publishProgrammaticFallback(scope, reason = "Agent did not publish") {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "published") {
      return cloneDomainValue(workspace.outcome.result, workspace.outcome.result);
    }
    return await this.publish(
      {
        selectedMemoryIds: workspace.packet.initialSelectedMemoryIds || [],
        reason,
        source: "recall-programmatic-fallback",
      },
      scope,
    );
  }

  async refresh(scope) {
    const workspace = this._workspace(scope);
    await this.context({ refresh: true }, scope);
    return workspace;
  }
}
