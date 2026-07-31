import { normalizeBmeAgentRuntimeSettings } from "../agent/runtime-settings.js";
import {
  MEMORY_INBOX_KIND,
  MEMORY_INBOX_STATUS,
  TURN_ARTIFACT_KIND,
} from "../domain/memory-contract.js";
import { resolveHistoryTurn } from "../domain/history-reconciliation.js";
import { createDomainId, stableStringify } from "../domain/memory-id.js";
import { createInboxItemRevision } from "../domain/memory-records.js";
import {
  findReusableTurnArtifact,
  turnArtifactToRecallResult,
} from "../domain/turn-artifact.js";
import { projectMemoryLedgerToGraph } from "../projection/memory-graph-projection.js";
import { BranchTransactionService } from "./branch-transaction-service.js";
import { HistoryTransactionService } from "./history-transaction-service.js";
import { LegacyLedgerMigrationService } from "./legacy-ledger-migration.js";
import { MemoryLedgerRepository } from "./memory-ledger-repository.js";
import { ManualMemoryService } from "./manual-memory-service.js";
import { PlannerArtifactService } from "./planner-artifact-service.js";

function chatIdFrom(identity, snapshot = {}) {
  const chatId = String(identity?.chatId || snapshot?.chatId || "").trim();
  if (!chatId) throw new TypeError("BME memory lifecycle requires stable chatId");
  return chatId;
}

function safeEmit(callback, payload) {
  try {
    callback?.(payload);
  } catch {
    // Projection and status observers are UI/cache side effects. Durable
    // ledger semantics never depend on their success.
  }
}

export class BmeMemoryLifecycleRuntime {
  constructor({
    conversationRepository = null,
    memoryLedgerRepository = null,
    settingsProvider = () => ({}),
    stewardRuntimeFactory,
    recallRuntimeFactory,
    onProjection = null,
    onStewardStatus = null,
    onRecallStatus = null,
    now = () => Date.now(),
  } = {}) {
    this.repository = memoryLedgerRepository || new MemoryLedgerRepository({
      conversationRepository,
    });
    this.settingsProvider = typeof settingsProvider === "function"
      ? settingsProvider
      : () => settingsProvider || {};
    if (
      typeof stewardRuntimeFactory !== "function" ||
      typeof recallRuntimeFactory !== "function"
    ) {
      throw new TypeError(
        "BmeMemoryLifecycleRuntime requires Steward and Recall runtime factories",
      );
    }
    this.stewardRuntimeFactory = stewardRuntimeFactory;
    this.recallRuntimeFactory = recallRuntimeFactory;
    this.onProjection = typeof onProjection === "function" ? onProjection : null;
    this.onStewardStatus = typeof onStewardStatus === "function" ? onStewardStatus : null;
    this.onRecallStatus = typeof onRecallStatus === "function" ? onRecallStatus : null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.history = new HistoryTransactionService({ ledgerRepository: this.repository });
    this.branches = new BranchTransactionService({ ledgerRepository: this.repository });
    this.migrations = new LegacyLedgerMigrationService({
      ledgerRepository: this.repository,
      now: this.now,
    });
    this.planner = new PlannerArtifactService({
      repository: this.repository,
      now: this.now,
    });
    this.manual = new ManualMemoryService({ repository: this.repository, now: this.now });
    this._agentBundles = new Map();
    this._agentSettingsKey = "";
  }

  _normalizedAgentSettings() {
    return normalizeBmeAgentRuntimeSettings(this.settingsProvider() || {});
  }

  _createAgents(settings, key) {
    const steward = this.stewardRuntimeFactory({
      memoryLedgerRepository: this.repository,
      settings,
      now: this.now,
      onStatus: (status) => safeEmit(this.onStewardStatus, status),
    });
    const recall = this.recallRuntimeFactory({
      memoryLedgerRepository: this.repository,
      settings,
      now: this.now,
      onStatus: (status) => safeEmit(this.onRecallStatus, status),
    });
    const bundle = {
      key,
      agents: { steward, recall },
      activeCalls: 0,
    };
    this._agentBundles.set(key, bundle);
    return bundle;
  }

