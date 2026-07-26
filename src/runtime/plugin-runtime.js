import { createEmptyGraph, removeNode } from "../../graph/graph.js";
import { DEFAULT_NODE_SCHEMA } from "../../graph/schema.js";
import { createAuthorityHttpClient } from "../../runtime/authority-http-client.js";
import { normalizeAuthorityVectorConfig } from "../../vector/authority-vector-primary-adapter.js";
import { ConversationEngine } from "../core/conversation-engine.js";
import { getHistoryPrefixHash } from "../core/history.js";
import { DomainPipeline } from "../domain/domain-pipeline.js";
import { materializeGraph, planGraphMutation } from "../domain/graph-draft.js";
import { recallFromState } from "../domain/recall-provider.js";
import { GenerationCoordinator } from "../generation/generation-coordinator.js";
import { StHostAdapter } from "../host/st-host-adapter.js";
import { EnaPlannerService } from "../planner/ena-planner.js";
import { PlannerSendCoordinator } from "../planner/send-coordinator.js";
import { AuthorityStateStore } from "../storage/authority-state-store.js";
import { IndexedDbStateStore } from "../storage/indexeddb-state-store.js";
import { VectorJobWorker } from "../vector/vector-job-worker.js";
import { normalizeSettings, patchSettings } from "./settings.js";

export const GRAPH_TRANSFER_FORMAT = "st-bme-v9-graph";
export const GRAPH_TRANSFER_VERSION = 1;

class NoActiveChatError extends Error {
  constructor() {
    super("no active SillyTavern chat");
    this.name = "NoActiveChatError";
  }
}

const HISTORY_CONTEXT_KEYS = Object.freeze([
  "lastExtractedRegion",
  "activeRegion",
  "activeRegionSource",
  "activeStorySegmentId",
  "activeStoryTimeLabel",
  "activeStoryTimeSource",
  "lastExtractedStorySegmentId",
  "activeCharacterPovOwner",
  "activeUserPovOwner",
]);

function clone(value) {
  return structuredClone(value);
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function validateGraphRecords(graph) {
  requirePlainObject(graph, "graph");
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError("graph nodes and edges must be arrays");
  }
  const nodeIds = new Set();
  for (const [index, node] of graph.nodes.entries()) {
    requirePlainObject(node, `graph.nodes[${index}]`);
    const id = String(node.id || "").trim();
    if (!id || nodeIds.has(id)) throw new TypeError(`invalid or duplicate node id: ${id}`);
    if (!String(node.type || "").trim()) throw new TypeError(`node ${id} requires a type`);
    requirePlainObject(node.fields, `node ${id} fields`);
    if (!Array.isArray(node.childIds)) throw new TypeError(`node ${id} childIds must be an array`);
    nodeIds.add(id);
  }
  for (const node of graph.nodes) {
    const references = [node.parentId, node.prevId, node.nextId, ...node.childIds]
      .filter((id) => id !== null && id !== undefined && String(id).trim());
    if (references.some((id) => !nodeIds.has(String(id)))) {
      throw new TypeError(`node ${node.id} references a missing node`);
    }
  }
  const edgeIds = new Set();
  for (const [index, edge] of graph.edges.entries()) {
    requirePlainObject(edge, `graph.edges[${index}]`);
    const id = String(edge.id || "").trim();
    const fromId = String(edge.fromId || "").trim();
    const toId = String(edge.toId || "").trim();
    if (!id || edgeIds.has(id)) throw new TypeError(`invalid or duplicate edge id: ${id}`);
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) {
      throw new TypeError(`edge ${id} references a missing node`);
    }
    edgeIds.add(id);
  }
}

function exportGraphState(state) {
  const graph = materializeGraph(state);
  const historyContext = Object.fromEntries(
    HISTORY_CONTEXT_KEYS.map((key) => [key, clone(graph.historyState?.[key])]),
  );
  return JSON.stringify({
    format: GRAPH_TRANSFER_FORMAT,
    version: GRAPH_TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    sourceGraphRevision: state.head.graphRevision,
    graph: {
      nodes: graph.nodes.map((node) => ({ ...clone(node), embedding: null })),
      edges: clone(graph.edges),
      knowledgeState: clone(graph.knowledgeState),
      regionState: clone(graph.regionState),
      timelineState: clone(graph.timelineState),
      summaryState: clone(graph.summaryState),
      historyContext,
    },
  }, null, 2);
}

