import {
  buildTurnKey,
  getHistoryPrefixHash,
  historyBasisMatches,
} from "../core/history.js";
import { normalizeChangeSet } from "../core/change-set.js";
import { classifyGeneration } from "../host/st-host-adapter.js";

export class RecallStaleError extends Error {
  constructor(chatKey) {
    super(`recall snapshot became stale for ${chatKey}`);
    this.name = "RecallStaleError";
    this.chatKey = chatKey;
  }
}

function normalizeRecallResult(value = {}) {
  const selectedNodeIds = Array.isArray(value.selectedNodeIds)
    ? value.selectedNodeIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const changeSet = normalizeChangeSet(value.changeSet || { changes: [] });
  return {
    selectedNodeIds: [...new Set(selectedNodeIds)],
    injectionText: String(value.injectionText ?? ""),
    tokenEstimate: Number.isFinite(Number(value.tokenEstimate))
      ? Math.max(0, Number(value.tokenEstimate))
      : 0,
    changeSet,
  };
}

export class GenerationCoordinator {
  #engine;
  #host;
  #recall;
  #domains;
  #vectors;
  #logger;
  #generation = null;
  #generationNumber = 0;

  constructor({ engine, host, recall, domains = null, vectors = null, logger = console } = {}) {
    if (!engine?.activate || !engine?.reconcile || !engine?.createRecall) {
      throw new TypeError("ConversationEngine is required");
    }
    if (!host?.snapshotConversation || !host?.setRecallInjection) {
      throw new TypeError("ST HostAdapter is required");
    }
    if (typeof recall !== "function") throw new TypeError("recall provider is required");
    if (domains && typeof domains.processAssistant !== "function") {
      throw new TypeError("domains must implement processAssistant");
    }
    if (vectors && typeof vectors.drain !== "function") {
      throw new TypeError("vectors must implement drain");
    }
    this.#engine = engine;
    this.#host = host;
    this.#recall = recall;
    this.#domains = domains;
    this.#vectors = vectors;
    this.#logger = logger;
  }

  async onChatChanged() {
    this.#generation = null;
    this.#safeClearInjection();
    const snapshot = this.#host.snapshotConversation();
    if (!snapshot.chatKey) {
      this.#engine.deactivate();
      return { status: "no-chat" };
    }
    const lease = this.#engine.activate(snapshot.chatKey);
    const result = await this.#engine.reconcile(lease, snapshot.messages);
    return { status: "ready", snapshot, ...result };
  }

  async onGenerationStarted(type, params = {}, dryRun = false) {
    this.#safeClearInjection();
    const snapshot = this.#host.snapshotConversation();
    const lease = await this.#ensureLease(snapshot);
    const classification = classifyGeneration(type, params, dryRun);
    const generation = {
      id: ++this.#generationNumber,
      lease,
      chatKey: snapshot.chatKey,
      type: classification.type,
      kind: classification.kind,
      sentUser: null,
      preparation: null,
      result: null,
    };
    this.#generation = generation;
    if (generation.kind !== "skip") {
      await this.#engine.reconcile(lease, snapshot.messages);
    }
    return { id: generation.id, type: generation.type, kind: generation.kind };
  }

  onGenerationAfterCommands() {
    return { status: "deferred-to-stable-history" };
  }

