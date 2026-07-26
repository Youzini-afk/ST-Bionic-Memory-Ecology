import { DEFAULT_NODE_SCHEMA } from "../../graph/schema.js";
import {
  buildExtractionMessages,
  getAssistantTurns,
  getDialogueFloorForChatIndex,
} from "../../maintenance/chat-history.js";
import { getSmartTriggerDecision } from "../../maintenance/smart-trigger.js";
import { getHistoryPrefixHash, historyBasisMatches } from "../core/history.js";
import { planGraphMutation } from "./graph-draft.js";

let defaultOperationsPromise = null;

async function loadDefaultOperations() {
  defaultOperationsPromise ||= Promise.all([
    import("../../maintenance/extractor.js"),
    import("../../maintenance/consolidator.js"),
    import("../../maintenance/compressor.js"),
    import("../../maintenance/hierarchical-summary.js"),
    import("../../vector/vector-index.js"),
  ]).then(([extractor, consolidator, compressor, summary, vectors]) => ({
    extractMemories: extractor.extractMemories,
    generateReflection: extractor.generateReflection,
    analyzeAutoConsolidationGate: consolidator.analyzeAutoConsolidationGate,
    consolidateMemories: consolidator.consolidateMemories,
    compressAll: compressor.compressAll,
    inspectAutoCompressionCandidates: compressor.inspectAutoCompressionCandidates,
    sleepCycle: compressor.sleepCycle,
    runHierarchicalSummaryPostProcess: summary.runHierarchicalSummaryPostProcess,
    getVectorModelScope: vectors.getVectorModelScope,
    validateVectorConfig: vectors.validateVectorConfig,
  }));
  return defaultOperationsPromise;
}

function valueOf(source, fallback) {
  return typeof source === "function" ? source() : source ?? fallback;
}

function toChat(messages = []) {
  return messages.map((message) => ({
    is_user: message.role === "user",
    is_system: message.role === "system",
    name: message.speaker,
    mes: message.text,
  }));
}

function positiveInt(value, fallback, max = 500) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

function autoExtractionPlan(chat, processedThrough, settings, force) {
  const pending = getAssistantTurns(chat).filter((index) => index > processedThrough);
  let eligible = pending;
  if (!force && settings.extractAutoDelayLatestAssistant === true) {
    eligible = pending.length > 1 ? pending.slice(0, -1) : [];
  }
  const end = eligible.at(-1);
  const smart = settings.enableSmartTrigger && end != null
    ? getSmartTriggerDecision(chat, processedThrough, settings, end)
    : { triggered: false, score: 0, reasons: [] };
  const every = positiveInt(settings.extractEvery, 1, 50);
  const canRun = force
    ? eligible.length > 0
    : settings.enabled !== false &&
      settings.extractAutoEnabled !== false &&
      eligible.length > 0 &&
      (eligible.length >= every || smart.triggered);
  const batch = !canRun
    ? []
    : force || smart.triggered
      ? eligible
      : eligible.slice(0, every);
  return {
    canRun,
    smart,
    start: batch[0] ?? null,
    end: batch.at(-1) ?? null,
    reason: pending.length === 0
      ? "no-unprocessed-assistant"
      : eligible.length === 0
        ? "waiting-next-assistant"
        : canRun
          ? "ready"
          : "below-extract-every",
  };
}

function appendBatchSlice(graph, { id, start, end, extractionCountBefore, nodeIds, chat }) {
  graph.batchJournal ||= [];
  graph.batchJournal.push({
    id,
    journalVersion: 3,
    createdAt: Date.now(),
    processedRange: [start, end],
    processedDialogueRange: [
      getDialogueFloorForChatIndex(chat, start),
      getDialogueFloorForChatIndex(chat, end),
    ],
    touchedNodeIds: [...new Set(nodeIds)],
    createdNodeIds: [],
    createdEdgeIds: [],
    previousNodeSnapshots: [],
    previousEdgeSnapshots: [],
    stateBefore: { extractionCount: extractionCountBefore },
  });
  graph.batchJournal = graph.batchJournal.slice(-96);
}

export class DomainPipeline {
  #engine;
  #settings;
  #schema;
  #embedding;
  #operations;
  #logger;
  #onStage;
  #queues = new Map();