  _disposeBundle(bundle) {
    if (!bundle) return;
    try {
      bundle.agents?.steward?.dispose?.();
    } catch {
      // Retiring an old settings bundle must not block the next request.
    }
    try {
      bundle.agents?.recall?.dispose?.();
    } catch {
      // Same boundary as above; durable work never depends on cleanup UI/runtime hooks.
    }
    this._agentBundles.delete(bundle.key);
  }

  _retireUnusedBundles() {
    for (const bundle of this._agentBundles.values()) {
      if (bundle.key !== this._agentSettingsKey && bundle.activeCalls === 0) {
        this._disposeBundle(bundle);
      }
    }
  }

  _agentBundleForRequest() {
    const settings = this._normalizedAgentSettings();
    const key = stableStringify(settings);
    let bundle = this._agentBundles.get(key);
    if (!bundle) bundle = this._createAgents(settings, key);
    this._agentSettingsKey = key;
    this._retireUnusedBundles();
    return bundle;
  }

  async _runAgentOperation(operation) {
    const bundle = this._agentBundleForRequest();
    bundle.activeCalls += 1;
    try {
      return await operation(bundle.agents);
    } finally {
      bundle.activeCalls = Math.max(0, bundle.activeCalls - 1);
      this._retireUnusedBundles();
    }
  }