function importGraphState(value, chatKey, processedThrough) {
  const parsed = typeof value === "string" ? JSON.parse(value) : clone(value);
  requirePlainObject(parsed, "graph import");
  if (parsed.format !== GRAPH_TRANSFER_FORMAT || parsed.version !== GRAPH_TRANSFER_VERSION) {
    throw new TypeError("only a current ST-BME v9 graph export can be imported");
  }
  const imported = requirePlainObject(parsed.graph, "graph import payload");
  validateGraphRecords(imported);
  const graph = createEmptyGraph();
  graph.nodes = clone(imported.nodes);
  graph.edges = clone(imported.edges);
  for (const key of ["knowledgeState", "regionState", "timelineState", "summaryState"]) {
    if (imported[key] !== undefined) graph[key] = clone(imported[key]);
  }
  const context = imported.historyContext === undefined
    ? {}
    : requirePlainObject(imported.historyContext, "graph historyContext");
  for (const key of HISTORY_CONTEXT_KEYS) {
    if (Object.hasOwn(context, key)) graph.historyState[key] = clone(context[key]);
  }
  graph.historyState.chatId = chatKey;
  graph.historyState.lastProcessedAssistantFloor = processedThrough;
  graph.lastProcessedSeq = processedThrough;
  graph.vectorIndexState.collectionId = `st-bme-v9::${chatKey}`;
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.lastWarning = "imported graph requires a vector rebuild";
  return graph;
}

function replaceGraph(target, replacement) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

async function createPrimaryStore(primary, options) {
  if (options.store) return options.store;
  if (primary === "authority") {
    return new AuthorityStateStore({
      client: options.authorityClient,
      timeoutMs: options.settings.timeoutMs,
    });
  }
  return new IndexedDbStateStore(options.indexedDbOptions);
}

