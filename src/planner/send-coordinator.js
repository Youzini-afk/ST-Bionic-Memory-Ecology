import { normalizeRecallResult } from "../core/recall-record.js";
import {
  decideEnaSend,
  normalizeEnaOptions,
} from "./ena-planner.js";

export class PlannerSendCoordinator {
  #engine;
  #host;
  #recall;
  #planner;
  #getOptions;
  #onStatus;
  #logger;
  #active = null;
  #pending = null;

  constructor({
    engine,
    host,
    recall,
    planner,
    getOptions = () => ({}),
    onStatus = null,
    logger = console,
  } = {}) {
    if (!engine?.activate || !engine?.reconcile || !engine?.read) {
      throw new TypeError("ConversationEngine is required");
    }
    if (!host?.snapshotConversation || !host?.resumeUserSend) {
      throw new TypeError("planner host adapter is required");
    }
    if (typeof recall !== "function") throw new TypeError("recall provider is required");
    if (!planner?.run) throw new TypeError("ENA planner service is required");
    if (typeof getOptions !== "function") throw new TypeError("getOptions is required");
    this.#engine = engine;
    this.#host = host;
    this.#recall = recall;
    this.#planner = planner;
    this.#getOptions = getOptions;
    this.#onStatus = onStatus;
    this.#logger = logger;
  }

  get isBusy() {
    return Boolean(this.#active || this.#pending);
  }

  decideUserSend(input) {
    const inputText = String(input ?? "");
    if (this.#active) return { intercept: true, reason: "busy", input: inputText };
    if (this.#pending) {
      if (inputText === this.#pending.augmentedUserMessage) {
        return { intercept: false, reason: "pending-retry", input: inputText };
      }
      this.#pending = null;
    }
    let options;
    try {
      options = normalizeEnaOptions(this.#getOptions() || {});
    } catch (error) {
      this.#logger?.error?.("[ST-BME v9] invalid ENA settings", error);
      return { intercept: false, reason: "invalid-settings", input: "" };
    }
    return { ...decideEnaSend(input, options), options };
  }

  async handleUserSend(input, preparedDecision = null) {
    const inputText = String(input ?? "");
    const decision = preparedDecision?.input === inputText
      ? preparedDecision
      : this.decideUserSend(inputText);
    if (!decision.intercept) return { status: "passed", reason: decision.reason };
    if (decision.reason === "busy") return { status: "busy" };

    const options = decision.options;
    const token = { cancelled: false, lease: null, chatKey: "" };
    this.#active = token;
    try {
      const snapshot = this.#host.snapshotConversation();
      if (!snapshot.chatKey) throw new Error("no active SillyTavern chat");
      token.chatKey = snapshot.chatKey;
      token.lease = this.#ensureLease(snapshot.chatKey);
      this.#emitStatus(token, "planning");
      await this.#engine.reconcile(token.lease, snapshot.messages);
      this.#assertActive(token);
      const state = await this.#engine.read(token.lease);
      const recallCandidate = await this.#runPlannerRecall(
        token,
        decision.input,
        snapshot.messages,
        state,
      );
      const planned = await this.#planner.run({
        rawUserInput: decision.input,
        recallText: recallCandidate?.injectionText || "",
        history: snapshot.messages,
        plannerRecords: [...(state.plannerRecords?.values?.() || [])],
        options,
        signal: token.lease.signal,
        onProgress: (progress) => {
          if (this.#isActive(token)) this.#emitStatus(token, "streaming", { progress });
        },
      });
      this.#assertActive(token);
      const plotText = String(planned.filtered || "").trim();
      if (!plotText) throw new Error("planner returned no usable output");
      const augmentedUserMessage = `${decision.input}\n\n${plotText}`;
      this.#pending = Object.freeze({
        chatKey: token.chatKey,
        sessionEpoch: token.lease.sessionEpoch,
        rawUserInput: decision.input,
        augmentedUserMessage,
        plotText,
        plotBlocks: Object.freeze([...(planned.plotBlocks || [])]),
        promptProfileId: String(planned.promptProfileId || "default"),
        recallCandidate: recallCandidate ? structuredClone(recallCandidate) : null,
        generationId: null,
      });
      this.#emitStatus(token, "planned");
      if (await this.#host.resumeUserSend(augmentedUserMessage, decision.input) === false) {
        this.#pending = null;
        return { status: "aborted", reason: "input-changed" };
      }
      return { status: "resumed", augmentedUserMessage };
    } catch (error) {
      const aborted = !this.#isActive(token) || error?.name === "LeaseExpiredError" ||
        error?.name === "AbortError";
      if (this.#pending?.sessionEpoch === token.lease?.sessionEpoch) this.#pending = null;
      if (aborted) return { status: "aborted", error };
      this.#logger?.error?.("[ST-BME v9] ENA planning failed; sending original input", error);
      this.#emitStatus(token, "failed", { error });
      if (this.#host.snapshotConversation().chatKey === token.chatKey) {
        if (await this.#host.resumeUserSend(decision.input, decision.input) === false) {
          return { status: "aborted", reason: "input-changed", error };
        }
        return { status: "fail-open", error };
      }
      return { status: "aborted", error };
    } finally {
      if (this.#active === token) this.#active = null;
    }
  }

  bindGeneration({ lease, generationId, kind } = {}) {
    const pending = this.#pending;
    if (!pending) return { status: "empty" };
    const normalizedGenerationId = Number(generationId);
    if (
      kind !== "fresh-candidate" ||
      !Number.isSafeInteger(normalizedGenerationId) ||
      normalizedGenerationId < 1 ||
      !lease ||
      pending.chatKey !== lease.chatKey ||
      pending.sessionEpoch !== lease.sessionEpoch ||
      !this.#engine.isLeaseActive(lease)
    ) {
      this.#pending = null;
      return { status: "rejected" };
    }
    if (pending.generationId !== null) {
      return { status: "already-bound", generationId: pending.generationId };
    }
    this.#pending = Object.freeze({ ...pending, generationId: normalizedGenerationId });
    return { status: "bound", generationId: normalizedGenerationId };
  }

  takePending({ lease, user, generationId } = {}) {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || !lease || !user) return null;
    if (
      pending.chatKey !== lease.chatKey ||
      pending.sessionEpoch !== lease.sessionEpoch ||
      pending.generationId !== Number(generationId) ||
      !this.#engine.isLeaseActive(lease)
    ) {
      return null;
    }
    return {
      ...structuredClone(pending),
      augmentedUserMessage: String(user.text ?? ""),
    };
  }

