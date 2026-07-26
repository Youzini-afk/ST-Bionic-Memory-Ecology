import { getHistoryPrefixHash } from "../core/history.js";
import {
  diffGraphs,
  diffStateGraph,
  materializeGraph,
} from "../domain/graph-draft.js";

let defaultVectorApiPromise = null;

async function loadDefaultVectorApi() {
  defaultVectorApiPromise ||= import("../../vector/vector-index.js").then((module) => ({
    getVectorModelScope: module.getVectorModelScope,
    syncGraph: module.syncGraphVectorIndex,
    validateVectorConfig: module.validateVectorConfig,
  }));
  return defaultVectorApiPromise;
}

export class VectorJobWorker {
  #engine;
  #store;
  #config;
  #api;

  constructor({ engine, store, getEmbeddingConfig = () => ({}), vectorApi = null } = {}) {
    if (!engine?.read || !engine?.commit) throw new TypeError("ConversationEngine is required");
    if (!store?.listVectorJobs || !store?.settleVectorJobs) {
      throw new TypeError("StateStore vector job operations are required");
    }
    this.#engine = engine;
    this.#store = store;
    this.#config = getEmbeddingConfig;
    this.#api = vectorApi ? Promise.resolve(vectorApi) : loadDefaultVectorApi();
  }

  async drain(chatKeyInput, { signal } = {}) {
    const chatKey = String(chatKeyInput || "").trim();
    if (!chatKey) throw new TypeError("chatKey is required");
    const jobs = await this.#store.listVectorJobs(chatKey);
    if (jobs.length === 0) return { status: "idle", processed: 0 };

    const api = await this.#api;
    const config = typeof this.#config === "function" ? this.#config() : this.#config;
    const validation = api.validateVectorConfig(config);
    if (!validation.valid) {
      await this.#store.settleVectorJobs({
        chatKey,
        ids: jobs.map(({ id }) => id),
        status: "pending",
        outcome: "retry",
        error: validation.error,
      });
      return { status: "blocked", processed: 0, error: validation.error };
    }

    const modelScope = api.getVectorModelScope(config);
    const lease = Object.freeze({ chatKey, sessionEpoch: 0, signal });
    const state = await this.#engine.read(lease, { requiresActive: false });
    const before = materializeGraph(state);
    const draft = structuredClone(before);

    try {
      // ponytail: full rebuild favors crash recovery; switch to deltas only if profiling demands it.
      const sync = await api.syncGraph(draft, config, {
        chatId: chatKey,
        force: true,
        purge: true,
        idempotencyKey: `vector-job:${jobs.at(-1).id}:${state.head.graphRevision}`,
        signal,
      });
      if (sync?.error) throw new Error(sync.error);

      const domainChanges = diffGraphs(before, draft);
      if (domainChanges.changes.length > 0) {
        await this.#engine.commit(lease, {
          expectedRevision: state.head.revision,
          operation: "vector-sync",
          basisHistoryLength: state.head.history.length,
          basisHistoryHash: getHistoryPrefixHash(state.head.history),
          processedThroughAfter: state.head.processedThrough,
          changeSet: diffStateGraph(state, draft),
          vectorModelScope: modelScope,
          enqueueVectorJob: false,
        }, { requiresActive: false });
      }
      await this.#store.settleVectorJobs({
        chatKey,
        ids: jobs.map(({ id }) => id),
        status: "completed",
        outcome: jobs.some((job) => job.modelScope !== modelScope)
          ? "rebuilt-current-scope"
          : "synced",
      });
      return { status: "completed", processed: jobs.length, modelScope, sync };
    } catch (error) {
      await this.#store.settleVectorJobs({
        chatKey,
        ids: jobs.map(({ id }) => id),
        status: "pending",
        outcome: "retry",
        error: error?.message || String(error),
      });
      return { status: "retry", processed: 0, modelScope, error };
    }
  }
}