export async function createPluginRuntime(options = {}) {
  if (typeof options.getContext !== "function") throw new TypeError("getContext is required");
  let settings = normalizeSettings(options.settings);
  const activePrimary = settings.primary;
  const activeEnabled = settings.enabled;
  const logger = options.logger || console;
  const authorityClient = options.authorityClient || (activePrimary === "authority"
    ? createAuthorityHttpClient({
        baseUrl: settings.authorityBaseUrl,
        timeoutMs: settings.timeoutMs,
        headerProvider: options.headerProvider,
        version: options.version || "9.0.0",
      })
    : null);
  const store = await createPrimaryStore(activePrimary, {
    ...options,
    authorityClient,
    settings,
  });
  const vectorApi = options.vectorApi || await import("../../vector/vector-index.js");
  const getEmbeddingConfig = () => activePrimary === "authority"
    ? normalizeAuthorityVectorConfig(settings, { authorityClient })
    : vectorApi.getVectorConfigFromSettings(settings);
  const engine = new ConversationEngine({ store });
  const host = new StHostAdapter({
    getContext: options.getContext,
    getCurrentChatId: options.getCurrentChatId,
    documentLike: options.documentLike,
    logger,
    prompt: {
      position: settings.injectPosition,
      depth: settings.injectDepth,
      role: settings.injectRole,
    },
  });

  const listeners = new Set();
  const status = {
    activePrimary,
    availability: "starting",
    activity: "idle",
    detail: "",
    error: null,
    updatedAt: Date.now(),
  };
  const notify = (patch = {}) => {
    Object.assign(status, patch, { updatedAt: Date.now() });
    const snapshot = clone(status);
    for (const listener of listeners) {
      try { listener(snapshot); } catch (error) { logger?.warn?.("[ST-BME v9] status listener failed", error); }
    }
  };

  const recall = options.recall || ((request) => recallFromState({
    ...request,
    settings,
    schema: options.schema || DEFAULT_NODE_SCHEMA,
    embeddingConfig: getEmbeddingConfig(),
  }));
  const domains = options.domains || new DomainPipeline({
    engine,
    getSettings: () => settings,
    getSchema: () => options.schema || DEFAULT_NODE_SCHEMA,
    getEmbeddingConfig,
    operations: options.domainOperations,
    logger,
    onStage: ({ stage, status: stageStatus }) => notify({
      activity: `${stage}:${stageStatus}`,
      detail: "",
    }),
  });
  const vectors = options.vectors || new VectorJobWorker({
    engine,
    store,
    getEmbeddingConfig,
    vectorApi: {
      getVectorModelScope: vectorApi.getVectorModelScope,
      syncGraph: vectorApi.syncGraphVectorIndex,
      validateVectorConfig: vectorApi.validateVectorConfig,
    },
  });
  const plannerService = options.plannerService || new EnaPlannerService({
    getSettings: () => settings,
    getHostContext: options.getHostContext || (() => ({})),
    ...(options.plannerRuntime || {}),
  });
  const planner = options.planner || new PlannerSendCoordinator({
    engine,
    host,
    recall,
    planner: plannerService,
    getOptions: () => settings.ena,
    logger,
    onStatus: ({ status: plannerStatus }) => notify({
      activity: `planner:${plannerStatus}`,
      detail: "",
    }),
  });
  const generation = options.generation || new GenerationCoordinator({
    engine,
    host,
    recall,
    planner,
    domains,
    vectors,
    logger,
  });

  let cleanups = [];

  async function activeContext() {
    const snapshot = host.snapshotConversation();
    if (!snapshot.chatKey) throw new NoActiveChatError();
    let lease = engine.getActiveLease();
    if (!lease || lease.chatKey !== snapshot.chatKey || !engine.isLeaseActive(lease)) {
      await generation.onChatChanged();
      lease = engine.getActiveLease();
    }
    await engine.reconcile(lease, snapshot.messages);
    return { snapshot, lease };
  }

  async function readActive() {
    const { snapshot, lease } = await activeContext();
    const state = await engine.read(lease);
    notify({ availability: "ready", error: null, activity: "idle", detail: snapshot.chatKey });
    return { snapshot, lease, state, graph: materializeGraph(state) };
  }

  async function commitGraph(operation, mutate, { forceVectorJob = false } = {}) {
    const { snapshot, lease } = await activeContext();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await engine.read(lease);
      const planned = await planGraphMutation(state, mutate);
      const touchesVector = planned.changeSet.changes.some(
        ({ collection }) => collection === "nodes" || collection === "edges",
      );
      if (planned.changeSet.changes.length === 0 && !forceVectorJob) {
        return { status: "unchanged", state, graph: planned.graph };
      }
      const config = getEmbeddingConfig();
      const validation = vectorApi.validateVectorConfig(config);
      try {
        const committed = await engine.commit(lease, {
          expectedRevision: state.head.revision,
          operation,
          basisHistoryLength: state.head.history.length,
          basisHistoryHash: getHistoryPrefixHash(state.head.history),
          processedThroughAfter: state.head.processedThrough,
          changeSet: planned.changeSet,
          vectorModelScope: validation.valid
            ? vectorApi.getVectorModelScope(config)
            : "unconfigured",
          enqueueVectorJob: touchesVector,
          forceVectorJob,
        });
        notify({ availability: "ready", error: null, activity: operation, detail: snapshot.chatKey });
        return { status: "committed", ...committed, graph: planned.graph };
      } catch (error) {
        if (attempt === 0 && error?.name === "RevisionConflictError") continue;
        throw error;
      }
    }
    throw new Error(`${operation} could not commit`);
  }

  const runtime = {
    activePrimary,
    activeEnabled,
    store,
    engine,
    host,
    generation,
    domains,
    vectors,
    planner,

    getSettings: () => clone(settings),
    getStatus: () => clone(status),
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      listener(clone(status));
      return () => listeners.delete(listener);
    },

    async start() {
      if (cleanups.length > 0) return this.getStatus();
      if (activeEnabled) {
        cleanups = [host.bind(generation), host.bindPlannerSend(planner)];
      }
      try {
        const result = await generation.onChatChanged();
        notify({
          availability: "ready",
          activity: "idle",
          detail: result.snapshot?.chatKey || "no-chat",
          error: null,
        });
      } catch (error) {
        notify({ availability: "blocked", activity: "idle", detail: "", error });
        logger?.error?.(`[ST-BME v9] ${activePrimary} Primary unavailable`, error);
      }
      return this.getStatus();
    },

    async dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup?.();
      planner.cancelPending("dispose");
      engine.deactivate();
      await store.close?.();
      notify({ availability: "stopped", activity: "idle", detail: "", error: null });
    },

    async saveSettings(patch) {
      const previous = settings;
      const next = patchSettings(settings, patch);
      await options.persistSettings?.(clone(next));
      settings = next;
      const reloadRequired = next.primary !== activePrimary || next.enabled !== activeEnabled ||
        next.injectPosition !== previous.injectPosition ||
        next.injectDepth !== previous.injectDepth ||
        next.injectRole !== previous.injectRole;
      notify({ activity: "settings:saved", detail: reloadRequired ? "reload-required" : "" });
      return { settings: clone(settings), reloadRequired };
    },

    async snapshot() {
      try {
        const current = await readActive();
        return {
          settings: clone(settings),
          status: clone(status),
          chatKey: current.snapshot.chatKey,
          head: clone(current.state.head),
          graph: current.graph,
          recallRecords: [...current.state.recallRecords.values()].map(clone),
          plannerRecords: [...current.state.plannerRecords.values()].map(clone),
          vectorJobs: [...current.state.vectorJobs.values()].map(clone),
        };
      } catch (error) {
        if (error?.name === "NoActiveChatError") {
          notify({ availability: "ready", activity: "idle", detail: "no-chat", error: null });
        } else {
          notify({ availability: "blocked", activity: "idle", detail: "", error });
        }
        throw error;
      }
    },

    async manualExtract() {
      const { snapshot, lease } = await activeContext();
      const assistant = [...snapshot.messages].reverse().find(({ role }) => role === "assistant");
      if (!assistant) throw new Error("the active chat has no assistant message to extract");
      const result = await domains.processAssistant({
        lease,
        snapshot,
        messageId: assistant.hostIndex,
        force: true,
      });
      const vectorResult = await vectors.drain(snapshot.chatKey, { signal: lease.signal });
      notify({ availability: "ready", activity: "extract:completed", detail: snapshot.chatKey, error: null });
      return { ...result, vectors: vectorResult };
    },

    async rebuildVectors() {
      const result = await commitGraph("vector-rebuild", () => undefined, { forceVectorJob: true });
      const { snapshot, lease } = await activeContext();
      const vectorResult = await vectors.drain(snapshot.chatKey, { signal: lease.signal });
      notify({ availability: "ready", activity: `vectors:${vectorResult.status}`, detail: snapshot.chatKey, error: null });
      return { commit: result, vectors: vectorResult };
    },

    async updateNode(nodeIdInput, updates = {}) {
      const nodeId = String(nodeIdInput || "").trim();
      if (!nodeId) throw new TypeError("nodeId is required");
      requirePlainObject(updates, "node updates");
      return await commitGraph("node-update", (graph) => {
        const node = graph.nodes.find(({ id }) => id === nodeId);
        if (!node) throw new Error(`node not found: ${nodeId}`);
        if (Object.hasOwn(updates, "fields")) node.fields = clone(requirePlainObject(updates.fields, "node fields"));
        if (Object.hasOwn(updates, "importance")) {
          const importance = Number(updates.importance);
          if (!Number.isFinite(importance) || importance < 0 || importance > 10) {
            throw new TypeError("node importance must be between 0 and 10");
          }
          node.importance = importance;
        }
        if (Object.hasOwn(updates, "archived")) {
          if (typeof updates.archived !== "boolean") throw new TypeError("node archived must be boolean");
          node.archived = updates.archived;
        }
        node.updatedAt = Date.now();
      });
    },

    async deleteNode(nodeIdInput) {
      const nodeId = String(nodeIdInput || "").trim();
      if (!nodeId) throw new TypeError("nodeId is required");
      return await commitGraph("node-delete", (graph) => {
        if (!graph.nodes.some(({ id }) => id === nodeId)) throw new Error(`node not found: ${nodeId}`);
        removeNode(graph, nodeId);
      });
    },

    async clearGraph() {
      const { snapshot } = await activeContext();
      return await commitGraph("graph-clear", (graph) => {
        const replacement = createEmptyGraph();
        replacement.historyState.chatId = snapshot.chatKey;
        replacement.historyState.lastProcessedAssistantFloor = graph.lastProcessedSeq;
        replacement.lastProcessedSeq = graph.lastProcessedSeq;
        replaceGraph(graph, replacement);
      });
    },

    async exportGraph() {
      const { state } = await readActive();
      return exportGraphState(state);
    },

    async importGraph(value) {
      const { snapshot, state } = await readActive();
      const imported = importGraphState(value, snapshot.chatKey, state.head.processedThrough);
      return await commitGraph("graph-import", (graph) => replaceGraph(graph, imported), {
        forceVectorJob: true,
      });
    },
  };

  return runtime;
}