  async onMessageSent(messageId) {
    const snapshot = this.#host.snapshotConversation();
    const lease = await this.#ensureLease(snapshot);
    const reconciliation = await this.#engine.reconcile(lease, snapshot.messages);
    const generation = this.#generation;
    if (!generation || generation.chatKey !== snapshot.chatKey || generation.kind === "skip") {
      return { status: "history-only", ...reconciliation };
    }

    const user = this.#host.findUserByHostIndex(snapshot, messageId);
    if (!user) return { status: "unresolved-user-message" };
    generation.kind = "fresh";
    generation.sentUser = user;
    generation.preparation ||= this.#prepareFresh(
      generation,
      snapshot,
      user,
      reconciliation,
    );
    return generation.preparation;
  }

  async onBeforeCombinePrompts() {
    const generation = this.#generation;
    if (!generation || generation.kind === "skip") {
      this.#safeClearInjection();
      return { status: "skipped" };
    }
    if (!generation.preparation) {
      const snapshot = this.#host.snapshotConversation();
      generation.kind = "no-new-user";
      generation.preparation = this.#prepareNoNewUser(generation, snapshot);
    }
    const result = await generation.preparation;
    if (result.status !== "ready") return result;
    this.#assertCurrent(generation);
    this.#host.setRecallInjection(result.injectionText);
    return result;
  }

  async onMessageReceived(messageId) {
    const snapshot = this.#host.snapshotConversation();
    const lease = await this.#ensureLease(snapshot);
    const reconciliation = await this.#engine.reconcile(lease, snapshot.messages);
    const received = snapshot.messages.find(
      (message) => message.hostIndex === Number(messageId),
    );
    if (received?.role !== "assistant") return reconciliation;
    let domains = null;
    try {
      if (this.#domains) {
        domains = await this.#domains.processAssistant({ lease, snapshot, messageId });
      }
    } catch (error) {
      const aborted = error?.name === "AbortError" || error?.name === "LeaseExpiredError";
      if (!aborted) this.#logger?.error?.("[ST-BME v9] assistant domains failed", error);
      domains = { status: aborted ? "aborted" : "failed", error };
    }
    let vectors = null;
    if (this.#vectors) {
      vectors = await this.#vectors.drain(snapshot.chatKey, { signal: lease.signal });
    }
    return { ...reconciliation, domains, vectors };
  }

  async onHistoryChanged() {
    this.#safeClearInjection();
    const snapshot = this.#host.snapshotConversation();
    if (!snapshot.chatKey) return { status: "no-chat" };
    const lease = await this.#ensureLease(snapshot);
    return this.#engine.reconcile(lease, snapshot.messages);
  }

  onGenerationFinished(reason = "ended") {
    this.#generation = null;
    this.#safeClearInjection();
    return { status: "finished", reason };
  }

  async #prepareFresh(generation, snapshot, user, reconciliation) {
    try {
      const history = this.#host.historyThrough(snapshot, user);
      this.#assertCurrent(generation);
      const recalled = await this.#retrieveStable(generation, user.text, history, "fresh");
      const record = await this.#persistRecall(
        generation,
        user,
        reconciliation.head.history.slice(0, history.length),
        recalled,
      );
      this.#assertCurrent(generation);
      this.#host.setRecallInjection(record.injectionText);
      generation.result = { status: "ready", source: "fresh", ...record };
      return generation.result;
    } catch (error) {
      return this.#failGeneration(generation, error);
    }
  }

  async #prepareNoNewUser(generation, snapshot) {
    try {
      const user = this.#host.findParentUser(snapshot);
      if (!user) throw new Error("no parent user message for reroll");
      const history = this.#host.historyThrough(snapshot, user);
      const reconciliation = await this.#engine.reconcile(generation.lease, history);
      this.#assertCurrent(generation);
      const identity = reconciliation.head.history.at(-1);
      const turnKey = await buildTurnKey(generation.chatKey, identity.prefixHash);
      const existing = await this.#engine.readRecall(generation.lease, turnKey);
      if (existing) {
        this.#assertCurrent(generation);
        this.#host.setRecallInjection(existing.injectionText);
        generation.result = { status: "ready", source: "replay", ...existing };
        return generation.result;
      }

      const recalled = await this.#retrieveStable(generation, user.text, history, "reroll-fallback");
      const record = await this.#persistRecall(
        generation,
        user,
        reconciliation.head.history,
        recalled,
      );
      this.#assertCurrent(generation);
      this.#host.setRecallInjection(record.injectionText);
      generation.result = { status: "ready", source: "fresh-fallback", ...record };
      return generation.result;
    } catch (error) {
      return this.#failGeneration(generation, error);
    }
  }

  async #retrieveStable(generation, input, history, reason) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#assertCurrent(generation);
      const state = await this.#engine.read(generation.lease);
      const baseRevision = state.head.revision;
      const graphRevision = state.head.graphRevision;
      const basisHistoryLength = history.length;
      const basisHistoryHash = getHistoryPrefixHash(state.head.history, basisHistoryLength);
      const result = normalizeRecallResult(await this.#recall({
        chatKey: generation.chatKey,
        input,
        history,
        state,
        reason,
        signal: generation.lease.signal,
      }));
      this.#assertCurrent(generation);
      const current = await this.#engine.read(generation.lease);
      if (current.head.revision === baseRevision) {
        if (result.changeSet.changes.length === 0) {
          return { ...result, graphRevision };
        }
        try {
          const committed = await this.#engine.commit(generation.lease, {
            expectedRevision: baseRevision,
            operation: "recall-access",
            basisHistoryLength,
            basisHistoryHash,
            processedThroughAfter: current.head.processedThrough,
            changeSet: result.changeSet,
            enqueueVectorJob: false,
          }, { requiresActive: true });
          return { ...result, graphRevision: committed.head.graphRevision };
        } catch (error) {
          if (attempt === 0 && error?.name === "RevisionConflictError") continue;
          throw error;
        }
      }
      if (!historyBasisMatches(
        current.head.history,
        basisHistoryLength,
        basisHistoryHash,
      )) {
        throw new RecallStaleError(generation.chatKey);
      }
      if (
        current.head.graphRevision === graphRevision &&
        result.changeSet.changes.length === 0
      ) {
        return { ...result, graphRevision };
      }
      if (attempt === 1) throw new RecallStaleError(generation.chatKey);
    }
    throw new RecallStaleError(generation.chatKey);
  }

  async #persistRecall(generation, user, historyIdentity, recalled) {
    const userIdentity = historyIdentity.at(-1);
    if (!userIdentity) throw new Error("user history identity is missing");
    const historyPrefixHash = getHistoryPrefixHash(historyIdentity);
    const turnKey = await buildTurnKey(generation.chatKey, historyPrefixHash);
    const result = await this.#engine.createRecall(generation.lease, {
      turnKey,
      chatKey: generation.chatKey,
      boundUserMessageHash: userIdentity.messageHash,
      historyPrefixHash,
      recallInput: user.text,
      selectedNodeIds: recalled.selectedNodeIds,
      injectionText: recalled.injectionText,
      tokenEstimate: recalled.tokenEstimate,
      graphRevision: recalled.graphRevision,
    });
    return result.record;
  }

  async #ensureLease(snapshot) {
    if (!snapshot.chatKey) throw new Error("no active SillyTavern chat");
    const active = this.#engine.getActiveLease();
    if (active && active.chatKey === snapshot.chatKey && this.#engine.isLeaseActive(active)) {
      return active;
    }
    this.#generation = null;
    const lease = this.#engine.activate(snapshot.chatKey);
    await this.#engine.reconcile(lease, snapshot.messages);
    return lease;
  }

  #assertCurrent(generation) {
    this.#engine.assertLeaseActive(generation.lease);
    if (this.#generation !== generation) throw new RecallStaleError(generation.chatKey);
  }

  #failGeneration(generation, error) {
    if (this.#generation === generation) this.#safeClearInjection();
    const stale = error instanceof RecallStaleError || error?.name === "LeaseExpiredError";
    if (!stale) this.#logger?.error?.("[ST-BME v9] recall preparation failed", error);
    return {
      status: stale ? "aborted" : "failed",
      source: "none",
      selectedNodeIds: [],
      injectionText: "",
      tokenEstimate: 0,
      error,
    };
  }

  #safeClearInjection() {
    try {
      this.#host.clearRecallInjection();
    } catch (error) {
      this.#logger?.warn?.("[ST-BME v9] failed to clear recall injection", error);
    }
  }
}
