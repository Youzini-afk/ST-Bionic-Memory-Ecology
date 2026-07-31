import { createBmeAgentRunId } from "../agent/journal.js";
import { buildRecallAgentMessages } from "../agent/recall-agent-prompt.js";
import { fingerprintMaterializedMemoryState } from "../domain/memory-changeset.js";
import { MEMORY_RECORD_KIND, TURN_ARTIFACT_KIND } from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  createDomainId,
  normalizeStringArray,
} from "../domain/memory-id.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import {
  createTurnInputFingerprint,
  findReusableTurnArtifact,
  planTurnArtifactCommit,
  turnArtifactToRecallResult,
} from "../domain/turn-artifact.js";
import { projectMemoryLedgerToGraph } from "../projection/memory-graph-projection.js";
import { buildRecallCandidatePacket } from "../retrieval/recall-candidate-packet.js";
import { formatInjection } from "../retrieval/injector.js";

async function loadDefaultRetrievalResultBuilder() {
  return (await import("../retrieval/retriever.js"))
    .buildRetrievalResultForSelectedNodes;
}

function injectedMemoryIds(result = {}) {
  return normalizeStringArray([
    ...(result.coreNodes || []).map((node) => node.id),
    ...(result.recallNodes || []).map((node) => node.id),
    ...(result.summaryEntries || []).map((entry) => entry.id),
  ]);
}