  constructor({
    engine,
    getSettings = () => ({}),
    getSchema = () => DEFAULT_NODE_SCHEMA,
    getEmbeddingConfig = () => ({}),
    operations = null,
    logger = console,
    onStage = null,
  } = {}) {
    if (!engine?.read || !engine?.commit) throw new TypeError("ConversationEngine is required");
    this.#engine = engine;
    this.#settings = getSettings;
    this.#schema = getSchema;
    this.#embedding = getEmbeddingConfig;
    this.#operations = operations ? Promise.resolve(operations) : loadDefaultOperations();
    this.#logger = logger;
    this.#onStage = onStage;
  }

  processAssistant({ lease, snapshot, messageId = null, force = false } = {}) {
    if (!lease?.chatKey || lease.chatKey !== snapshot?.chatKey) {
      throw new TypeError("assistant task requires one pinned chat");
    }
    const previous = this.#queues.get(lease.chatKey) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(() =>
      this.#process({ lease, snapshot, messageId, force }));
    const tail = pending.catch(() => undefined);
    this.#queues.set(lease.chatKey, tail);
    tail.finally(() => {
      if (this.#queues.get(lease.chatKey) === tail) this.#queues.delete(lease.chatKey);
    });
    return pending;
  }

  async #process({ lease, snapshot, messageId, force }) {
    const operations = await this.#operations;
    const settings = valueOf(this.#settings, {});
    const schema = valueOf(this.#schema, DEFAULT_NODE_SCHEMA);
    const embeddingConfig = valueOf(this.#embedding, {});
    const chat = toChat(snapshot.messages);
    const receivedPosition = snapshot.messages.findIndex(
      (message) => message.hostIndex === Number(messageId),
    );
    if (receivedPosition >= 0 && snapshot.messages[receivedPosition]?.role !== "assistant") {
      return { status: "ignored", reason: "received-message-is-not-assistant", stages: [] };
    }

    const state = await this.#engine.read(lease);
    const plan = autoExtractionPlan(chat, state.head.processedThrough, settings, force);
    if (!plan.canRun) return { status: "deferred", reason: plan.reason, stages: [] };
    if (receivedPosition >= 0 && plan.end > receivedPosition) {
      return { status: "deferred", reason: "assistant-not-in-planned-prefix", stages: [] };
    }
    const basisHistoryLength = plan.end + 1;
    const basisHistoryHash = getHistoryPrefixHash(state.head.history, basisHistoryLength);
    const extractionMessages = buildExtractionMessages(chat, plan.start, plan.end, settings);
    const stages = [];

    const extraction = await this.#commitMutation({
      lease,
      basisHistoryLength,
      basisHistoryHash,
      operation: "extract",
      processedThroughAfter: plan.end,
      embeddingConfig,
      operations,
      mutate: async (graph) => {
        const countBefore = Number(graph.historyState?.extractionCount || 0);
        const result = await operations.extractMemories({
          graph,
          messages: extractionMessages,
          startSeq: plan.start,
          endSeq: plan.end,
          lastProcessedSeq: state.head.processedThrough,
          schema,
          embeddingConfig,
          signal: lease.signal,
          settings,
        });
        if (result?.success === false) throw new Error(result.error || "memory extraction failed");
        graph.lastProcessedSeq = plan.end;
        graph.historyState ||= {};
        graph.historyState.lastProcessedAssistantFloor = plan.end;
        graph.historyState.extractionCount = countBefore + 1;
        const nodeIds = result?.changedNodeIds || result?.newNodeIds || [];
        appendBatchSlice(graph, {
          id: `batch:${basisHistoryHash}`,
          start: plan.start,
          end: plan.end,
          extractionCountBefore: countBefore,
          nodeIds,
          chat,
        });
        return result;
      },
    });
    stages.push({ name: "extract", status: extraction.status });
    if (extraction.status !== "committed") return { status: extraction.status, stages };

    const extractionResult = extraction.result || {};
    const newNodeIds = [...new Set(extractionResult.newNodeIds || [])];
    const extractionCount = Number(
      extraction.graph?.historyState?.extractionCount || 0,
    );
    const maintenance = [
      ["consolidate", settings.enableConsolidation && newNodeIds.length > 0, async (graph) => {
        const min = positiveInt(settings.consolidationAutoMinNewNodes, 2, 50);
        let gate = { triggered: false };
        if (newNodeIds.length < min) {
          gate = await operations.analyzeAutoConsolidationGate({
            graph,
            newNodeIds,
            embeddingConfig,
            schema,
            conflictThreshold: settings.consolidationThreshold,
            signal: lease.signal,
          });
        }
        if (newNodeIds.length < min && !gate?.triggered) return { skipped: true };
        return operations.consolidateMemories({
          graph,
          newNodeIds,
          embeddingConfig,
          schema,
          options: {
            neighborCount: settings.consolidationNeighborCount,
            conflictThreshold: settings.consolidationThreshold,
          },
          settings,
          signal: lease.signal,
        });
      }],
      ["summary", settings.enableHierarchicalSummary !== false, (graph) =>
        operations.runHierarchicalSummaryPostProcess({
          graph,
          chat,
          settings,
          signal: lease.signal,
          currentExtractionCount: extractionCount,
          currentAssistantFloor: plan.end,
          currentRange: [plan.start, plan.end],
          currentNodeIds: extractionResult.changedNodeIds || newNodeIds,
        })],
      ["reflection", settings.enableReflection === true &&
        extractionCount % positiveInt(settings.reflectEveryN, 10) === 0, (graph) =>
        operations.generateReflection({
          graph,
          currentSeq: plan.end,
          schema,
          embeddingConfig,
          settings,
          signal: lease.signal,
        })],
      ["sleep", settings.enableSleepCycle === true &&
        extractionCount % positiveInt(settings.sleepEveryN, 10) === 0, (graph) =>
        operations.sleepCycle(graph, settings)],
      ["compress", settings.enableAutoCompression !== false &&
        extractionCount % positiveInt(settings.compressionEveryN, 10) === 0, async (graph) => {
        const inspection = operations.inspectAutoCompressionCandidates(graph, schema, false);
        if (!inspection?.hasCandidates) return { skipped: true };
        return operations.compressAll(
          graph,
          schema,
          embeddingConfig,
          false,
          undefined,
          lease.signal,
          settings,
        );
      }],
    ];

    for (const [name, enabled, mutate] of maintenance) {
      if (!enabled) continue;
      try {
        const result = await this.#commitMutation({
          lease,
          basisHistoryLength,
          basisHistoryHash,
          operation: name,
          processedThroughAfter: plan.end,
          embeddingConfig,
          operations,
          mutate,
        });
        stages.push({ name, status: result.status });
      } catch (error) {
        if (error?.name === "AbortError" || error?.name === "LeaseExpiredError") throw error;
        this.#logger?.error?.(`[ST-BME v9] ${name} failed`, error);
        stages.push({ name, status: "failed", error });
      }
    }
    return { status: "completed", stages };
  }

  async #commitMutation({
    lease,
    basisHistoryLength,
    basisHistoryHash,
    operation,
    processedThroughAfter,
    embeddingConfig,
    operations,
    mutate,
  }) {
    this.#emit(lease, operation, "running");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.#engine.read(lease);
      if (!historyBasisMatches(state.head.history, basisHistoryLength, basisHistoryHash)) {
        const error = new Error(`history basis changed before ${operation}`);
        error.name = "HistoryBasisConflictError";
        throw error;
      }
      if (operation === "extract" && state.head.processedThrough >= processedThroughAfter) {
        return { status: "already-processed", result: null, graph: null };
      }
      const planned = await planGraphMutation(state, mutate);
      const processed = operation === "extract"
        ? processedThroughAfter
        : state.head.processedThrough;
      if (planned.changeSet.changes.length === 0 && processed === state.head.processedThrough) {
        this.#emit(lease, operation, "skipped");
        return { status: "skipped", ...planned };
      }
      const touchesVector = planned.changeSet.changes.some(
        ({ collection }) => collection === "nodes" || collection === "edges",
      );
      const validVector = touchesVector && operations.validateVectorConfig(embeddingConfig).valid;
      const vectorModelScope = validVector
        ? operations.getVectorModelScope(embeddingConfig)
        : String(state.head.vectorModelScope || "unconfigured");
      try {
        const committed = await this.#engine.commit(lease, {
          expectedRevision: state.head.revision,
          operation,
          basisHistoryLength,
          basisHistoryHash,
          processedThroughAfter: processed,
          changeSet: planned.changeSet,
          vectorModelScope,
          enqueueVectorJob: touchesVector,
        });
        this.#emit(lease, operation, "committed");
        return { status: "committed", ...planned, ...committed };
      } catch (error) {
        if (attempt === 0 && error?.name === "RevisionConflictError") continue;
        throw error;
      }
    }
    throw new Error(`${operation} could not commit`);
  }

  #emit(lease, stage, status) {
    if (typeof this.#onStage !== "function" || !this.#engine.isLeaseActive(lease)) return;
    this.#onStage({ chatKey: lease.chatKey, stage, status });
  }
}