  async project(chatId, previousGraph = null, details = {}) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const projection = projectMemoryLedgerToGraph(ledger, previousGraph);
    safeEmit(this.onProjection, { chatId, ...details, ...projection });
    return { ledger, ...projection };
  }

  async initialize({
    identity,
    conversationSnapshot,
    legacyGraph = {},
    legacySourceReady = false,
    previousGraph = legacyGraph,
    reason = "memory-lifecycle-initialized",
    mutationId = "",
  } = {}) {
    const chatId = chatIdFrom(identity, conversationSnapshot);
    const migration = await this.migrations.migrate(
      chatId,
      legacyGraph,
      conversationSnapshot,
      { now: this.now(), legacySourceReady },
    );
    const reconciliation = await this.history.reconcile(
      { ...identity, chatId },
      conversationSnapshot,
      { mutationId, reason, now: this.now() },
    );
    const projection = await this.project(chatId, previousGraph, {
      reason,
      source: "initialize",
    });
    return { chatId, migration, reconciliation, projection };
  }

  async reconcile({
    identity,
    conversationSnapshot,
    previousGraph = null,
    reason = "history-reconciled",
    mutationId = "",
  } = {}) {
    const chatId = chatIdFrom(identity, conversationSnapshot);
    const reconciliation = await this.history.reconcile(
      { ...identity, chatId },
      conversationSnapshot,
      { mutationId, reason, now: this.now() },
    );
    const projection = await this.project(chatId, previousGraph, {
      reason,
      source: "reconcile",
    });
    return { chatId, reconciliation, projection };
  }

  wakeSteward(chatId, { signal = null, previousGraph = null, reason = "memory-inbox" } = {}) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throw new TypeError("Memory Steward wake requires chatId");
    return this._runAgentOperation(async ({ steward }) => {
      const result = await steward.wake(normalizedChatId, { signal });
      const projection = await this.project(normalizedChatId, previousGraph, {
        reason,
        source: "memory-steward",
      });
      return { result, projection };
    });
  }

  async requestSteward(chatId, { intent = "review", payload = {}, note = "" } = {}) {
    const normalizedChatId = String(chatId || "").trim();
    const requestedAt = this.now();
    const requestId = createDomainId("manual-memory-request", {
      chatId: normalizedChatId,
      intent: String(intent || "review"),
      requestedAt,
    });
    const inboxId = createDomainId("inbox", { chatId: normalizedChatId, requestId });
    return await this.repository.transact(normalizedChatId, (ledger) => ({
      baseRevision: ledger.revision,
      idempotencyKey: `manual-memory-request:${requestId}`,
      records: [
        createInboxItemRevision({
          chatId: normalizedChatId,
          inboxId,
          inboxKind: MEMORY_INBOX_KIND.MANUAL_REQUEST,
          status: MEMORY_INBOX_STATUS.PENDING,
          sequence: 0,
          dedupeKey: requestId,
          payload: { ...payload, intent: String(intent || "review") },
          note,
          createdAt: requestedAt,
          availableAt: requestedAt,
        }),
      ],
      reason: `manual-memory-request:${intent || "review"}`,
      now: requestedAt,
    }));
  }

  async recall({
    identity,
    conversationSnapshot,
    userMessage = "",
    userFloor = null,
    recentMessages = [],
    previousGraph = null,
    schema = [],
    embeddingConfig = {},
    retrievalSettings = {},
    retrievalOptions = {},
    signal = null,
  } = {}) {
    const chatId = chatIdFrom(identity, conversationSnapshot);
    const ledger = await this.repository.load(chatId, { fresh: true });
    const turn = resolveHistoryTurn(ledger, conversationSnapshot?.turns || [], {
      userFloor,
      userMessage,
      now: this.now(),
    });
    const result = await this._runAgentOperation(async ({ recall }) =>
      await recall.recall({
        chatId,
        turnId: turn.turnId,
        userMessage,
        recentMessages,
        historyFingerprint: String(conversationSnapshot?.historyFingerprint || ""),
        previousGraph,
        schema,
        embeddingConfig,
        retrievalSettings,
        retrievalOptions,
        signal,
      }));
    return { ...result, turnId: turn.turnId, turnPending: turn.pending === true };
  }

  async publishPlanner({ recallResult, plotText = "", plotBlocks = [], result = {} } = {}) {
    if (!recallResult?.artifactId) {
      throw new TypeError("Planner publication requires a durable Recall artifact");
    }
    return await this.planner.publish({
      chatId: recallResult.chatId,
      turnId: recallResult.turnId,
      inputFingerprint: recallResult.inputFingerprint,
      historyFingerprint: recallResult.historyFingerprint,
      expectedMemoryStateFingerprint: recallResult.memoryStateFingerprint,
      recallArtifactId: recallResult.artifactId,
      selectedMemoryIds: recallResult.selectedMemoryIds || recallResult.selectedNodeIds || [],
      candidateMemoryIds: recallResult.candidateMemoryIds || [],
      plotText,
      plotBlocks,
      result,
    });
  }

  async reviseMemory(chatId, memoryId, updates, previousGraph = null) {
    const committed = await this.manual.revise(chatId, memoryId, updates);
    const projection = await this.project(chatId, previousGraph, {
      reason: "manual-memory-edit",
      source: "manual",
    });
    return { ...committed, projection };
  }

  async archiveMemory(chatId, memoryId, previousGraph = null) {
    const committed = await this.manual.archive(chatId, memoryId);
    const projection = await this.project(chatId, previousGraph, {
      reason: "manual-memory-archive",
      source: "manual",
    });
    return { ...committed, projection };
  }

  async archiveMemories(
    chatId,
    memoryIds,
    previousGraph = null,
    { reason = "manual-memory-archive-many" } = {},
  ) {
    const committed = await this.manual.archiveMany(chatId, memoryIds, { reason });
    const projection = await this.project(chatId, previousGraph, {
      reason,
      source: "manual",
    });
    return { ...committed, projection };
  }

  async archiveAllMemories(
    chatId,
    previousGraph = null,
    { reason = "manual-memory-archive-all" } = {},
  ) {
    const committed = await this.manual.archiveAll(chatId, { reason });
    const projection = await this.project(chatId, previousGraph, {
      reason,
      source: "manual",
    });
    return { ...committed, projection };
  }

  async replaceWithGraphSnapshot(
    chatId,
    graph,
    { reason = "manual-graph-import" } = {},
  ) {
    const committed = await this.manual.replaceWithGraphSnapshot(chatId, graph, { reason });
    const projection = await this.project(chatId, graph, {
      reason,
      source: "manual-import",
    });
    return { ...committed, projection };
  }

  async reusePlanner({ chatId, turnId, inputFingerprint, historyFingerprint = "" } = {}) {
    return await this.planner.reuse({
      chatId,
      turnId,
      inputFingerprint,
      historyFingerprint,
    });
  }

  async reuseRecall({ chatId, turnId, inputFingerprint, historyFingerprint = "" } = {}) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const artifact = findReusableTurnArtifact(ledger, {
      turnId,
      artifactKind: TURN_ARTIFACT_KIND.RECALL,
      inputFingerprint,
      historyFingerprint,
    });
    return artifact ? turnArtifactToRecallResult(artifact) : null;
  }

  async validatePlannerHistoryRecords(chatId, records = []) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId || !Array.isArray(records) || records.length === 0) {
      return [];
    }
    const ledger = await this.repository.load(normalizedChatId, { fresh: true });
    return records.filter((record) => {
      if (!record || typeof record !== "object") return false;
      if (String(record.recallChatId || "").trim() !== normalizedChatId) return false;
      const turnId = String(record.recallTurnId || "").trim();
      const inputFingerprint = String(record.recallInputFingerprint || "").trim();
      const historyFingerprint = String(record.recallHistoryFingerprint || "").trim();
      const recallArtifactId = String(record.recallArtifactId || "").trim();
      const plannerArtifactId = String(record.plannerArtifactId || "").trim();
      if (
        !turnId ||
        !inputFingerprint ||
        !historyFingerprint ||
        !recallArtifactId ||
        !plannerArtifactId
      ) {
        return false;
      }
      const recall = findReusableTurnArtifact(ledger, {
        turnId,
        artifactKind: TURN_ARTIFACT_KIND.RECALL,
        inputFingerprint,
        historyFingerprint,
      });
      const planner = findReusableTurnArtifact(ledger, {
        turnId,
        artifactKind: TURN_ARTIFACT_KIND.PLANNER,
        inputFingerprint,
        historyFingerprint,
      });
      return Boolean(
        recall?.id === recallArtifactId &&
          planner?.id === plannerArtifactId &&
          planner.sourceArtifactIds?.includes(recall.id) &&
          String(planner.memoryStateFingerprint || "") ===
            String(recall.memoryStateFingerprint || "") &&
          String(record.recallMemoryStateFingerprint || "") ===
            String(recall.memoryStateFingerprint || "") &&
          String(planner.contentText || "").trim() ===
            String(record.plotText || "").trim(),
      );
    });
  }

  async fork(sourceIdentity, targetIdentity, options = {}) {
    return await this.branches.fork(sourceIdentity, targetIdentity, options);
  }

  inspect(chatId = "") {
    const currentBundle = this._agentBundles.get(this._agentSettingsKey) || null;
    return {
      chatId: String(chatId || "").trim(),
      repository: this.repository.inspect?.(chatId) || null,
      agentSettingsKey: this._agentSettingsKey,
      activeAgentCalls: [...this._agentBundles.values()].reduce(
        (count, bundle) => count + bundle.activeCalls,
        0,
      ),
      agentBundleCount: this._agentBundles.size,
      steward: currentBundle?.agents?.steward?.service?.inspect?.(chatId) || null,
      recall: currentBundle?.agents?.recall?.service?.inspect?.(chatId) || null,
    };
  }

  dispose() {
    for (const bundle of [...this._agentBundles.values()]) {
      this._disposeBundle(bundle);
    }
    this._agentBundles.clear();
    this._agentSettingsKey = "";
  }
}

export function createBmeMemoryLifecycleRuntime(options = {}) {
  return new BmeMemoryLifecycleRuntime(options);
}