function isAbortLike(error, signal = null) {
  return Boolean(
    signal?.aborted ||
      error?.name === "AbortError" ||
      error?.code === "bme_agent_cancelled" ||
      error?.code === "agent_cancelled",
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Recall Agent was cancelled");
  error.name = "AbortError";
  throw error;
}

function buildEmergencyCandidatePacket(graph, error) {
  const candidates = (graph?.nodes || [])
    .filter((node) => node && !node.archived)
    .sort((left, right) => {
      const floorDelta =
        Number(right.sourceFloor ?? right.seq ?? 0) -
        Number(left.sourceFloor ?? left.seq ?? 0);
      if (floorDelta !== 0) return floorDelta;
      return Number(right.importance || 0) - Number(left.importance || 0);
    })
    .slice(0, 24)
    .map((node, index) => ({
      memoryId: String(node.id || ""),
      revisionId: String(node.memoryRevisionId || ""),
      memoryType: String(node.type || ""),
      layer: String(node.memoryLayer || node.scope?.layer || "objective"),
      fields: cloneDomainValue(node.fields, {}),
      scope: cloneDomainValue(node.scope, {}),
      storyTime: cloneDomainValue(node.storyTime, {}),
      importance: Number(node.importance || 0),
      confidence: Number(node.memoryConfidence ?? 1),
      sourceFloor: Number(node.sourceFloor ?? node.seq ?? 0),
      channels: ["provider-failure-tail"],
      rank: index + 1,
    }));
  return {
    candidateMemoryIds: candidates.map((candidate) => candidate.memoryId),
    initialSelectedMemoryIds: candidates
      .slice(0, 8)
      .map((candidate) => candidate.memoryId),
    candidates,
    channels: { programmatic: 0, vectorTail: candidates.length },
    vectorState: {
      mode: String(graph?.vectorIndexState?.mode || ""),
      dirty: graph?.vectorIndexState?.dirty === true,
      replayRequiredCount: Array.isArray(graph?.vectorIndexState?.replayRequiredNodeIds)
        ? graph.vectorIndexState.replayRequiredNodeIds.length
        : 0,
    },
    baseline: {
      selectedMemoryIds: candidates
        .slice(0, 8)
        .map((candidate) => candidate.memoryId),
      stats: {},
      retrievalMeta: {
        degraded: true,
        reason: "candidate-builder-failed",
        error: String(error?.message || error || "candidate builder failed"),
      },
      scopeContext: {},
    },
  };
}

export const RECALL_AGENT_KIND = "recall-agent";

export class RecallAgentService {
  constructor({
    repository,
    agentRuntime,
    toolset,
    candidateBuilder = buildRecallCandidatePacket,
    resultBuilder = null,
    instructions = "",
    now = () => Date.now(),
    onStatus = null,
  } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("RecallAgentService requires a memory ledger repository");
    }
    if (!agentRuntime || typeof agentRuntime.run !== "function") {
      throw new TypeError("RecallAgentService requires a BME Agent runtime");
    }
    if (!toolset || typeof toolset.openTask !== "function") {
      throw new TypeError("RecallAgentService requires a Recall Agent toolset");
    }
    this.repository = repository;
    this.agentRuntime = agentRuntime;
    this.toolset = toolset;
    this.candidateBuilder = candidateBuilder;
    this.resultBuilder = typeof resultBuilder === "function" ? resultBuilder : null;
    this.instructions = String(instructions || "");
    this.now = typeof now === "function" ? now : () => Date.now();
    this.onStatus = typeof onStatus === "function" ? onStatus : null;
    this._active = new Map();
  }

  _emit(chatId, status, details = {}) {
    try {
      this.onStatus?.({ chatId, status, ...cloneDomainValue(details, {}) });
    } catch {
      // UI/status reporting cannot change foreground recall semantics.
    }
  }

  async _reuse(chatId, request) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const artifact = findReusableTurnArtifact(ledger, {
      turnId: request.turnId,
      artifactKind: TURN_ARTIFACT_KIND.RECALL,
      inputFingerprint: request.inputFingerprint,
      historyFingerprint: request.historyFingerprint,
    });
    return artifact ? turnArtifactToRecallResult(artifact) : null;
  }

  async _prepare(ledger, request, previousGraph, signal) {
    const projection = projectMemoryLedgerToGraph(ledger, previousGraph);
    let packet;
    try {
      packet = await this.candidateBuilder({
        graph: projection.graph,
        userMessage: request.userMessage,
        recentMessages: request.recentMessages,
        embeddingConfig: request.embeddingConfig,
        schema: request.schema,
        settings: request.retrievalSettings,
        options: request.retrievalOptions,
        signal,
      });
    } catch (error) {
      if (isAbortLike(error, signal)) throw error;
      packet = buildEmergencyCandidatePacket(projection.graph, error);
    }
    return { projection, packet };
  }

  async _publishSelection({
    workspace,
    ledger,
    selectedMemoryIds = [],
    reason = "",
    source = "recall-agent",
    signal = null,
  } = {}) {
    throwIfAborted(signal);
    const selectedIds = normalizeStringArray(selectedMemoryIds);
    const view = materializeMemoryLedger(ledger);
    const projection = projectMemoryLedgerToGraph(ledger, workspace.graph);
    const scopeContext = {
      ...(workspace.packet.baseline?.scopeContext || {}),
      graph: projection.graph,
    };
    const buildResult = this.resultBuilder || await loadDefaultRetrievalResultBuilder();
    throwIfAborted(signal);
    const retrievalResult = buildResult({
      graph: projection.graph,
      selectedNodeIds: selectedIds,
      schema: workspace.schema,
      meta: {
        retrieval: cloneDomainValue(
          workspace.packet.baseline?.retrievalMeta,
          {},
        ),
        scopeContext,
      },
    });
    const injectionText = formatInjection(retrievalResult, workspace.schema).trim();
    const allInjectedMemoryIds = injectedMemoryIds(retrievalResult);
    const dependencyRevisionIds = allInjectedMemoryIds
      .map((memoryId) => view.memories.byMemoryId.get(memoryId)?.id)
      .filter(Boolean);
    const projectedById = new Map(
      (projection.graph.nodes || []).map((node) => [node.id, node]),
    );
    const evidenceIds = normalizeStringArray(
      allInjectedMemoryIds.flatMap(
        (memoryId) => projectedById.get(memoryId)?.memoryEffectiveEvidenceIds || [],
      ),
    );
    throwIfAborted(signal);
    let planned = null;
    const persisted = await this.repository.transact(workspace.chatId, (latestLedger) => {
      throwIfAborted(signal);
      planned = planTurnArtifactCommit(latestLedger, {
        turnId: workspace.turnId,
        artifactKind: TURN_ARTIFACT_KIND.RECALL,
        inputFingerprint: workspace.inputFingerprint,
        historyFingerprint: workspace.historyFingerprint,
        expectedMemoryStateFingerprint: workspace.observedStateFingerprint,
        selectedMemoryIds: selectedIds,
        candidateMemoryIds: workspace.packet.candidateMemoryIds || [],
        injectionText,
        evidenceIds,
        dependencyRevisionIds,
        agentRunId: workspace.runId,
        agentTaskId: workspace.taskId,
        source,
        result: {
          reason: String(reason || "").trim(),
          selectionMode:
            source === "recall-agent" ? "agent" : "programmatic-fallback",
          stats: cloneDomainValue(retrievalResult.stats, {}),
          retrievalMeta: cloneDomainValue(
            workspace.packet.baseline?.retrievalMeta,
            {},
          ),
        },
        now: this.now(),
      });
      return planned.transaction;
    }, { signal });
    const artifact =
      (persisted.appendedRecords || []).find(
        (record) => record.kind === MEMORY_RECORD_KIND.TURN_ARTIFACT,
      ) || planned?.artifact;
    workspace.graph = projection.graph;
    return {
      ...turnArtifactToRecallResult(artifact),
      published: true,
      persistedReuse: planned?.reused === true || persisted.replayed === true,
    };
  }

  async _fallback(scope, reason) {
    throwIfAborted(scope?.signal);
    let result = await this.toolset.publishProgrammaticFallback(scope, reason);
    if (result?.conflict) {
      await this.toolset.refresh(scope);
      result = await this.toolset.publishProgrammaticFallback(
        scope,
        `${reason}; refreshed after concurrent memory change`,
      );
    }
    if (!result?.published) {
      throw new Error(result?.error || "Recall Agent failed to publish a fallback artifact");
    }
    return result;
  }

  async _run(request, signal) {
    const reusable = await this._reuse(request.chatId, request);
    if (reusable) return { ...reusable, persistedReuse: true };

    const initialLedger = await this.repository.load(request.chatId, { fresh: true });
    const prepared = await this._prepare(
      initialLedger,
      request,
      request.previousGraph,
      signal,
    );
    const taskId = createDomainId("recall-agent-task", {
      chatId: request.chatId,
      turnId: request.turnId,
      inputFingerprint: request.inputFingerprint,
    });
    const runId = createBmeAgentRunId({
      chatId: request.chatId,
      taskId,
      now: this.now(),
    });
    const scope = { runId, signal };
    let currentGraph = prepared.projection.graph;
    this.toolset.openTask({
      runId,
      chatId: request.chatId,
      taskId,
      turnId: request.turnId,
      inputFingerprint: request.inputFingerprint,
      historyFingerprint: request.historyFingerprint,
      userMessage: request.userMessage,
      recentMessages: request.recentMessages,
      graph: currentGraph,
      schema: request.schema,
      packet: prepared.packet,
      stateFingerprint: fingerprintMaterializedMemoryState(initialLedger),
      refreshContext: async (latestLedger, refreshSignal) => {
        const refreshed = await this._prepare(
          latestLedger,
          request,
          currentGraph,
          refreshSignal,
        );
        currentGraph = refreshed.projection.graph;
        return { graph: currentGraph, packet: refreshed.packet };
      },
      publishSelection: async (selection) => await this._publishSelection(selection),
    });
    this._emit(request.chatId, "running", { turnId: request.turnId, runId });
    let runError = null;
    try {
      const activeMemories = prepared.projection.view.memories.active.length;
      if (activeMemories === 0) {
        const result = await this._fallback(scope, "No durable memories exist for this turn");
        this._emit(request.chatId, "completed", {
          turnId: request.turnId,
          runId,
          empty: true,
          fastPath: true,
        });
        return result;
      }
      try {
        await this.agentRuntime.run({
          chatId: request.chatId,
          taskId,
          runId,
          agentKind: RECALL_AGENT_KIND,
          taskType: "memory_recall",
          sourceRecordIds: [],
          messages: buildRecallAgentMessages({
            turnId: request.turnId,
            userMessage: request.userMessage,
            recentMessages: request.recentMessages,
            historyFingerprint: request.historyFingerprint,
            instructions: this.instructions,
          }),
          metadata: {
            turnId: request.turnId,
            inputFingerprint: request.inputFingerprint,
            historyFingerprint: request.historyFingerprint,
          },
          signal,
        });
      } catch (error) {
        if (isAbortLike(error, signal)) throw error;
        runError = error;
      }
      const outcome = this.toolset.getOutcome(runId);
      const result = outcome.kind === "published"
        ? outcome.result
        : await this._fallback(
            scope,
            runError
              ? `Recall Agent stopped before publishing: ${runError.message || String(runError)}`
              : "Recall Agent finished without publishing",
          );
      this._emit(request.chatId, "completed", {
        turnId: request.turnId,
        runId,
        empty: result.empty === true,
        fallback: outcome.kind !== "published",
        agentError: runError?.message || "",
      });
      return result;
    } finally {
      this.toolset.closeTask(runId);
    }
  }

  recall({
    chatId,
    turnId,
    userMessage = "",
    recentMessages = [],
    historyFingerprint = "",
    inputFingerprint = "",
    previousGraph = null,
    schema = [],
    embeddingConfig = {},
    retrievalSettings = {},
    retrievalOptions = {},
    signal = null,
  } = {}) {
    const normalizedChatId = String(chatId || "").trim();
    const normalizedTurnId = String(turnId || "").trim();
    if (!normalizedChatId || !normalizedTurnId) {
      throw new TypeError("Recall Agent requires chatId and turnId");
    }
    const resolvedInputFingerprint = String(inputFingerprint || "").trim() ||
      createTurnInputFingerprint({
        turnId: normalizedTurnId,
        userMessage,
        recentMessages,
        historyFingerprint,
      });
    const request = {
      chatId: normalizedChatId,
      turnId: normalizedTurnId,
      userMessage: String(userMessage || ""),
      recentMessages: (recentMessages || []).map((message) => String(message || "")),
      historyFingerprint: String(historyFingerprint || "").trim(),
      inputFingerprint: resolvedInputFingerprint,
      previousGraph,
      schema: cloneDomainValue(schema, []),
      embeddingConfig: cloneDomainValue(embeddingConfig, {}),
      retrievalSettings: cloneDomainValue(retrievalSettings, {}),
      retrievalOptions: cloneDomainValue(retrievalOptions, {}),
    };
    const key = `${normalizedChatId}::${normalizedTurnId}::${resolvedInputFingerprint}`;
    const existing = this._active.get(key);
    if (existing) return existing;
    const promise = this._run(request, signal).finally(() => {
      if (this._active.get(key) === promise) this._active.delete(key);
    });
    this._active.set(key, promise);
    return promise;
  }

  async recover(chatId) {
    return await this.agentRuntime.recoverInterruptedRuns(chatId, {
      agentKind: RECALL_AGENT_KIND,
    });
  }

  inspect(chatId = "") {
    const prefix = `${String(chatId || "").trim()}::`;
    return {
      active: [...this._active.keys()].filter((key) => !chatId || key.startsWith(prefix)),
    };
  }
}