  cancelPending(reason = "cancelled") {
    if (this.#active) this.#active.cancelled = true;
    this.#active = null;
    this.#pending = null;
    return { status: "cancelled", reason };
  }

  #ensureLease(chatKey) {
    const active = this.#engine.getActiveLease();
    if (active && active.chatKey === chatKey && this.#engine.isLeaseActive(active)) return active;
    this.#pending = null;
    return this.#engine.activate(chatKey);
  }

  async #runPlannerRecall(token, input, history, state) {
    try {
      const recalled = normalizeRecallResult(await this.#recall({
        chatKey: token.chatKey,
        input,
        history,
        state,
        reason: "planner",
        signal: token.lease.signal,
      }));
      this.#assertActive(token);
      if (!recalled.injectionText.trim()) return null;
      return { ...recalled, graphRevision: state.head.graphRevision };
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "LeaseExpiredError") throw error;
      this.#logger?.warn?.("[ST-BME v9] planner recall failed; continuing without memory", error);
      return null;
    }
  }

  #isActive(token) {
    return Boolean(
      this.#active === token &&
      !token.cancelled &&
      token.lease &&
      this.#engine.isLeaseActive(token.lease),
    );
  }

  #assertActive(token) {
    if (!this.#isActive(token)) {
      const error = new Error(`planner send became stale for ${token.chatKey}`);
      error.name = "AbortError";
      throw error;
    }
  }

  #emitStatus(token, status, detail = {}) {
    if (typeof this.#onStatus !== "function" || !this.#isActive(token)) return;
    this.#onStatus({ status, chatKey: token.chatKey, ...detail });
  }
}
