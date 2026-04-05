import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { pruneProcessedMessageHashesFromFloor } from "../chat-history.js";
import {
  onBeforeCombinePromptsController,
  onCharacterMessageRenderedController,
  onChatChangedController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageSentController,
  onMessageReceivedController,
  onMessageSwipedController,
  onUserMessageRenderedController,
  registerCoreEventHooksController,
} from "../event-binding.js";
import {
  onRerollController,
  runExtractionController,
} from "../extraction-controller.js";
import {
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  MODULE_NAME,
} from "../graph-persistence.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  markPersistedRecallManualEdit,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
} from "../recall-persistence.js";
import {
  BATCH_STAGE_ORDER,
  BATCH_STAGE_SEVERITY,
  clampInt,
  createBatchStageStatus,
  createBatchStatusSkeleton,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  finalizeBatchStatus,
  getGenerationRecallHookStateFromResult,
  getRecallHookLabel,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTerminalGenerationRecallHookState,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  pushBatchStageArtifact,
  setBatchStageOutcome,
  shouldRunRecallForTransaction,
} from "../ui-status.js";
import {
  onManualCompressController,
  onManualEvolveController,
  onManualSleepController,
} from "../ui-actions-controller.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 0));
const extensionsShimSource = [
  "export const extension_settings = globalThis.__p0ExtensionSettings || {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return { 'Content-Type': 'application/json' };",
  "}",
].join("\n");
const openAiShimSource = [
  "export const chat_completion_sources = { CUSTOM: 'custom', OPENAI: 'openai' };",
  "export async function sendOpenAIRequest(...args) {",
  "  if (typeof globalThis.__p0SendOpenAIRequest === 'function') {",
  "    return await globalThis.__p0SendOpenAIRequest(...args);",
  "  }",
  "  return { choices: [{ message: { content: '{}' } }] };",
  "}",
].join("\n");

const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;
const scriptShimUrl = `data:text/javascript,${encodeURIComponent(
  scriptShimSource,
)}`;
const openAiShimUrl = `data:text/javascript,${encodeURIComponent(
  openAiShimSource,
)}`;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: extensionsShimUrl,
      };
    }
    if (specifier === "../../../../script.js") {
      return {
        shortCircuit: true,
        url: scriptShimUrl,
      };
    }
    if (specifier === "../../../openai.js") {
      return {
        shortCircuit: true,
        url: openAiShimUrl,
      };
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
const originalP0ExtensionSettings = globalThis.__p0ExtensionSettings;
const originalP0SendOpenAIRequest = globalThis.__p0SendOpenAIRequest;
const originalStBmeTestOverrides = globalThis.__stBmeTestOverrides;
globalThis.__p0ExtensionSettings = {
  st_bme: {},
};
globalThis.__stBmeTestOverrides = {};
globalThis.require = require;

const {
  createEmptyGraph,
  createNode,
  addNode,
  createEdge,
  addEdge,
  removeNode,
} = await import("../graph.js");
const { compressType } = await import("../compressor.js");
const { syncGraphVectorIndex } = await import("../vector-index.js");
const { extractMemories } = await import("../extractor.js");
const { consolidateMemories } = await import("../consolidator.js");
const {
  createBatchJournalEntry,
  buildReverseJournalRecoveryPlan,
  normalizeGraphRuntimeState,
  rollbackBatch,
} = await import("../runtime-state.js");
const { createDefaultTaskProfiles } = await import("../prompt-profiles.js");
const extensionsApi = await import("../../../../extensions.js");
const llm = await import("../llm.js");
const embedding = await import("../embedding.js");

if (originalRequire === undefined) {
  delete globalThis.require;
} else {
  globalThis.require = originalRequire;
}

if (originalP0ExtensionSettings === undefined) {
  delete globalThis.__p0ExtensionSettings;
} else {
  globalThis.__p0ExtensionSettings = originalP0ExtensionSettings;
}

if (originalP0SendOpenAIRequest === undefined) {
  delete globalThis.__p0SendOpenAIRequest;
} else {
  globalThis.__p0SendOpenAIRequest = originalP0SendOpenAIRequest;
}

if (originalStBmeTestOverrides === undefined) {
  delete globalThis.__stBmeTestOverrides;
} else {
  globalThis.__stBmeTestOverrides = originalStBmeTestOverrides;
}

const schema = [
  {
    id: "event",
    label: "事件",
    columns: [
      { name: "title" },
      { name: "summary" },
      { name: "participants" },
      { name: "status" },
    ],
    compression: {
      mode: "hierarchical",
      threshold: 2,
    },
  },
  {
    id: "character",
    label: "角色",
    columns: [{ name: "name" }, { name: "state" }],
    latestOnly: true,
  },
  {
    id: "synopsis",
    label: "概要",
    columns: [{ name: "summary" }, { name: "scope" }],
  },
];

function createBatchStageHarness() {
  return fs.readFile(indexPath, "utf8").then((source) => {
    const marker = "function notifyHistoryDirty(dirtyFrom, reason) {";
    const start = source.indexOf("function shouldAdvanceProcessedHistory(");
    const end = source.indexOf(marker);
    const resolvedEnd = end >= 0 ? end : endFallback;
    if (start < 0 || resolvedEnd < 0 || resolvedEnd <= start) {
      throw new Error("无法从 index.js 提取批次状态机定义");
    }
    const snippet = source
      .slice(start, resolvedEnd)
      .replace(/^export\s+/gm, "");
    const context = {
      console,
      result: null,
      extractionCount: 0,
      currentGraph: null,
      consolidateMemories: async () => {},
      generateSynopsis: async () => {},
      generateReflection: async () => {},
      sleepCycle: () => {},
      compressAll: async () => ({ created: 0, archived: 0 }),
      syncVectorState: async () => ({
        insertedHashes: [],
        stats: { pending: 0 },
      }),
      getSchema: () => schema,
      getEmbeddingConfig: () => null,
      getVectorIndexStats: () => ({ pending: 0 }),
      analyzeAutoConsolidationGate: async () => ({
        triggered: false,
        reason: "本批新增少且无明显重复风险，跳过自动整合",
        matchedScore: null,
        matchedNodeId: "",
      }),
      inspectAutoCompressionCandidates: () => ({
        hasCandidates: false,
        reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
      }),
      updateLastExtractedItems: () => {},
      ensureCurrentGraphRuntimeState: () => {},
      throwIfAborted: () => {},
      isAbortError: () => false,
      createAbortError: (message) => new Error(message),
      BATCH_STAGE_ORDER,
      BATCH_STAGE_SEVERITY,
      createBatchStageStatus,
      createBatchStatusSkeleton,
      setBatchStageOutcome,
      pushBatchStageArtifact,
      finalizeBatchStatus,
      createUiStatus,
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { createBatchStatusSkeleton, finalizeBatchStatus, handleExtractionSuccess, setBatchStageOutcome, shouldAdvanceProcessedHistory };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function createHistoryRecoveryHarness() {
  return fs.readFile(indexPath, "utf8").then((source) => {
    const start = source.indexOf("async function recoverHistoryIfNeeded(");
    const endFallback = source.indexOf("async function runExtraction()");
    const end = source.indexOf("/**\n * 提取管线：处理未提取的对话楼层");
    const resolvedEnd = end >= 0 ? end : endFallback;
    if (start < 0 || resolvedEnd < 0 || resolvedEnd <= start) {
      throw new Error("无法从 index.js 提取 history recovery 定义");
    }
    const snippet = source
      .slice(start, resolvedEnd)
      .replace(/^export\s+/gm, "");
    const context = {
      console,
      Date,
      result: null,
      currentGraph: null,
      extractionCount: 0,
      isRecoveringHistory: false,
      chat: [],
      clearedHistoryDirty: null,
      prepareVectorStateCalls: [],
      saveGraphToChatCalls: 0,
      refreshPanelCalls: 0,
      notices: [],
      embeddingConfig: { mode: "backend" },
      ensureCurrentGraphRuntimeState() {
        return context.currentGraph;
      },
      beginStageAbortController() {
        return {
          signal: { aborted: false },
          abort() {},
        };
      },
      finishStageAbortController() {},
      updateStageNotice(...args) {
        context.notices.push(args);
      },
      inspectHistoryMutation() {
        return context.inspectHistoryMutationImpl();
      },
      inspectHistoryMutationImpl() {
        return {
          dirty: true,
          earliestAffectedFloor: 0,
          source: "manual-test",
          reason: "edited",
        };
      },
      getContext() {
        return {
          chat: context.chat,
          chatId: "chat-main",
        };
      },
      getCurrentChatId() {
        return "chat-main";
      },
      clampRecoveryStartFloor(chat, floor) {
        return Math.max(0, Number(floor) || 0);
      },
      throwIfAborted(signal, message = "aborted") {
        if (signal?.aborted) {
          const error = new Error(message);
          error.name = "AbortError";
          throw error;
        }
      },
      createAbortError(message = "aborted") {
        const error = new Error(message);
        error.name = "AbortError";
        return error;
      },
      isAbortError(error) {
        return error?.name === "AbortError";
      },
      findJournalRecoveryPoint(graph, floor) {
        return context.findJournalRecoveryPointImpl(graph, floor);
      },
      findJournalRecoveryPointImpl() {
        return null;
      },
      buildReverseJournalRecoveryPlan(...args) {
        return context.buildReverseJournalRecoveryPlanImpl(...args);
      },
      buildReverseJournalRecoveryPlanImpl() {
        return {
          valid: true,
          backendDeleteHashes: [],
          replayRequiredNodeIds: [],
          pendingRepairFromFloor: 0,
          legacyGapFallback: false,
          dirtyReason: "history-recovery-replay",
        };
      },
      rollbackAffectedJournals() {},
      normalizeGraphRuntimeState(graph) {
        return graph;
      },
      createEmptyGraph() {
        return {
          historyState: {
            extractionCount: 0,
            lastMutationSource: "",
            lastMutationReason: "",
          },
          vectorIndexState: {
            collectionId: "col-1",
            dirty: false,
            dirtyReason: "",
            pendingRepairFromFloor: null,
            replayRequiredNodeIds: [],
            lastWarning: "",
            lastIntegrityIssue: null,
          },
          batchJournal: [],
          lastProcessedSeq: -1,
        };
      },
      getEmbeddingConfig() {
        return context.embeddingConfig;
      },
      getSettings() {
        return {};
      },
      isBackendVectorConfig(config) {
        return config?.mode === "backend";
      },
      async deleteBackendVectorHashesForRecovery(...args) {
        context.deletedHashesCalls ||= [];
        context.deletedHashesCalls.push(args);
      },
      async prepareVectorStateForReplay(...args) {
        context.prepareVectorStateCalls.push(args);
        if (typeof context.prepareVectorStateForReplayImpl === "function") {
          return await context.prepareVectorStateForReplayImpl(...args);
        }
      },
      applyRecoveryPlanToVectorState() {},
      async replayExtractionFromHistory(...args) {
        if (typeof context.replayExtractionFromHistoryImpl === "function") {
          return await context.replayExtractionFromHistoryImpl(...args);
        }
        return 0;
      },
      updateProcessedHistorySnapshot(chat, lastProcessedAssistantFloor) {
        context.updatedProcessedHistorySnapshot = {
          chatLength: Array.isArray(chat) ? chat.length : 0,
          lastProcessedAssistantFloor,
        };
        context.currentGraph.historyState ||= {};
        context.currentGraph.historyState.lastProcessedAssistantFloor =
          lastProcessedAssistantFloor;
        context.currentGraph.historyState.processedMessageHashes =
          lastProcessedAssistantFloor >= 0
            ? { [lastProcessedAssistantFloor]: `hash-${lastProcessedAssistantFloor}` }
            : {};
      },
      clearHistoryDirty(graph, result) {
        context.clearedHistoryDirty = result;
        graph.historyState ||= {};
        graph.historyState.historyDirtyFrom = null;
        graph.historyState.processedMessageHashes = {};
        graph.historyState.lastRecoveryResult = result;
      },
      buildRecoveryResult(status, extra = {}) {
        return {
          status,
          ...extra,
        };
      },
      saveGraphToChat() {
        context.saveGraphToChatCalls += 1;
      },
      clearInjectionState() {},
      assertRecoveryChatStillActive() {},
      refreshPanelLiveState() {
        context.refreshPanelCalls += 1;
      },
      toastr: {
        success() {},
        warning() {},
        error() {},
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { recoverFromHistoryMutation: recoverHistoryIfNeeded };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function createRerollHarness() {
  return fs.readFile(indexPath, "utf8").then((source) => {
    const rollbackStart = source.indexOf(
      "async function rollbackGraphForReroll(",
    );
    const rollbackEnd = source.indexOf(
      "async function recoverHistoryIfNeeded(",
    );
    const rerollStart = source.indexOf("async function onReroll(");
    const rerollEnd = source.indexOf("async function onManualSleep()");
    if (
      rollbackStart < 0 ||
      rollbackEnd < 0 ||
      rerollStart < 0 ||
      rerollEnd < 0 ||
      rollbackEnd <= rollbackStart ||
      rerollEnd <= rerollStart
    ) {
      throw new Error("无法从 index.js 提取 reroll 定义");
    }
    const snippet = [
      source.slice(rollbackStart, rollbackEnd),
      source.slice(rerollStart, rerollEnd),
    ]
      .join("\n")
      .replace(/^export\s+/gm, "");
    const context = {
      console,
      Date,
      result: null,
      currentGraph: null,
      isExtracting: false,
      extractionCount: 0,
      lastExtractedItems: ["stale-node"],
      lastExtractionStatus: { level: "idle" },
      chat: [],
      embeddingConfig: { mode: "backend" },
      rollbackAffectedJournalsCalls: [],
      deletedHashesCalls: [],
      prepareVectorStateCalls: [],
      recoveryPlans: [],
      saveGraphToChatCalls: 0,
      refreshPanelCalls: 0,
      clearInjectionCalls: 0,
      onManualExtractCalls: 0,
      clearedHistoryDirty: null,
      postRollbackGraph: null,
      manualExtractLevel: "success",
      ensureCurrentGraphRuntimeState() {
        return context.currentGraph;
      },
      getContext() {
        return {
          chat: context.chat,
          chatId: "chat-main",
        };
      },
      getCurrentChatId() {
        return "chat-main";
      },
      getAssistantTurns(chat = []) {
        return chat.flatMap((message, index) =>
          !message?.is_user && !message?.is_system ? [index] : [],
        );
      },
      getLastProcessedAssistantFloor() {
        return Number(
          context.currentGraph?.historyState?.lastProcessedAssistantFloor ?? -1,
        );
      },
      findJournalRecoveryPoint(graph, floor) {
        return context.findJournalRecoveryPointImpl(graph, floor);
      },
      findJournalRecoveryPointImpl() {
        return null;
      },
      buildReverseJournalRecoveryPlan(...args) {
        return context.buildReverseJournalRecoveryPlanImpl(...args);
      },
      buildReverseJournalRecoveryPlanImpl() {
        return {
          backendDeleteHashes: [],
          replayRequiredNodeIds: [],
          pendingRepairFromFloor: null,
          legacyGapFallback: false,
          dirtyReason: "history-recovery-replay",
        };
      },
      rollbackAffectedJournals(graph, journals) {
        context.rollbackAffectedJournalsCalls.push({ graph, journals });
        if (context.postRollbackGraph) {
          context.currentGraph = context.postRollbackGraph;
        }
      },
      normalizeGraphRuntimeState(graph) {
        return graph;
      },
      getEmbeddingConfig() {
        return context.embeddingConfig;
      },
      applyRecoveryPlanToVectorState(plan, floor) {
        context.recoveryPlans.push({ plan, floor });
      },
      isBackendVectorConfig(config) {
        return config?.mode === "backend";
      },
      async deleteBackendVectorHashesForRecovery(...args) {
        context.deletedHashesCalls.push(args);
      },
      updateProcessedHistorySnapshot(chat, lastProcessedAssistantFloor) {
        context.updatedProcessedHistorySnapshot = {
          chatLength: Array.isArray(chat) ? chat.length : 0,
          lastProcessedAssistantFloor,
        };
        context.currentGraph.historyState ||= {};
        context.currentGraph.historyState.lastProcessedAssistantFloor =
          lastProcessedAssistantFloor;
        context.currentGraph.historyState.processedMessageHashes =
          lastProcessedAssistantFloor >= 0
            ? { [lastProcessedAssistantFloor]: `hash-${lastProcessedAssistantFloor}` }
            : {};
        context.currentGraph.lastProcessedSeq = lastProcessedAssistantFloor;
      },
      pruneProcessedMessageHashesFromFloor(graph, fromFloor) {
        return pruneProcessedMessageHashesFromFloor(graph, fromFloor);
      },
      async prepareVectorStateForReplay(...args) {
        context.prepareVectorStateCalls.push(args);
      },
      clearHistoryDirty(graph, result) {
        context.clearedHistoryDirty = result;
        graph.historyState ||= {};
        graph.historyState.historyDirtyFrom = null;
        graph.historyState.processedMessageHashes = {};
        graph.historyState.lastRecoveryResult = result;
      },
      buildRecoveryResult(status, extra = {}) {
        return {
          status,
          ...extra,
        };
      },
      saveGraphToChat() {
        context.saveGraphToChatCalls += 1;
        return true;
      },
      refreshPanelLiveState() {
        context.refreshPanelCalls += 1;
      },
      setRuntimeStatus(text, meta = "", level = "info") {
        context.runtimeStatus = { text, meta, level };
      },
      clearInjectionState() {
        context.clearInjectionCalls += 1;
      },
      async onManualExtract() {
        context.onManualExtractCalls += 1;
        context.lastExtractionStatus = { level: context.manualExtractLevel };
      },
      ensureGraphMutationReady() {
        return true;
      },
      getGraphMutationBlockReason() {
        return "graph-not-ready";
      },
      graphPersistenceState: {
        loadState: "loaded",
      },
      createUiStatus,
      onRerollController,
      isAbortError: (e) => e?.name === "AbortError",
      assertRecoveryChatStillActive() {
        // no-op in test
      },
      toastr: {
        info() {},
        error() {},
        success() {},
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { rollbackGraphForReroll, onReroll };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function pushTestOverrides(patch = {}) {
  const previous = globalThis.__stBmeTestOverrides || {};
  globalThis.__stBmeTestOverrides = {
    ...previous,
    ...patch,
    llm: {
      ...(previous.llm || {}),
      ...(patch.llm || {}),
    },
    embedding: {
      ...(previous.embedding || {}),
      ...(patch.embedding || {}),
    },
  };

  return () => {
    globalThis.__stBmeTestOverrides = previous;
  };
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.tokens = new Set();
  }

  setFromString(value = "") {
    this.tokens = new Set(
      String(value || "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  add(...tokens) {
    for (const token of tokens) {
      if (token) this.tokens.add(token);
    }
    this.owner._syncClassName();
  }

  remove(...tokens) {
    for (const token of tokens) this.tokens.delete(token);
    this.owner._syncClassName();
  }

  contains(token) {
    return this.tokens.has(token);
  }

  toggle(token, force) {
    if (force === true) {
      this.tokens.add(token);
      this.owner._syncClassName();
      return true;
    }
    if (force === false) {
      this.tokens.delete(token);
      this.owner._syncClassName();
      return false;
    }
    if (this.tokens.has(token)) {
      this.tokens.delete(token);
      this.owner._syncClassName();
      return false;
    }
    this.tokens.add(token);
    this.owner._syncClassName();
    return true;
  }

  toString() {
    return [...this.tokens].join(" ");
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.eventListeners = new Map();
    this.classList = new FakeClassList(this);
    this._className = "";
    this.id = "";
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
  }

  _syncClassName() {
    this._className = this.classList.toString();
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || "");
    this.classList.setFromString(this._className);
    this._className = this.classList.toString();
  }

  get parentNode() {
    return this.parentElement;
  }

  setAttribute(name, value) {
    const key = String(name || "");
    const normalized = String(value ?? "");
    this.attributes.set(key, normalized);
    if (key === "id") {
      this.id = normalized;
    } else if (key === "class") {
      this.classList.setFromString(normalized);
      this.className = this.classList.toString();
    } else if (key.startsWith("data-")) {
      const datasetKey = key
        .slice(5)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[datasetKey] = normalized;
    }
    this.ownerDocument?._notifyMutation({
      type: "attributes",
      target: this,
      attributeName: key,
    });
  }

  getAttribute(name) {
    const key = String(name || "");
    if (this.attributes.has(key)) return this.attributes.get(key);
    if (key === "id") return this.id || null;
    if (key === "class") return this.className || null;
    if (key.startsWith("data-")) {
      const datasetKey = key
        .slice(5)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[datasetKey] ?? null;
    }
    return null;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    this.ownerDocument?._notifyMutation({
      type: "childList",
      target: this,
      addedNodes: [child],
    });
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
      this.ownerDocument?._notifyMutation({
        type: "childList",
        target: this,
        removedNodes: [child],
      });
    }
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  addEventListener(type, handler) {
    const key = String(type || "");
    const handlers = this.eventListeners.get(key) || [];
    handlers.push(handler);
    this.eventListeners.set(key, handlers);
  }

  dispatchEvent(event = {}) {
    const key = String(event.type || "");
    const handlers = this.eventListeners.get(key) || [];
    for (const handler of handlers) {
      handler({
        stopPropagation() {},
        preventDefault() {},
        ...event,
        target: this,
        currentTarget: this,
      });
    }
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  get isConnected() {
    return Boolean(this.parentElement) || this === this.ownerDocument?.body;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.ownerDocument?._querySelectorAll(selector, this) || [];
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body", this);
    this._observers = new Set();
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  contains(node) {
    return Boolean(this._flatten(this.body).includes(node));
  }

  getElementById(id) {
    return this._flatten(this.body).find((node) => node.id === id) || null;
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  _flatten(root) {
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const child of node.children) visit(child);
    };
    visit(root);
    return nodes;
  }

  _matchesSimple(node, selector) {
    if (!selector) return false;
    if (selector.startsWith("#")) {
      return node.id === selector.slice(1);
    }
    const attrMatches = [...selector.matchAll(/\[([^=\]]+)="([^\]]*)"\]/g)];
    const attrless = selector.replace(/\[[^\]]+\]/g, "");
    const classMatches = [...attrless.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(
      (m) => m[1],
    );
    const tagMatch = attrless.match(/^[A-Za-z][A-Za-z0-9_-]*/);
    if (tagMatch && node.tagName.toLowerCase() !== tagMatch[0].toLowerCase())
      return false;
    for (const className of classMatches) {
      if (!node.classList.contains(className)) return false;
    }
    for (const [, rawName, expected] of attrMatches) {
      const actual = node.getAttribute(rawName);
      if (String(actual ?? "") !== expected) return false;
    }
    return true;
  }

  _matchesSelectorChain(node, segments) {
    if (!segments.length) return false;
    if (!this._matchesSimple(node, segments[segments.length - 1])) return false;
    let current = node.parentElement;
    for (let index = segments.length - 2; index >= 0; index--) {
      while (current && !this._matchesSimple(current, segments[index])) {
        current = current.parentElement;
      }
      if (!current) return false;
      current = current.parentElement;
    }
    return true;
  }

  _querySelectorAll(selector, scopeRoot) {
    const segments = String(selector || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const nodes = this._flatten(scopeRoot);
    return nodes.filter(
      (node) =>
        node !== scopeRoot && this._matchesSelectorChain(node, segments),
    );
  }

  _registerObserver(observer) {
    this._observers.add(observer);
  }

  _unregisterObserver(observer) {
    this._observers.delete(observer);
  }

  _notifyMutation(record) {
    for (const observer of this._observers) {
      observer._notify(record);
    }
  }
}

class FakeMutationObserver {
  constructor(callback, documentRef) {
    this.callback = callback;
    this.documentRef = documentRef;
    this.active = false;
    this.options = {};
  }

  observe(_target = null, options = {}) {
    this.active = true;
    this.options = { ...options };
    this.documentRef._registerObserver(this);
  }

  disconnect() {
    this.active = false;
    this.documentRef._unregisterObserver(this);
  }

  _notify(record) {
    if (!this.active) return;
    if (record?.type === "attributes" && !this.options?.attributes) return;
    if (record?.type === "childList" && !this.options?.childList) return;
    if (
      record?.type === "attributes" &&
      Array.isArray(this.options?.attributeFilter) &&
      this.options.attributeFilter.length > 0 &&
      !this.options.attributeFilter.includes(String(record.attributeName || ""))
    ) {
      return;
    }
    queueMicrotask(() => {
      if (this.active) this.callback([record]);
    });
  }
}

function createDomHarness(chat) {
  const document = new FakeDocument();
  const chatRoot = document.createElement("div");
  chatRoot.setAttribute("id", "chat");
  document.body.appendChild(chatRoot);
  const observerClass = class extends FakeMutationObserver {
    constructor(callback) {
      super(callback, document);
    }
  };
  return { document, chatRoot, MutationObserver: observerClass, chat };
}

function createMessageElement(
  document,
  messageIndex,
  { stableId = true, withMesBlock = true, isUser = true } = {},
) {
  const mes = document.createElement("div");
  mes.classList.add("mes");
  if (stableId) mes.setAttribute("mesid", String(messageIndex));
  if (isUser) mes.classList.add("user_mes");
  const block = document.createElement("div");
  block.classList.add("mes_block");
  const textWrap = document.createElement("div");
  textWrap.classList.add("mes_text");
  if (withMesBlock) {
    block.appendChild(textWrap);
    mes.appendChild(block);
  } else {
    mes.appendChild(textWrap);
  }
  return mes;
}

function appendLegacyBadge(document, messageElement) {
  const badge = document.createElement("div");
  badge.classList.add("st-bme-recall-badge");
  messageElement.appendChild(badge);
  return badge;
}

async function createRecallUiHarness({
  chat,
  graph = { nodes: [], edges: [] },
} = {}) {
  const harness = createDomHarness(chat);
  const previousDocument = globalThis.document;
  globalThis.document = harness.document;
  const source = await fs.readFile(indexPath, "utf8");
  const start = source.indexOf("function debugWithThrottle(");
  const end = source.indexOf("async function rerunRecallForMessage(");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("无法从 index.js 提取 Recall UI 逻辑");
  }
  const snippet = source.slice(start, end).replace(/^export\s+/gm, "");
  const context = {
    console,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Array,
    Number,
    String,
    Object,
    RegExp,
    parseInt: Number.parseInt,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    document: harness.document,
    currentGraph: graph,
    persistedRecallUiRefreshTimer: null,
    persistedRecallUiRefreshObserver: null,
    persistedRecallUiRefreshSession: 0,
    PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS: [0, 10, 20],
    PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS: 0,
    persistedRecallUiDiagnosticTimestamps: new Map(),
    persistedRecallPersistDiagnosticTimestamps: new Map(),
    getContext: () => ({ chat }),
    getSettings: () => ({ panelTheme: "crimson" }),
    triggerChatMetadataSave: () => "debounced",
    estimateTokens: (text = "") =>
      String(text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length || 1,
    toastr: {
      success() {},
      warning() {},
      info() {},
    },
    openRecallSidebar() {},
    readPersistedRecallFromUserMessage,
    removePersistedRecallFromUserMessage,
    writePersistedRecallToUserMessage,
    buildPersistedRecallRecord,
    markPersistedRecallManualEdit,
    createRecallCardElement: null,
    updateRecallCardData: null,
    globalThis: null,
    result: null,
  };
  context.globalThis = context;
  const recallUiModule = await import("../recall-message-ui.js");
  context.createRecallCardElement = recallUiModule.createRecallCardElement;
  context.updateRecallCardData = recallUiModule.updateRecallCardData;
  context.MutationObserver = harness.MutationObserver;
  vm.createContext(context);
  vm.runInContext(
    `${snippet}\nresult = { refreshPersistedRecallMessageUi, schedulePersistedRecallMessageUiRefresh, cleanupPersistedRecallMessageUi, resolveMessageIndexFromElement, resolveRecallCardAnchor };`,
    context,
    { filename: indexPath },
  );
  return {
    ...harness,
    context,
    api: context.result,
    restoreGlobals() {
      globalThis.document = previousDocument;
    },
  };
}

async function testRecallCardMountsOnStandardUserMessageDom() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    const summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "rendered");
    assert.equal(summary.renderedCount, 1);
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );
    assert.equal(
      harness.chatRoot.querySelectorAll(".mes_block .bme-recall-card").length,
      1,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardSkipsMountWithoutStableMessageIndex() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: false,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    const summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "waiting_dom");
    assert.deepEqual(Array.from(summary.waitingMessageIndices), [0]);
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      0,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardDelayedDomInsertionEventuallyRenders() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  try {
    let updateCalls = 0;
    const originalUpdateRecallCardData = harness.context.updateRecallCardData;
    harness.context.updateRecallCardData = (...args) => {
      updateCalls += 1;
      return originalUpdateRecallCardData(...args);
    };

    harness.api.schedulePersistedRecallMessageUiRefresh();
    await waitForTick();
    const messageElement = createMessageElement(harness.document, 0, {
      stableId: true,
      withMesBlock: true,
      isUser: true,
    });
    harness.chatRoot.appendChild(messageElement);
    await waitForTick();
    await waitForTick();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await waitForTick();

    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );
    assert.equal(
      updateCalls,
      0,
      "observer 先触发后不应再被旧 timeout 重复刷新",
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardDelayedStableMessageIndexEventuallyRenders() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: false,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    harness.api.schedulePersistedRecallMessageUiRefresh();
    await waitForTick();
    messageElement.setAttribute("mesid", "0");
    await waitForTick();
    await waitForTick();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await waitForTick();

    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardSurvivesLateMessageDomReplacement() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  harness.context.PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS = [
    0,
    20,
    40,
    120,
    260,
  ];
  const originalElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(originalElement);

  try {
    harness.api.schedulePersistedRecallMessageUiRefresh();
    await waitForTick();
    await waitForTick();
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );

    originalElement.remove();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const replacementElement = createMessageElement(harness.document, 0, {
      stableId: true,
      withMesBlock: true,
      isUser: true,
    });
    harness.chatRoot.appendChild(replacementElement);

    await waitForTick();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForTick();

    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
      "延迟重渲染后的当前 user 楼层应自动补挂 Recall Card",
    );
    assert.equal(
      replacementElement.querySelectorAll(".bme-recall-card").length,
      1,
      "卡片应重新挂到替换后的消息 DOM 上",
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardKeepsRetryingWhenOlderCardsAlreadyRendered() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
    {
      is_user: true,
      mes: "user-1",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-1",
          selectedNodeIds: ["n2"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const firstMessageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  const secondMessageElement = createMessageElement(harness.document, 1, {
    stableId: false,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(firstMessageElement);
  harness.chatRoot.appendChild(secondMessageElement);

  try {
    harness.api.schedulePersistedRecallMessageUiRefresh();
    await waitForTick();
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );

    secondMessageElement.setAttribute("mesid", "1");
    await waitForTick();
    await waitForTick();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await waitForTick();

    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      2,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardPrefersBetterDuplicateMessageAnchor() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const staleElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: false,
    isUser: true,
  });
  const liveElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  liveElement.classList.add("last_mes");
  harness.chatRoot.appendChild(staleElement);
  harness.chatRoot.appendChild(liveElement);

  try {
    const summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "rendered");
    assert.equal(
      staleElement.querySelectorAll(".bme-recall-card").length,
      0,
      "低质量的重复 DOM 不应抢走当前楼层卡片",
    );
    assert.equal(
      liveElement.querySelectorAll(".bme-recall-card").length,
      1,
      "应优先挂到结构更完整的那条消息 DOM 上",
    );
    assert.equal(
      harness.chatRoot.querySelectorAll(".mes_block .bme-recall-card").length,
      1,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardDoesNotMountOnNonUserFloor() {
  const chat = [
    {
      is_user: false,
      mes: "assistant-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: false,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    const summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "skipped_non_user");
    assert.deepEqual(Array.from(summary.skippedNonUserIndices), [0]);
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      0,
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardRefreshCleansLegacyBadgeAndAvoidsDuplicates() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1", "n2"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  const staleCard = harness.document.createElement("div");
  staleCard.classList.add("bme-recall-card");
  staleCard.dataset.messageIndex = "999";
  staleCard._bmeDestroyRenderer = () => {
    staleCard.dataset.destroyed = "1";
  };
  appendLegacyBadge(harness.document, messageElement);
  messageElement.appendChild(staleCard);
  harness.chatRoot.appendChild(messageElement);

  try {
    harness.api.refreshPersistedRecallMessageUi();
    harness.api.refreshPersistedRecallMessageUi();

    assert.equal(
      harness.chatRoot.querySelectorAll(".st-bme-recall-badge").length,
      0,
    );
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      1,
    );
    assert.equal(staleCard.dataset.destroyed, "1");
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardExpandedContentRerendersAfterRecordUpdate() {
  const chat = [
    {
      is_user: true,
      mes: "user-0",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          recallSource: "before",
          tokenEstimate: 8,
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    let summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "rendered");

    let card = harness.chatRoot.querySelector(".bme-recall-card");
    card.querySelector(".bme-recall-bar")?.click();
    assert.equal(card.classList.contains("expanded"), true);
    const signatureBefore = card.dataset.expandedRenderSignature || "";
    assert.equal(card.querySelector(".bme-recall-meta-tag"), null);

    chat[0].extra.bme_recall = buildPersistedRecallRecord(
      {
        injectionText: "recall-1",
        selectedNodeIds: ["n1", "n2"],
        recallSource: "after",
        tokenEstimate: 13,
        manuallyEdited: true,
        nowIso: "2026-01-01T00:01:00.000Z",
      },
      chat[0].extra.bme_recall,
    );

    summary = harness.api.refreshPersistedRecallMessageUi();
    assert.equal(summary.status, "rendered");

    card = harness.chatRoot.querySelector(".bme-recall-card");
    assert.equal(card.dataset.updatedAt, "2026-01-01T00:01:00.000Z");
    assert.equal(
      card.querySelector(".bme-recall-count-badge")?.textContent,
      "记忆 2",
    );
    assert.equal(
      card.querySelector(".bme-recall-token-hint")?.textContent,
      "~13 tokens",
    );
    const metaElements = card.querySelectorAll(".bme-recall-meta");
    const latestMeta = metaElements[metaElements.length - 1] || null;
    const latestTag =
      card.querySelectorAll(".bme-recall-meta-tag").pop() || null;
    assert.ok(latestMeta?.textContent.includes("来源: after"));
    assert.equal(latestTag?.textContent, "✍ 手动编辑");
    assert.notEqual(card.dataset.expandedRenderSignature, signatureBefore);
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardUserTextRefreshesWithoutCardRecreate() {
  const chat = [
    {
      is_user: true,
      mes: "before-user",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  harness.chatRoot.appendChild(messageElement);

  try {
    harness.api.refreshPersistedRecallMessageUi();
    const firstCard = harness.chatRoot.querySelector(".bme-recall-card");
    assert.equal(
      firstCard.querySelector(".bme-recall-user-text")?.textContent,
      "before-user",
    );

    chat[0].mes = "after-user";
    harness.api.refreshPersistedRecallMessageUi();

    const secondCard = harness.chatRoot.querySelector(".bme-recall-card");
    assert.equal(secondCard, firstCard);
    assert.equal(
      secondCard.querySelector(".bme-recall-user-text")?.textContent,
      "after-user",
    );
  } finally {
    harness.restoreGlobals();
  }
}

async function testRecallCardDisplayModeToggleRestoresOriginalUserText() {
  const chat = [
    {
      is_user: true,
      mes: "line-1\nline-2",
      extra: {
        bme_recall: buildPersistedRecallRecord({
          injectionText: "recall-0",
          selectedNodeIds: ["n1"],
          nowIso: "2026-01-01T00:00:00.000Z",
        }),
      },
    },
  ];
  const harness = await createRecallUiHarness({ chat });
  const messageElement = createMessageElement(harness.document, 0, {
    stableId: true,
    withMesBlock: true,
    isUser: true,
  });
  const userTextElement = messageElement.querySelector(".mes_text");
  userTextElement.textContent = chat[0].mes;
  harness.chatRoot.appendChild(messageElement);

  try {
    harness.context.getSettings = () => ({
      panelTheme: "crimson",
      recallCardUserInputDisplayMode: "beautify_only",
    });
    harness.api.refreshPersistedRecallMessageUi();

    let card = harness.chatRoot.querySelector(".bme-recall-card");
    assert.equal(card?.dataset.userInputDisplayMode, "beautify_only");
    assert.equal(
      userTextElement.classList.contains("bme-hide-original-user-text"),
      true,
    );
    assert.equal(
      card?.querySelector(".bme-recall-user-text")?.textContent,
      "line-1\nline-2",
    );

    harness.context.getSettings = () => ({
      panelTheme: "crimson",
      recallCardUserInputDisplayMode: "mirror",
    });
    harness.api.refreshPersistedRecallMessageUi();

    card = harness.chatRoot.querySelector(".bme-recall-card");
    assert.equal(card?.dataset.userInputDisplayMode, "mirror");
    assert.equal(
      userTextElement.classList.contains("bme-hide-original-user-text"),
      false,
    );

    delete chat[0].extra.bme_recall;
    harness.api.refreshPersistedRecallMessageUi();
    assert.equal(
      userTextElement.classList.contains("bme-hide-original-user-text"),
      false,
    );
    assert.equal(
      harness.chatRoot.querySelectorAll(".bme-recall-card").length,
      0,
    );
  } finally {
    harness.restoreGlobals();
  }
}

function makeEvent(seq, title) {
  return createNode({
    type: "event",
    seq,
    fields: {
      title,
      summary: `${title} 摘要`,
      participants: "Alice",
      status: "active",
    },
  });
}

async function testCompressorMigratesEdgesToCompressedNode() {
  const graph = createEmptyGraph();
  const external = createNode({
    type: "character",
    seq: 0,
    fields: { name: "Alice", state: "awake" },
  });
  const first = makeEvent(1, "事件1");
  const second = makeEvent(2, "事件2");
  addNode(graph, external);
  addNode(graph, first);
  addNode(graph, second);
  addEdge(
    graph,
    createEdge({
      fromId: first.id,
      toId: external.id,
      relation: "mentions",
      strength: 0.7,
    }),
  );

  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          fields: {
            title: "压缩事件",
            summary: "合并摘要",
            participants: "Alice",
            status: "done",
          },
        };
      },
    },
  });

  try {
    const result = await compressType({
      graph,
      typeDef: schema[0],
      embeddingConfig: null,
      force: true,
      settings: {},
    });
    assert.equal(result.created, 1);

    const compressed = graph.nodes.find(
      (node) => node.level === 1 && !node.archived,
    );
    assert.ok(compressed);
    const migrated = graph.edges.find(
      (edge) =>
        edge.fromId === compressed.id &&
        edge.toId === external.id &&
        edge.relation === "mentions" &&
        !edge.invalidAt &&
        !edge.expiredAt,
    );
    assert.ok(migrated);
  } finally {
    restoreOverrides();
  }
}

async function testVectorIndexKeepsDirtyOnDirectPartialEmbeddingFailure() {
  const graph = createEmptyGraph();
  const first = makeEvent(1, "向量事件1");
  const second = makeEvent(2, "向量事件2");
  addNode(graph, first);
  addNode(graph, second);
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.lastWarning = "旧 warning";

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.1, 0.2], null];
      },
    },
  });

  try {
    const result = await syncGraphVectorIndex(
      graph,
      {
        mode: "direct",
        source: "direct",
        apiUrl: "https://example.com/v1",
        model: "text-embedding-3-small",
      },
      {},
    );

    assert.equal(result.insertedHashes.length, 1);
    assert.equal(graph.vectorIndexState.dirty, true);
    assert.equal(typeof result.stats.pending, "number");
    assert.equal(graph.vectorIndexState.lastStats, result.stats);
    assert.match(
      graph.vectorIndexState.lastWarning,
      /部分节点 embedding 生成失败/,
    );
    assert.equal(
      graph.vectorIndexState.lastWarning,
      "部分节点 embedding 生成失败，向量索引仍待修复",
    );
    assert.equal(second.embedding, null);
  } finally {
    restoreOverrides();
  }
}

async function testConsolidatorMergeFallbackKeepsNodeWhenTargetMissing() {
  const graph = createEmptyGraph();
  const target = createNode({
    type: "event",
    seq: 3,
    fields: {
      title: "旧记忆",
      summary: "旧摘要",
      participants: "Alice",
      status: "active",
    },
  });
  const incoming = createNode({
    type: "event",
    seq: 8,
    fields: {
      title: "新记忆",
      summary: "新摘要",
      participants: "Alice",
      status: "updated",
    },
  });
  target.embedding = [0.9, 0.1];
  addNode(graph, target);
  addNode(graph, incoming);

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.2, 0.3]];
      },
      searchSimilar() {
        return [{ nodeId: target.id, score: 0.99 }];
      },
    },
    llm: {
      async callLLMForJSON() {
        return {
          results: [
            {
              node_id: incoming.id,
              action: "merge",
              merge_target_id: "missing-node-id",
              reason: "故意触发无效 merge target 回退",
            },
          ],
        };
      },
    },
  });

  try {
    const stats = await consolidateMemories({
      graph,
      newNodeIds: [incoming.id],
      embeddingConfig: {
        mode: "direct",
        source: "direct",
        apiUrl: "https://example.com/v1",
        model: "text-embedding-3-small",
      },
      settings: {},
    });

    assert.equal(stats.merged, 0);
    assert.equal(stats.kept, 1);
    assert.equal(incoming.archived, false);
    assert.deepEqual(target.embedding, [0.9, 0.1]);
  } finally {
    restoreOverrides();
  }
}

async function testExtractorFailsOnUnknownOperation() {
  const graph = createEmptyGraph();
  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [{ action: "nonsense", foo: 1 }],
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 4, role: "assistant", content: "测试非法操作" }],
      startSeq: 4,
      endSeq: 4,
      schema,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, false);
    assert.match(result.error, /未知操作类型/);
    assert.equal(graph.lastProcessedSeq, -1);
  } finally {
    restoreOverrides();
  }
}

async function testExtractorNormalizesFlatCreateOperation() {
  const graph = createEmptyGraph();
  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              type: "event",
              id: "evt1",
              title: "午夜越界",
              summary: "两人在午夜越界相见，留下了新的冲突线索。",
              participants: "悟悟, 晗",
            },
          ],
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 6, role: "assistant", content: "测试扁平 create" }],
      startSeq: 6,
      endSeq: 6,
      schema,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    assert.equal(result.newNodes, 1);
    assert.equal(graph.lastProcessedSeq, 6);
    const created = graph.nodes.find((node) => !node.archived && node.type === "event");
    assert.ok(created);
    assert.equal(created.fields.title, "午夜越界");
    assert.equal(
      created.fields.summary,
      "两人在午夜越界相见，留下了新的冲突线索。",
    );
    assert.equal(created.fields.participants, "悟悟, 晗");
  } finally {
    restoreOverrides();
  }
}

async function testExtractorNormalizesArrayPayloadAndPreservesScopeField() {
  const graph = createEmptyGraph();
  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return [
          {
            type: "synopsis",
            id: "syn1",
            summary: "最近的整体剧情进入高压对峙阶段。",
            scope: "20-2-2",
          },
        ];
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 8, role: "assistant", content: "测试数组 payload" }],
      startSeq: 8,
      endSeq: 8,
      schema,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    assert.equal(result.newNodes, 1);
    const created = graph.nodes.find(
      (node) => !node.archived && node.type === "synopsis",
    );
    assert.ok(created);
    assert.equal(created.fields.summary, "最近的整体剧情进入高压对峙阶段。");
    assert.equal(created.fields.scope, "20-2-2");
    assert.equal(created.scope?.layer, "objective");
  } finally {
    restoreOverrides();
  }
}

async function testConsolidatorMergeUpdatesSeqRange() {
  const graph = createEmptyGraph();
  const target = createNode({
    type: "event",
    seq: 3,
    seqRange: [3, 4],
    fields: {
      title: "旧记忆",
      summary: "旧摘要",
      participants: "Alice",
      status: "active",
    },
  });
  target.embedding = [0.8, 0.2];
  const incoming = createNode({
    type: "event",
    seq: 8,
    seqRange: [8, 9],
    fields: {
      title: "新记忆",
      summary: "新摘要",
      participants: "Alice",
      status: "updated",
    },
  });
  addNode(graph, target);
  addNode(graph, incoming);

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.4, 0.5]];
      },
      searchSimilar() {
        return [{ nodeId: target.id, score: 0.99 }];
      },
    },
    llm: {
      async callLLMForJSON() {
        return {
          results: [
            {
              node_id: incoming.id,
              action: "merge",
              merge_target_id: target.id,
              merged_fields: { summary: "合并后摘要" },
            },
          ],
        };
      },
    },
  });

  try {
    const stats = await consolidateMemories({
      graph,
      newNodeIds: [incoming.id],
      embeddingConfig: {
        mode: "direct",
        source: "direct",
        apiUrl: "https://example.com/v1",
        model: "text-embedding-3-small",
      },
      settings: {},
    });

    assert.equal(stats.merged, 1);
    assert.deepEqual(target.seqRange, [3, 9]);
    assert.equal(target.seq, 8);
    assert.equal(target.fields.summary, "合并后摘要");
    assert.equal(target.embedding, null);
    assert.equal(incoming.archived, true);
  } finally {
    restoreOverrides();
  }
}

async function testBatchJournalVectorDeltaCapturesRecoveryFields() {
  const before = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const after = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const beforeNode = createNode({
    type: "event",
    seq: 1,
    fields: { title: "旧", summary: "旧", participants: "A", status: "old" },
  });
  beforeNode.id = "node-before";
  const afterNode = createNode({
    type: "event",
    seq: 1,
    fields: { title: "新", summary: "新", participants: "A", status: "new" },
  });
  afterNode.id = "node-before";
  addNode(before, beforeNode);
  addNode(after, afterNode);
  before.vectorIndexState.hashToNodeId = { hash_old: "node-before" };
  before.vectorIndexState.nodeToHash = { "node-before": "hash_old" };
  after.vectorIndexState.hashToNodeId = {
    hash_new: "node-before",
    hash_inserted: "node-extra",
  };
  after.vectorIndexState.nodeToHash = {
    "node-before": "hash_new",
    "node-extra": "hash_inserted",
  };
  after.vectorIndexState.replayRequiredNodeIds = ["node-before", "node-extra"];

  const journal = createBatchJournalEntry(before, after, {
    processedRange: [4, 6],
    vectorHashesInserted: ["hash_inserted"],
  });

  assert.deepEqual(journal.vectorDelta.insertedHashes.sort(), [
    "hash_inserted",
    "hash_new",
  ]);
  assert.deepEqual(journal.vectorDelta.removedHashes, ["hash_old"]);
  assert.deepEqual(journal.vectorDelta.touchedNodeIds.sort(), [
    "node-before",
    "node-extra",
  ]);
  assert.deepEqual(journal.vectorDelta.replayRequiredNodeIds.sort(), [
    "node-before",
    "node-extra",
  ]);
  assert.deepEqual(journal.vectorDelta.backendDeleteHashes, ["hash_old"]);
  assert.deepEqual(journal.vectorDelta.replacedMappings, [
    { nodeId: "node-before", previousHash: "hash_old", nextHash: "hash_new" },
    { nodeId: "node-extra", previousHash: "", nextHash: "hash_inserted" },
  ]);
}

async function testReverseJournalRecoveryPlanLegacyFallback() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [5, 7],
        vectorDelta: {
          insertedHashes: ["hash_1"],
        },
      },
    ],
    5,
  );

  assert.equal(recoveryPlan.legacyGapFallback, true);
  assert.equal(recoveryPlan.dirtyReason, "legacy-gap");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 5);
  assert.equal(recoveryPlan.valid, true);
  assert.equal(recoveryPlan.invalidReason, "");
  assert.deepEqual(recoveryPlan.backendDeleteHashes, ["hash_1"]);
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds, []);
}

async function testReverseJournalRecoveryPlanAggregatesDeletesAndReplay() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [8, 9],
        vectorDelta: {
          insertedHashes: ["hash_new"],
          removedHashes: ["hash_removed"],
          replacedMappings: [
            {
              nodeId: "node-1",
              previousHash: "hash_old",
              nextHash: "hash_new",
            },
          ],
          touchedNodeIds: ["node-1"],
          replayRequiredNodeIds: ["node-2"],
          backendDeleteHashes: ["hash_backend"],
        },
      },
      {
        processedRange: [4, 6],
        vectorDelta: {
          insertedHashes: ["hash_other"],
          removedHashes: [],
          replacedMappings: [],
          touchedNodeIds: ["node-3"],
          replayRequiredNodeIds: ["node-3"],
          backendDeleteHashes: [],
        },
      },
    ],
    6,
  );

  assert.equal(recoveryPlan.legacyGapFallback, false);
  assert.equal(recoveryPlan.dirtyReason, "history-recovery-replay");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 4);
  assert.equal(recoveryPlan.valid, true);
  assert.equal(recoveryPlan.invalidReason, "");
  assert.deepEqual(recoveryPlan.backendDeleteHashes.sort(), [
    "hash_backend",
    "hash_new",
    "hash_old",
    "hash_other",
    "hash_removed",
  ]);
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds.sort(), [
    "node-1",
    "node-2",
    "node-3",
  ]);
  assert.deepEqual(recoveryPlan.touchedNodeIds.sort(), ["node-1", "node-3"]);
}

async function testReverseJournalRollbackStateFormsReplayClosure() {
  const before = normalizeGraphRuntimeState(createEmptyGraph(), "chat-replay");
  const after = normalizeGraphRuntimeState(createEmptyGraph(), "chat-replay");
  const stableNode = createNode({
    type: "event",
    seq: 1,
    fields: {
      title: "稳定节点",
      summary: "稳定摘要",
      participants: "Alice",
      status: "stable",
    },
  });
  stableNode.id = "node-stable";
  const touchedBefore = createNode({
    type: "event",
    seq: 2,
    fields: {
      title: "回滚前节点",
      summary: "旧摘要",
      participants: "Bob",
      status: "old",
    },
  });
  touchedBefore.id = "node-touched";
  const touchedAfter = createNode({
    type: "event",
    seq: 5,
    fields: {
      title: "回滚后节点",
      summary: "新摘要",
      participants: "Bob",
      status: "updated",
    },
  });
  touchedAfter.id = "node-touched";
  const appendedNode = createNode({
    type: "event",
    seq: 6,
    fields: {
      title: "新增节点",
      summary: "新增摘要",
      participants: "Cara",
      status: "new",
    },
  });
  appendedNode.id = "node-appended";
  addNode(before, stableNode);
  addNode(before, touchedBefore);
  addNode(after, stableNode);
  addNode(after, touchedAfter);
  addNode(after, appendedNode);

  before.historyState.lastProcessedAssistantFloor = 3;
  before.historyState.processedMessageHashes = {
    0: "h0",
    1: "h1",
    2: "h2",
    3: "h3",
  };
  before.historyState.extractionCount = 1;
  before.vectorIndexState.hashToNodeId = {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  };
  before.vectorIndexState.nodeToHash = {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  };

  after.historyState.lastProcessedAssistantFloor = 6;
  after.historyState.processedMessageHashes = {
    0: "h0",
    1: "h1",
    2: "h2",
    3: "h3",
    4: "h4",
    5: "h5",
    6: "h6",
  };
  after.historyState.extractionCount = 2;
  after.vectorIndexState.hashToNodeId = {
    hash_stable: stableNode.id,
    hash_new: touchedAfter.id,
    hash_added: appendedNode.id,
  };
  after.vectorIndexState.nodeToHash = {
    [stableNode.id]: "hash_stable",
    [touchedAfter.id]: "hash_new",
    [appendedNode.id]: "hash_added",
  };
  after.vectorIndexState.replayRequiredNodeIds = [appendedNode.id];

  const journal = createBatchJournalEntry(before, after, {
    processedRange: [4, 6],
    extractionCountBefore: before.historyState.extractionCount,
  });

  const runtimeGraph = normalizeGraphRuntimeState(
    JSON.parse(JSON.stringify(after)),
    "chat-replay",
  );
  rollbackBatch(runtimeGraph, journal);

  assert.deepEqual(runtimeGraph.nodes.map((node) => node.id).sort(), [
    stableNode.id,
    touchedBefore.id,
  ]);
  assert.deepEqual(runtimeGraph.vectorIndexState.hashToNodeId, {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  });
  assert.deepEqual(runtimeGraph.vectorIndexState.nodeToHash, {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  });
  assert.equal(runtimeGraph.historyState.lastProcessedAssistantFloor, 3);

  const recoveryPlan = buildReverseJournalRecoveryPlan([journal], 4);
  runtimeGraph.vectorIndexState.replayRequiredNodeIds = [stableNode.id];
  runtimeGraph.vectorIndexState.dirty = false;
  runtimeGraph.vectorIndexState.dirtyReason = "";
  runtimeGraph.vectorIndexState.pendingRepairFromFloor = null;

  const replayRequiredNodeIds = new Set(
    runtimeGraph.vectorIndexState.replayRequiredNodeIds,
  );
  for (const nodeId of recoveryPlan.replayRequiredNodeIds) {
    replayRequiredNodeIds.add(nodeId);
  }
  runtimeGraph.vectorIndexState.replayRequiredNodeIds = [
    ...replayRequiredNodeIds,
  ];
  runtimeGraph.vectorIndexState.dirty = true;
  runtimeGraph.vectorIndexState.dirtyReason =
    recoveryPlan.dirtyReason ||
    runtimeGraph.vectorIndexState.dirtyReason ||
    "history-recovery-replay";
  runtimeGraph.vectorIndexState.pendingRepairFromFloor =
    recoveryPlan.pendingRepairFromFloor;
  runtimeGraph.vectorIndexState.lastWarning = recoveryPlan.legacyGapFallback
    ? "历史恢复检测到 legacy-gap，向量索引需按受影响后缀修复"
    : "历史恢复后需要修复受影响后缀的向量索引";

  assert.deepEqual(
    runtimeGraph.vectorIndexState.replayRequiredNodeIds.sort(),
    [appendedNode.id, stableNode.id, touchedBefore.id].sort(),
  );
  assert.equal(runtimeGraph.vectorIndexState.pendingRepairFromFloor, 4);
  assert.equal(
    runtimeGraph.vectorIndexState.dirtyReason,
    "history-recovery-replay",
  );
  assert.equal(
    runtimeGraph.vectorIndexState.lastWarning,
    "历史恢复后需要修复受影响后缀的向量索引",
  );
  assert.deepEqual(runtimeGraph.vectorIndexState.hashToNodeId, {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  });
  assert.deepEqual(runtimeGraph.vectorIndexState.nodeToHash, {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  });
}

async function testReverseJournalRecoveryPlanMixedLegacyAndCurrentRetainsRepairSet() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [10, 12],
        vectorDelta: {
          insertedHashes: ["hash-current"],
          removedHashes: ["hash-removed"],
          replacedMappings: [
            {
              nodeId: "node-current",
              previousHash: "hash-prev",
              nextHash: "hash-current",
            },
          ],
          touchedNodeIds: ["node-current"],
          replayRequiredNodeIds: ["node-extra"],
          backendDeleteHashes: ["hash-backend"],
        },
      },
      {
        processedRange: [7, 9],
        vectorDelta: {
          insertedHashes: ["hash-legacy"],
        },
      },
    ],
    9,
  );

  assert.equal(recoveryPlan.legacyGapFallback, true);
  assert.equal(recoveryPlan.dirtyReason, "legacy-gap");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 7);
  assert.equal(recoveryPlan.valid, true);
  assert.equal(recoveryPlan.invalidReason, "");
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds.sort(), [
    "node-current",
    "node-extra",
  ]);
  assert.deepEqual(recoveryPlan.touchedNodeIds, ["node-current"]);
  assert.deepEqual(recoveryPlan.backendDeleteHashes.sort(), [
    "hash-backend",
    "hash-current",
    "hash-legacy",
    "hash-prev",
    "hash-removed",
  ]);
}

async function testBatchStatusStructuralPartialRemainsRecoverable() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.inspectAutoCompressionCandidates = () => ({
    hasCandidates: true,
    reason: "",
  });
  harness.compressAll = async () => {
    throw new Error("compression down");
  };
  harness.syncVectorState = async () => ({
    insertedHashes: ["hash-ok"],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [2, 4],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-1"] },
    4,
    {
      enableConsolidation: false,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      compressionEveryN: 1,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.structural.outcome, "partial");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "success");
  assert.equal(effects.batchStatus.outcome, "partial");
  assert.equal(effects.batchStatus.completed, true);
  assert.equal(effects.batchStatus.consistency, "weak");
  assert.match(effects.batchStatus.warnings[0], /压缩阶段失败/);
}

async function testBatchStatusSemanticFailureDoesNotHideCoreSuccess() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.generateSynopsis = async () => {
    throw new Error("semantic down");
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [5, 5],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-2"] },
    5,
    {
      enableConsolidation: false,
      enableSynopsis: true,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.semantic.outcome, "failed");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "success");
  assert.equal(effects.batchStatus.outcome, "failed");
  assert.equal(effects.batchStatus.completed, true);
  assert.match(effects.batchStatus.errors[0], /概要生成失败/);
}

async function testAutoConsolidationRunsOnHighDuplicateRiskSingleNode() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  let gateCalls = 0;
  let consolidateCalls = 0;
  harness.analyzeAutoConsolidationGate = async () => {
    gateCalls += 1;
    return {
      triggered: true,
      reason:
        "本批仅新增 1 个节点，但与旧记忆高度相似（0.930 >= 0.85），已触发自动整合",
      matchedScore: 0.93,
      matchedNodeId: "old-1",
    };
  };
  harness.consolidateMemories = async () => {
    consolidateCalls += 1;
    return {
      merged: 1,
      skipped: 0,
      kept: 0,
      evolved: 0,
      connections: 0,
      updates: 0,
    };
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [6, 6],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-dup"] },
    6,
    {
      enableConsolidation: true,
      consolidationAutoMinNewNodes: 2,
      consolidationThreshold: 0.85,
      enableAutoCompression: false,
      compressionEveryN: 10,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(gateCalls, 1);
  assert.equal(consolidateCalls, 1);
  assert.equal(effects.batchStatus.consolidationGateTriggered, true);
  assert.equal(
    effects.batchStatus.consolidationGateMatchedNodeId,
    "old-1",
  );
  assert.equal(effects.batchStatus.consolidationGateSimilarity, 0.93);
  assert.match(
    effects.batchStatus.consolidationGateReason,
    /高度相似/,
  );
  assert.equal(effects.batchStatus.autoCompressionScheduled, false);
  assert.match(
    effects.batchStatus.autoCompressionSkippedReason,
    /自动压缩.*已关闭/,
  );
}

async function testAutoConsolidationSkipsLowRiskSingleNode() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  let consolidateCalls = 0;
  harness.analyzeAutoConsolidationGate = async () => ({
    triggered: false,
    reason:
      "本批新增少且最高相似度 0.420 未达到阈值 0.85，跳过自动整合",
    matchedScore: 0.42,
    matchedNodeId: "old-2",
  });
  harness.consolidateMemories = async () => {
    consolidateCalls += 1;
    return {
      merged: 0,
      skipped: 0,
      kept: 1,
      evolved: 0,
      connections: 0,
      updates: 0,
    };
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [7, 7],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-low-risk"] },
    7,
    {
      enableConsolidation: true,
      consolidationAutoMinNewNodes: 2,
      consolidationThreshold: 0.85,
      enableAutoCompression: false,
      compressionEveryN: 10,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(consolidateCalls, 0);
  assert.equal(effects.batchStatus.consolidationGateTriggered, false);
  assert.equal(
    effects.batchStatus.consolidationGateMatchedNodeId,
    "old-2",
  );
  assert.equal(effects.batchStatus.consolidationGateSimilarity, 0.42);
  assert.match(
    effects.batchStatus.consolidationGateReason,
    /跳过自动整合/,
  );
  assert.equal(
    effects.batchStatus.stages.structural.artifacts.includes(
      "consolidation-skipped",
    ),
    true,
  );
}

async function testAutoCompressionRunsOnlyOnConfiguredInterval() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 9 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.extractionCount = 9;
  let compressionCalls = 0;
  harness.inspectAutoCompressionCandidates = () => ({
    hasCandidates: true,
    reason: "",
  });
  harness.compressAll = async () => {
    compressionCalls += 1;
    return { created: 1, archived: 2 };
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [8, 8],
    extractionCountBefore: 9,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-for-compress"] },
    8,
    {
      enableConsolidation: false,
      enableAutoCompression: true,
      compressionEveryN: 10,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(compressionCalls, 1);
  assert.equal(effects.batchStatus.autoCompressionScheduled, true);
  assert.equal(effects.batchStatus.nextCompressionAtExtractionCount, 20);
  assert.equal(effects.batchStatus.autoCompressionSkippedReason, "");
}

async function testAutoCompressionSkipsWhenNotScheduledOrNoCandidates() {
  const offCycleHarness = await createBatchStageHarness();
  const {
    createBatchStatusSkeleton: createOffCycleBatchStatus,
    handleExtractionSuccess: handleOffCycleExtractionSuccess,
  } = offCycleHarness.result;
  offCycleHarness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  offCycleHarness.ensureCurrentGraphRuntimeState = () => {
    offCycleHarness.currentGraph.historyState ||= {};
    offCycleHarness.currentGraph.vectorIndexState ||= {};
  };
  let offCycleCompressionCalls = 0;
  offCycleHarness.compressAll = async () => {
    offCycleCompressionCalls += 1;
    return { created: 1, archived: 1 };
  };
  offCycleHarness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const offCycleStatus = createOffCycleBatchStatus({
    processedRange: [9, 9],
    extractionCountBefore: 0,
  });
  const offCycleEffects = await handleOffCycleExtractionSuccess(
    { newNodeIds: ["node-off-cycle"] },
    9,
    {
      enableConsolidation: false,
      enableAutoCompression: true,
      compressionEveryN: 10,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    offCycleStatus,
  );

  assert.equal(offCycleCompressionCalls, 0);
  assert.equal(offCycleEffects.batchStatus.autoCompressionScheduled, false);
  assert.match(
    offCycleEffects.batchStatus.autoCompressionSkippedReason,
    /未到每 10 次自动压缩周期/,
  );
  assert.equal(offCycleEffects.batchStatus.nextCompressionAtExtractionCount, 10);

  const scheduledHarness = await createBatchStageHarness();
  const {
    createBatchStatusSkeleton: createScheduledBatchStatus,
    handleExtractionSuccess: handleScheduledExtractionSuccess,
  } = scheduledHarness.result;
  scheduledHarness.currentGraph = {
    historyState: { extractionCount: 9 },
    vectorIndexState: {},
  };
  scheduledHarness.ensureCurrentGraphRuntimeState = () => {
    scheduledHarness.currentGraph.historyState ||= {};
    scheduledHarness.currentGraph.vectorIndexState ||= {};
  };
  scheduledHarness.extractionCount = 9;
  let scheduledCompressionCalls = 0;
  scheduledHarness.inspectAutoCompressionCandidates = () => ({
    hasCandidates: false,
    reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
  });
  scheduledHarness.compressAll = async () => {
    scheduledCompressionCalls += 1;
    return { created: 1, archived: 1 };
  };
  scheduledHarness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const scheduledStatus = createScheduledBatchStatus({
    processedRange: [10, 10],
    extractionCountBefore: 9,
  });
  const scheduledEffects = await handleScheduledExtractionSuccess(
    { newNodeIds: ["node-scheduled"] },
    10,
    {
      enableConsolidation: false,
      enableAutoCompression: true,
      compressionEveryN: 10,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    scheduledStatus,
  );

  assert.equal(scheduledCompressionCalls, 0);
  assert.equal(scheduledEffects.batchStatus.autoCompressionScheduled, true);
  assert.match(
    scheduledEffects.batchStatus.autoCompressionSkippedReason,
    /没有达到内部压缩阈值的候选组/,
  );
  assert.equal(
    scheduledEffects.batchStatus.stages.structural.artifacts.includes(
      "compression-skipped",
    ),
    true,
  );
}

async function testBatchStatusFinalizeFailureIsNotCompleteSuccess() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 1 },
    error: "vector finalize down",
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [6, 7],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-3"] },
    7,
    {
      enableConsolidation: false,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "failed");
  assert.equal(effects.batchStatus.outcome, "failed");
  assert.equal(effects.batchStatus.completed, false);
  assert.equal(effects.batchStatus.consistency, "weak");
  assert.equal(effects.vectorError, "vector finalize down");
}

async function testProcessedHistoryAdvanceTracksCoreExtractionSuccess() {
  const harness = await createBatchStageHarness();
  const {
    createBatchStatusSkeleton,
    finalizeBatchStatus,
    setBatchStageOutcome,
    shouldAdvanceProcessedHistory,
  } = harness.result;

  const structuralPartial = createBatchStatusSkeleton({
    processedRange: [2, 4],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(structuralPartial, "core", "success");
  setBatchStageOutcome(
    structuralPartial,
    "structural",
    "partial",
    "compression down",
  );
  setBatchStageOutcome(structuralPartial, "finalize", "success");
  finalizeBatchStatus(structuralPartial);
  assert.equal(structuralPartial.completed, true);
  assert.equal(structuralPartial.outcome, "partial");
  assert.equal(structuralPartial.consistency, "weak");
  assert.equal(shouldAdvanceProcessedHistory(structuralPartial), true);

  const semanticFailed = createBatchStatusSkeleton({
    processedRange: [5, 5],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(semanticFailed, "core", "success");
  setBatchStageOutcome(semanticFailed, "semantic", "failed", "semantic down");
  setBatchStageOutcome(semanticFailed, "finalize", "success");
  finalizeBatchStatus(semanticFailed);
  assert.equal(semanticFailed.completed, true);
  assert.equal(semanticFailed.outcome, "failed");
  assert.equal(semanticFailed.consistency, "strong");
  assert.equal(shouldAdvanceProcessedHistory(semanticFailed), true);

  const finalizeFailed = createBatchStatusSkeleton({
    processedRange: [6, 7],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(finalizeFailed, "core", "success");
  setBatchStageOutcome(
    finalizeFailed,
    "finalize",
    "failed",
    "vector finalize down",
  );
  finalizeBatchStatus(finalizeFailed);
  assert.equal(finalizeFailed.completed, false);
  assert.equal(finalizeFailed.outcome, "failed");
  assert.equal(shouldAdvanceProcessedHistory(finalizeFailed), true);

  const fullSuccess = createBatchStatusSkeleton({
    processedRange: [8, 9],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(fullSuccess, "core", "success");
  setBatchStageOutcome(fullSuccess, "structural", "success");
  setBatchStageOutcome(fullSuccess, "semantic", "success");
  setBatchStageOutcome(fullSuccess, "finalize", "success");
  finalizeBatchStatus(fullSuccess);
  assert.equal(fullSuccess.completed, true);
  assert.equal(fullSuccess.outcome, "success");
  assert.equal(fullSuccess.consistency, "strong");
  assert.equal(shouldAdvanceProcessedHistory(fullSuccess), true);
}

async function testGenerationRecallTransactionDedupesDoubleHookBySameKey() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一轮输入" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].hookName, "GENERATION_AFTER_COMMANDS");
}

async function testGenerationRecallTransactionDedupesReverseHookOrder() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "逆序同轮输入" }];

  await harness.result.onBeforeCombinePrompts();
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
}

async function testGenerationRecallHistoryModesUseSameBindingAcrossHooks() {
  for (const generationType of ["continue", "regenerate", "swipe"]) {
    const harness = await createGenerationRecallHarness();
    const userMessage = `历史输入-${generationType}`;
    harness.chat = [
      { is_user: true, mes: userMessage },
      { is_user: false, mes: "assistant-tail" },
    ];

    await harness.result.onGenerationAfterCommands(generationType, {}, false);
    await harness.result.onBeforeCombinePrompts();

    assert.equal(
      harness.runRecallCalls.length,
      1,
      `${generationType} 应只执行一次召回`,
    );
    assert.equal(
      harness.runRecallCalls[0].hookName,
      "GENERATION_AFTER_COMMANDS",
    );
    assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, 0);
    assert.equal(harness.runRecallCalls[0].overrideUserMessage, userMessage);
  }
}

async function testGenerationRecallFrozenBindingSurvivesCrossHookInputDrift() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "稳定输入-A" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  harness.chat = [{ is_user: true, mes: "稳定输入-B" }];
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "稳定输入-A");
}

async function testGenerationRecallSkipsUntilTargetUserFloorAvailable() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-only" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  assert.equal(harness.runRecallCalls.length, 0);

  harness.chat = [{ is_user: true, mes: "补齐 user 楼层" }];
  await harness.result.onBeforeCombinePrompts();
  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
}

async function testGenerationRecallBeforeCombineCanUseProvisionalSendIntentBinding() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.__sendTextareaValue = "发送前输入";
  harness.pendingRecallSendIntent = {
    text: "发送前输入",
    hash: "hash-send-intent",
    at: Date.now(),
  };
  harness.result.pendingRecallSendIntent = harness.pendingRecallSendIntent;

  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "发送前输入");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].overrideSourceLabel, "发送意图");
  assert.equal(
    harness.runRecallCalls[0].overrideReason,
    "send-intent-captured",
  );
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, null);
}

async function testGenerationRecallHostLifecycleSnapshotSurvivesTextareaClearWithoutDomIntent() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.__sendTextareaValue = "宿主冻结输入";

  const frozenSnapshot = harness.result.freezeHostGenerationInputSnapshot(
    harness.__sendTextareaValue,
  );
  harness.__sendTextareaValue = "";

  await harness.result.onGenerationAfterCommands(
    "normal",
    { frozenInputSnapshot: frozenSnapshot },
    false,
  );
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "宿主冻结输入");
  assert.equal(
    harness.runRecallCalls[0].overrideSource,
    "host-generation-lifecycle",
  );
  assert.equal(harness.runRecallCalls[0].overrideSourceLabel, "宿主发送快照");
  assert.equal(
    harness.runRecallCalls[0].overrideReason,
    "host-snapshot-captured",
  );
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, null);
  assert.deepEqual(harness.result.getPendingHostGenerationInputSnapshot(), {
    text: "",
    hash: "",
    at: 0,
    source: "",
    messageId: null,
  });
}

async function testGenerationRecallAfterCommandsStillSkipsWithoutStableUserFloor() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.__sendTextareaValue = "发送前输入";
  harness.pendingRecallSendIntent = {
    text: "发送前输入",
    hash: "hash-send-intent",
    at: Date.now(),
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(
    harness.runRecallCalls.length,
    0,
    "after-commands 在缺失稳定 user floor 时应继续跳过，避免错误楼层绑定",
  );
}

async function testGenerationRecallSameKeyCanRunAgainImmediatelyAsNewGeneration() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同 key 连续生成" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 2);
  assert.equal(
    harness.runRecallCalls[0].recallKey,
    harness.runRecallCalls[1].recallKey,
  );
}

async function testGenerationRecallSameKeyCanRunAgainAfterBridgeWindow() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同 key 重复生成" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  const transaction = [
    ...harness.result.generationRecallTransactions.values(),
  ][0];
  transaction.updatedAt = Date.now() - 5000;
  harness.result.generationRecallTransactions.set(transaction.id, transaction);
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 2);
}

async function testGenerationRecallBeforeCombineRunsStandalone() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "仅 before combine" }];

  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
}

async function testGenerationRecallDryRunPreviewDoesNotTriggerBeforeCombineRecall() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "Prompt Viewer 预览" }];

  harness.result.onGenerationStarted("normal", {}, true);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 0);
}

async function testGenerationRecallDifferentKeyCanRunAgain() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "第一条" }];
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  harness.chat = [{ is_user: true, mes: "第二条" }];
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 2);
  assert.notEqual(
    harness.runRecallCalls[0].recallKey,
    harness.runRecallCalls[1].recallKey,
  );
}

async function testGenerationRecallSkippedStateDoesNotLoopToBeforeCombine() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一条但本次跳过" }];
  harness.runRecall = async (options = {}) => {
    harness.runRecallCalls.push({ ...options });
    return {
      status: "skipped",
      didRecall: false,
      ok: false,
      reason: "测试跳过",
    };
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.result.generationRecallTransactions.size, 1);
  const transaction = [
    ...harness.result.generationRecallTransactions.values(),
  ][0];
  assert.equal(transaction.hookStates.GENERATION_AFTER_COMMANDS, "skipped");
}

async function testGenerationRecallSentMessageClearsStaleTransactionForSameKey() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同 key 发送后重开" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.result.generationRecallTransactions.size, 1);

  harness.recordRecallSentUserMessage(0, "同 key 发送后重开");
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 2);
}

async function testRegisterCoreEventHooksIsIdempotent() {
  const eventRegistrations = [];
  const makeFirstRegistrations = [];
  const bindingState = { registered: false, cleanups: [], registeredAt: 0 };
  const eventSource = {
    on(eventName, listener) {
      eventRegistrations.push({ eventName, listener });
    },
    off() {},
  };
  const runtime = {
    console: { warn() {} },
    eventSource,
    eventTypes: {
      CHAT_CHANGED: "chat-changed",
      CHAT_LOADED: "chat-loaded",
      MESSAGE_SENT: "message-sent",
      GENERATION_STARTED: "generation-started",
      GENERATION_ENDED: "generation-ended",
      MESSAGE_RECEIVED: "message-received",
      MESSAGE_DELETED: "message-deleted",
      MESSAGE_EDITED: "message-edited",
      MESSAGE_SWIPED: "message-swiped",
      MESSAGE_UPDATED: "message-updated",
      USER_MESSAGE_RENDERED: "user-message-rendered",
      CHARACTER_MESSAGE_RENDERED: "character-message-rendered",
    },
    handlers: {
      onChatChanged() {},
      onChatLoaded() {},
      onMessageSent() {},
      onGenerationStarted() {},
      onGenerationEnded() {},
      onGenerationAfterCommands() {},
      onBeforeCombinePrompts() {},
      onMessageReceived() {},
      onMessageDeleted() {},
      onMessageEdited() {},
      onMessageSwiped() {},
      onUserMessageRendered() {},
      onCharacterMessageRendered() {},
    },
    registerGenerationAfterCommands(listener) {
      makeFirstRegistrations.push({ hook: "after", listener });
      return () => {};
    },
    registerBeforeCombinePrompts(listener) {
      makeFirstRegistrations.push({ hook: "before", listener });
      return () => {};
    },
    getCoreEventBindingState: () => bindingState,
    setCoreEventBindingState(nextState) {
      bindingState.registered = Boolean(nextState?.registered);
      bindingState.cleanups = Array.isArray(nextState?.cleanups)
        ? nextState.cleanups
        : [];
      bindingState.registeredAt = Number(nextState?.registeredAt) || 0;
      return bindingState;
    },
  };

  registerCoreEventHooksController(runtime);
  registerCoreEventHooksController(runtime);

  assert.equal(eventRegistrations.length, 12);
  assert.equal(makeFirstRegistrations.length, 2);
  assert.equal(bindingState.registered, true);
}

async function testChatChangedDoesNotClearCoreEventBindings() {
  let clearCoreBindingsCalls = 0;
  let clearPendingAutoExtractionCalls = 0;

  onChatChangedController({
    clearCoreEventBindingState() {
      clearCoreBindingsCalls += 1;
    },
    clearPendingHistoryMutationChecks() {},
    clearTimeout() {},
    getPendingHistoryRecoveryTimer: () => null,
    setPendingHistoryRecoveryTimer() {},
    setPendingHistoryRecoveryTrigger() {},
    clearPendingAutoExtraction() {
      clearPendingAutoExtractionCalls += 1;
    },
    clearPendingGraphLoadRetry() {},
    setSkipBeforeCombineRecallUntil() {},
    setLastPreGenerationRecallKey() {},
    setLastPreGenerationRecallAt() {},
    clearGenerationRecallTransactionsForChat() {},
    abortAllRunningStages() {},
    dismissAllStageNotices() {},
    syncGraphLoadFromLiveContext() {},
    clearInjectionState() {},
    clearRecallInputTracking() {},
    installSendIntentHooks() {},
    refreshPersistedRecallMessageUi() {},
  });

  assert.equal(
    clearCoreBindingsCalls,
    0,
    "聊天切换不应清空核心事件监听，否则后续自动链会失联",
  );
  assert.equal(clearPendingAutoExtractionCalls, 1);
}

async function testSwipeRoutesToRerollWithoutHistoryRecoveryFallback() {
  const invalidationReasons = [];
  const rerollCalls = [];
  let historyRecheckCalls = 0;
  let refreshCalls = 0;

  const result = await onMessageSwipedController(
    {
      invalidateRecallAfterHistoryMutation(reason) {
        invalidationReasons.push(reason);
      },
      async onReroll(payload) {
        rerollCalls.push(payload);
        return {
          success: true,
          rollbackPerformed: true,
          extractionTriggered: true,
          requestedFloor: payload.fromFloor,
          effectiveFromFloor: payload.fromFloor,
          recoveryPath: "reverse-journal",
          affectedBatchCount: 1,
          error: "",
        };
      },
      scheduleHistoryMutationRecheck() {
        historyRecheckCalls += 1;
      },
      refreshPersistedRecallMessageUi() {
        refreshCalls += 1;
      },
      console: {
        warn() {},
        error() {},
      },
    },
    16,
    { reason: "host-swipe" },
  );

  assert.equal(invalidationReasons.length, 1);
  assert.deepEqual(rerollCalls, [{ fromFloor: 16, meta: { reason: "host-swipe" } }]);
  assert.equal(historyRecheckCalls, 0);
  assert.equal(refreshCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.recoveryPath, "reverse-journal");
}

async function testMessageSentFallsBackToLatestUserWhenHostMessageIdInvalid() {
  const recorded = [];
  let refreshCalls = 0;

  onMessageSentController(
    {
      getContext: () => ({
        chat: [
          { is_user: true, mes: "较早用户楼层" },
          { is_user: false, mes: "assistant-tail" },
          { is_user: true, mes: "最新用户楼层" },
        ],
      }),
      recordRecallSentUserMessage(messageId, text, source = "message-sent") {
        recorded.push({ messageId, text, source });
      },
      refreshPersistedRecallMessageUi() {
        refreshCalls += 1;
      },
    },
    null,
  );

  assert.deepEqual(recorded, [
    {
      messageId: 2,
      text: "最新用户楼层",
      source: "message-sent",
    },
  ]);
  assert.equal(refreshCalls, 1);
}

async function testUserMessageRenderedRefreshesRecallUiAfterRealDomRender() {
  const refreshCalls = [];

  const result = onUserMessageRenderedController(
    {
      refreshPersistedRecallMessageUi(delayMs = 0) {
        refreshCalls.push(delayMs);
      },
    },
    7,
  );

  assert.deepEqual(refreshCalls, [40]);
  assert.equal(result.messageId, 7);
  assert.equal(result.source, "user-message-rendered");
}

async function testCharacterMessageRenderedRefreshesRecallUiAfterAssistantRender() {
  const refreshCalls = [];

  const result = onCharacterMessageRenderedController(
    {
      refreshPersistedRecallMessageUi(delayMs = 0) {
        refreshCalls.push(delayMs);
      },
    },
    8,
    "normal",
  );

  assert.deepEqual(refreshCalls, [80]);
  assert.equal(result.messageId, 8);
  assert.equal(result.type, "normal");
  assert.equal(result.source, "character-message-rendered");
}

async function testMessageReceivedQueuesExtractionWithoutRuntimeQueueMicrotask() {
  let runExtractionCalls = 0;
  let refreshCalls = 0;

  onMessageReceivedController(
    {
      getGraphPersistenceState: () => ({ loadState: "loaded", dbReady: true }),
      getCurrentGraph: () => null,
      getPendingRecallSendIntent: () => ({ text: "", at: 0 }),
      isFreshRecallInputRecord: () => true,
      createRecallInputRecord: () => ({ text: "", at: 0 }),
      setPendingRecallSendIntent() {},
      getContext: () => ({
        chat: [
          { is_user: true, mes: "u1" },
          { is_user: false, mes: "a1" },
        ],
      }),
      isAssistantChatMessage(message) {
        return Boolean(message) && !message.is_user && !message.is_system;
      },
      runExtraction: async () => {
        runExtractionCalls += 1;
      },
      console: {
        error() {},
      },
      notifyExtractionIssue() {},
      refreshPersistedRecallMessageUi() {
        refreshCalls += 1;
      },
    },
    1,
    "assistant",
  );

  await waitForTick();

  assert.equal(runExtractionCalls, 1);
  assert.equal(refreshCalls, 1);
}

async function testAutoExtractionDefersWhenGraphNotReady() {
  const deferredReasons = [];
  const statuses = [];

  await runExtractionController({
    getIsExtracting: () => false,
    getCurrentGraph: () => null,
    getSettings: () => ({ enabled: true }),
    ensureGraphMutationReady: () => false,
    deferAutoExtraction(reason) {
      deferredReasons.push(reason);
    },
    setLastExtractionStatus(...args) {
      statuses.push(args);
    },
    getGraphMutationBlockReason: () =>
      "自动提取已暂停：正在加载 IndexedDB 图谱。",
  });

  assert.deepEqual(deferredReasons, ["graph-not-ready"]);
  assert.equal(statuses[0]?.[0], "等待图谱加载");
}

async function testAutoExtractionDefersWhenAlreadyExtracting() {
  const deferredReasons = [];

  await runExtractionController({
    getIsExtracting: () => true,
    deferAutoExtraction(reason) {
      deferredReasons.push(reason);
    },
  });

  assert.deepEqual(deferredReasons, ["extracting"]);
}

async function testAutoExtractionDefersWhenHistoryRecoveryBusy() {
  const deferredReasons = [];

  await runExtractionController({
    getIsExtracting: () => false,
    getCurrentGraph: () => ({}),
    getSettings: () => ({ enabled: true }),
    ensureGraphMutationReady: () => true,
    ensureCurrentGraphRuntimeState() {},
    recoverHistoryIfNeeded: async () => false,
    getIsRecoveringHistory: () => true,
    deferAutoExtraction(reason) {
      deferredReasons.push(reason);
    },
  });

  assert.deepEqual(deferredReasons, ["history-recovering"]);
}

async function testRemoveNodeHandlesCyclicChildGraph() {
  const graph = createEmptyGraph();
  const nodeA = addNode(
    graph,
    createNode({ type: "event", fields: { title: "A" }, seq: 0 }),
  );
  const nodeB = addNode(
    graph,
    createNode({ type: "event", fields: { title: "B" }, seq: 1 }),
  );
  nodeA.childIds = [nodeB.id];
  nodeB.parentId = nodeA.id;
  nodeB.childIds = [nodeA.id];
  nodeA.parentId = nodeB.id;
  addEdge(
    graph,
    createEdge({ fromId: nodeA.id, toId: nodeB.id, relation: "cycle" }),
  );

  const removed = removeNode(graph, nodeA.id);

  assert.equal(removed, true);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
}

async function testGenerationRecallAppliesFinalInjectionOncePerTransaction() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一轮仅一次最终注入" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.applyFinalCalls.length, 1);
  assert.equal(harness.applyFinalCalls[0].generationType, "normal");
}

async function testGenerationRecallDeferredRewriteMutatesFinalMesSendPayload() {
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.__sendTextareaValue = "发送前真实输入";

  await harness.result.onGenerationStarted("normal", {}, false);
  harness.__sendTextareaValue = "";
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  const promptData = {
    finalMesSend: [
      {
        injected: false,
        message: "发送前真实输入",
        extensionPrompts: [],
      },
    ],
  };

  const resolution = await harness.result.onBeforeCombinePrompts(promptData);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.applyFinalCalls.length, 1);
  assert.equal(resolution.applicationMode, "rewrite");
  assert.equal(resolution.deliveryMode, "deferred");
  assert.equal(resolution.rewrite.applied, true);
  assert.equal(resolution.rewrite.path, "finalMesSend");
  assert.match(
    promptData.finalMesSend[0].extensionPrompts.join("\n"),
    /注入:发送前真实输入/,
  );
  assert.equal(
    harness.moduleInjectionCalls.every((text) => text === ""),
    true,
  );
  assert.equal(
    harness.recordedInjectionSnapshots.at(-1)?.applicationMode,
    "rewrite",
  );
}

async function testGenerationRecallSendIntentBeatsChatTailAndStaysObservable() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "旧的 chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "刚触发发送的新输入",
    hash: "hash-send-intent-priority",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "旧的 chat tail");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].overrideSourceLabel, "发送意图");
  assert.equal(
    harness.runRecallCalls[0].overrideReason,
    "send-intent-overrides-chat-tail",
  );
  assert.equal(
    JSON.stringify(
      harness.runRecallCalls[0].sourceCandidates.map(
        (candidate) => candidate.source,
      ),
    ),
    JSON.stringify(["send-intent", "chat-tail-user"]),
  );
  const transaction = [
    ...harness.result.generationRecallTransactions.values(),
  ][0];
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "旧的 chat tail",
  );
  assert.equal(transaction.frozenRecallOptions.lockedSource, "send-intent");
  assert.equal(transaction.frozenRecallOptions.lockedSourceLabel, "发送意图");
  assert.equal(
    transaction.frozenRecallOptions.lockedReason,
    "send-intent-overrides-chat-tail",
  );
  assert.equal(
    transaction.frozenRecallOptions.sourceCandidates[0]?.text,
    "刚触发发送的新输入",
  );
}

async function testGenerationRecallSendIntentWinsOverHostSnapshotStably() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.pendingRecallSendIntent = {
    text: "发送意图优先输入",
    hash: "hash-send-intent-vs-host",
    at: Date.now(),
    source: "dom-intent",
  };
  const frozenSnapshot =
    harness.result.freezeHostGenerationInputSnapshot("宿主快照输入");

  await harness.result.onGenerationAfterCommands(
    "normal",
    { frozenInputSnapshot: frozenSnapshot },
    false,
  );
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].overrideUserMessage,
    "发送意图优先输入",
  );
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(
    JSON.stringify(
      harness.runRecallCalls[0].sourceCandidates.map(
        (candidate) => candidate.source,
      ),
    ),
    JSON.stringify(["send-intent", "host-generation-lifecycle"]),
  );
  assert.equal(harness.applyFinalCalls.length, 1);
}

async function testGenerationRecallLockedSourceDoesNotDriftWithinTransaction() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: false, mes: "assistant-tail" }];
  harness.pendingRecallSendIntent = {
    text: "事务锁定输入-A",
    hash: "hash-locked-source",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  harness.pendingRecallSendIntent = {
    text: "事务漂移输入-B",
    hash: "hash-drift-source",
    at: Date.now(),
    source: "dom-intent",
  };
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "事务漂移输入-B");
  const transaction = [
    ...harness.result.generationRecallTransactions.values(),
  ][0];
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "事务漂移输入-B",
  );
  assert.equal(transaction.frozenRecallOptions.lockedSource, "send-intent");
  assert.equal(transaction.frozenRecallOptions.lockedSourceLabel, "发送意图");
  assert.equal(
    transaction.frozenRecallOptions.lockedReason,
    "send-intent-captured",
  );
}

async function testBeforeCombineRecallNotSkippedWhenGraphLoadingButRuntimeGraphReadable() {
  const { runRecallController } = await import("../recall-controller.js");
  const statuses = [];
  const graph = normalizeGraphRuntimeState(createEmptyGraph(), "chat-main");
  graph.nodes.push(
    createNode("event", {
      title: "旧事件",
      summary: "来自 runtime graph",
    }),
  );

  const runtime = {
    getIsRecalling: () => false,
    abortRecallStageWithReason() {},
    waitForActiveRecallToSettle: async () => ({ settled: true }),
    getCurrentGraph: () => graph,
    getSettings: () => ({
      enabled: true,
      recallEnabled: true,
      recallLlmContextMessages: 4,
    }),
    isGraphReadable: () => false,
    isGraphReadableForRecall: () => true,
    getGraphMutationBlockReason: () => "召回已暂停：正在加载 IndexedDB 图谱。",
    setLastRecallStatus: (...args) => {
      statuses.push(args);
    },
    isGraphMetadataWriteAllowed: () => false,
    recoverHistoryIfNeeded: async () => {
      throw new Error("loading 期间不应触发历史恢复");
    },
    getContext: () => ({
      chat: [{ is_user: true, mes: "发送前输入" }],
    }),
    nextRecallRunSequence: () => 1,
    setIsRecalling() {},
    beginStageAbortController: () => ({
      signal: { aborted: false, addEventListener() {} },
      abort() {},
    }),
    createAbortError: (message) => new Error(message),
    ensureVectorReadyIfNeeded: async () => {},
    clampInt,
    resolveRecallInput: () => ({
      userMessage: "发送前输入",
      recentMessages: ["[user]: 发送前输入"],
      source: "send-intent",
      sourceLabel: "发送意图",
      generationType: "normal",
      targetUserMessageIndex: null,
    }),
    console,
    getRecallHookLabel: () => "发送前拦截",
    retrieve: async ({ graph: passedGraph, userMessage }) => {
      assert.equal(passedGraph, graph);
      assert.equal(userMessage, "发送前输入");
      return {
        stats: { recallCount: 1, coreCount: 1 },
        selectedNodeIds: [graph.nodes[0].id],
        meta: {
          retrieval: {
            vectorHits: 1,
            diffusionHits: 0,
            llm: { status: "disabled", candidatePool: 0 },
          },
        },
      };
    },
    getEmbeddingConfig: () => null,
    getSchema: () => schema,
    buildRecallRetrieveOptions: () => ({}),
    applyRecallInjection: (_settings, recallInput) => ({
      injectionText: `注入:${recallInput.userMessage}`,
    }),
    createRecallInputRecord,
    createRecallRunResult,
    isAbortError: () => false,
    toastr: {
      warning() {},
      error() {},
    },
    finishStageAbortController() {},
    getActiveRecallPromise: () => null,
    setActiveRecallPromise() {},
    setPendingRecallSendIntent() {},
    refreshPanelLiveState() {},
  };

  const result = await runRecallController(runtime, {
    hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.didRecall, true);
  assert.equal(result.injectionText, "注入:发送前输入");
  assert.equal(
    statuses.some(([title]) => title === "等待图谱加载"),
    false,
    "runtime graph 可读时不应再被 loading 门禁误判为等待图谱加载",
  );
}

async function testPersistentRecallDataLayerLifecycleAndCompatibility() {
  const chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
  ];

  const record = buildPersistedRecallRecord({
    injectionText: "fresh-memory",
    selectedNodeIds: ["n1", "n2"],
    recallInput: "u2",
    recallSource: "chat-last-user",
    hookName: "GENERATION_AFTER_COMMANDS",
    tokenEstimate: 24,
    manuallyEdited: false,
    nowIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(writePersistedRecallToUserMessage(chat, 2, record), true);

  const loaded = readPersistedRecallFromUserMessage(chat, 2);
  assert.ok(loaded);
  assert.equal(loaded.injectionText, "fresh-memory");
  assert.equal(loaded.generationCount, 0);
  assert.equal(loaded.manuallyEdited, false);

  chat[2].mes = "u2 edited";
  assert.equal(
    readPersistedRecallFromUserMessage(chat, 2)?.injectionText,
    "fresh-memory",
  );

  const bumped = bumpPersistedRecallGenerationCount(chat, 2);
  assert.equal(bumped?.generationCount, 1);

  const edited = markPersistedRecallManualEdit(
    chat,
    2,
    true,
    "2026-01-01T00:00:01.000Z",
  );
  assert.equal(edited?.manuallyEdited, true);
  assert.equal(edited?.updatedAt, "2026-01-01T00:00:01.000Z");

  const overwrite = buildPersistedRecallRecord(
    {
      injectionText: "system-rerecall",
      selectedNodeIds: ["n3"],
      recallInput: "u2 edited",
      recallSource: "message-floor-rerecall",
      hookName: "MESSAGE_RECALL_BADGE_RERUN",
      tokenEstimate: 30,
      manuallyEdited: false,
      nowIso: "2026-01-01T00:00:02.000Z",
    },
    readPersistedRecallFromUserMessage(chat, 2),
  );
  assert.equal(writePersistedRecallToUserMessage(chat, 2, overwrite), true);
  const overwritten = readPersistedRecallFromUserMessage(chat, 2);
  assert.equal(overwritten?.manuallyEdited, false);
  assert.equal(overwritten?.injectionText, "system-rerecall");

  assert.equal(removePersistedRecallFromUserMessage(chat, 2), true);
  assert.equal(readPersistedRecallFromUserMessage(chat, 2), null);
  assert.equal(
    readPersistedRecallFromUserMessage([{ is_user: true, mes: "legacy" }], 0),
    null,
  );
}

async function testPersistentRecallSourceResolutionAndTargetRouting() {
  const chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a3" },
  ];

  assert.equal(
    resolveGenerationTargetUserMessageIndex(chat, { generationType: "normal" }),
    null,
  );
  assert.equal(
    resolveGenerationTargetUserMessageIndex(chat, {
      generationType: "continue",
    }),
    2,
  );

  const withTailUser = [...chat, { is_user: true, mes: "u4" }];
  assert.equal(
    resolveGenerationTargetUserMessageIndex(withTailUser, {
      generationType: "normal",
    }),
    4,
  );

  const freshWins = resolveFinalRecallInjectionSource({
    freshRecallResult: {
      status: "completed",
      didRecall: true,
      injectionText: "fresh",
    },
    persistedRecord: { injectionText: "persisted" },
  });
  assert.equal(freshWins.source, "fresh");
  assert.equal(freshWins.injectionText, "fresh");

  const fallback = resolveFinalRecallInjectionSource({
    freshRecallResult: {
      status: "skipped",
      didRecall: false,
      injectionText: "",
    },
    persistedRecord: { injectionText: "persisted" },
  });
  assert.equal(fallback.source, "persisted");
  assert.equal(fallback.injectionText, "persisted");
}

async function testGenerationRecallFinalInjectionRebindsLatestMatchingUserFloor() {
  {
    const harness = await createGenerationRecallHarness({ realApplyFinal: true });
    harness.chat = [
      { is_user: true, mes: "当前输入" },
      { is_user: false, mes: "assistant-tail" },
    ];
    harness.result.recordRecallSentUserMessage(0, "当前输入", "message-sent");

    const resolution =
      harness.result.applyFinalRecallInjectionForGeneration({
        generationType: "normal",
        hookName: "GENERATION_AFTER_COMMANDS",
        freshRecallResult: {
          status: "completed",
          didRecall: true,
          injectionText: "fresh-memory",
        },
        transaction: {
          frozenRecallOptions: {
            generationType: "normal",
            targetUserMessageIndex: null,
            overrideUserMessage: "当前输入",
          },
        },
      });

    assert.equal(resolution.targetUserMessageIndex, 0);
  }

  {
    const harness = await createGenerationRecallHarness({ realApplyFinal: true });
    harness.chat = [
      { is_user: true, mes: "尾部 user 仍可匹配" },
      { is_user: false, mes: "assistant-tail" },
    ];

    const resolution =
      harness.result.applyFinalRecallInjectionForGeneration({
        generationType: "normal",
        hookName: "GENERATION_AFTER_COMMANDS",
        freshRecallResult: {
          status: "completed",
          didRecall: true,
          injectionText: "fresh-memory",
          sourceCandidates: [
            {
              text: "尾部 user 仍可匹配",
            },
          ],
        },
        transaction: {
          frozenRecallOptions: {
            generationType: "normal",
            targetUserMessageIndex: null,
            overrideUserMessage: "尾部 user 仍可匹配",
          },
        },
      });

    assert.equal(resolution.targetUserMessageIndex, 0);
  }

  {
    const harness = await createGenerationRecallHarness({ realApplyFinal: true });
    harness.chat = [
      { is_user: true, mes: "酒馆最终写入的用户楼层文本" },
      { is_user: false, mes: "assistant-tail" },
    ];
    harness.result.recordRecallSentUserMessage(0, "发送前捕获的原始文本", "message-sent");

    const resolution =
      harness.result.applyFinalRecallInjectionForGeneration({
        generationType: "normal",
        hookName: "GENERATION_AFTER_COMMANDS",
        freshRecallResult: {
          status: "completed",
          didRecall: true,
          injectionText: "fresh-memory",
          sourceCandidates: [
            {
              text: "发送前捕获的原始文本",
            },
          ],
        },
        transaction: {
          frozenRecallOptions: {
            generationType: "normal",
            targetUserMessageIndex: null,
            overrideUserMessage: "发送前捕获的原始文本",
          },
        },
      });

    assert.equal(
      resolution.targetUserMessageIndex,
      0,
      "normal 生成时即便用户文本被宿主改写，也应回绑到最新 user 楼层",
    );
  }
}

async function testGenerationRecallFinalInjectionBackfillsPersistedRecord() {
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [
    { is_user: true, mes: "最终阶段补写目标" },
    { is_user: false, mes: "assistant-tail" },
  ];
  harness.result.recordRecallSentUserMessage(0, "最终阶段补写目标", "message-sent");

  const resolution =
    harness.result.applyFinalRecallInjectionForGeneration({
      generationType: "normal",
      hookName: "GENERATION_AFTER_COMMANDS",
      freshRecallResult: {
        status: "completed",
        didRecall: true,
        injectionText: "fresh-memory",
        selectedNodeIds: ["node-a", "node-b"],
      },
      transaction: {
        frozenRecallOptions: {
          generationType: "normal",
          targetUserMessageIndex: null,
          overrideUserMessage: "最终阶段补写目标",
          lockedSource: "send-intent",
          hookName: "GENERATION_AFTER_COMMANDS",
        },
      },
    });

  assert.equal(resolution.source, "fresh");
  assert.equal(resolution.targetUserMessageIndex, 0);
  assert.equal(
    harness.chat[0]?.extra?.bme_recall?.injectionText,
    "fresh-memory",
  );
  assert.deepEqual(
    harness.chat[0]?.extra?.bme_recall?.selectedNodeIds,
    ["node-a", "node-b"],
  );
  assert.equal(harness.metadataSaveCalls > 0, true);
}

async function testGenerationRecallImmediateAfterCommandsBackfillsPersistedRecord() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "即时模式补写目标" }];
  harness.result.recordRecallSentUserMessage(0, "即时模式补写目标", "message-sent");

  const result = await harness.result.onGenerationAfterCommands(
    "normal",
    {},
    false,
  );

  assert.equal(result?.status, "completed");
  assert.equal(
    harness.chat[0]?.extra?.bme_recall?.injectionText,
    "注入:即时模式补写目标",
  );
  assert.deepEqual(
    harness.chat[0]?.extra?.bme_recall?.selectedNodeIds,
    ["node-test-1"],
  );
  assert.equal(harness.metadataSaveCalls > 0, true);
}

async function testGenerationEndedBackfillsRecentRecallAndSchedulesHideRefresh() {
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [{ is_user: true, mes: "生成结束后补写目标" }];
  const transaction = harness.result.beginGenerationRecallTransaction({
    chatId: "chat-main",
    generationType: "normal",
    recallKey: "chat-main:normal:test-generation-ended",
    forceNew: true,
  });
  transaction.frozenRecallOptions = {
    generationType: "normal",
    targetUserMessageIndex: null,
    overrideUserMessage: "生成结束后补写目标",
    lockedSource: "send-intent",
    hookName: "GENERATION_AFTER_COMMANDS",
  };
  harness.result.generationRecallTransactions.set(transaction.id, transaction);
  harness.result.markGenerationRecallTransactionHookState(
    transaction,
    "GENERATION_AFTER_COMMANDS",
    "completed",
  );
  harness.result.getGenerationRecallTransactionResult(transaction);
  transaction.lastRecallResult = {
    status: "completed",
    didRecall: true,
    injectionText: "generation-ended-memory",
    selectedNodeIds: ["node-z"],
    sourceCandidates: [{ text: "生成结束后补写目标" }],
    hookName: "GENERATION_AFTER_COMMANDS",
  };
  transaction.updatedAt = Date.now();
  harness.result.generationRecallTransactions.set(transaction.id, transaction);

  harness.result.onGenerationEnded();

  assert.equal(
    harness.chat[0]?.extra?.bme_recall?.injectionText,
    "generation-ended-memory",
  );
  assert.equal(harness.hideScheduleCalls.length, 1);
  assert.equal(harness.hideScheduleCalls[0]?.[2], 180);
}

async function testRecallSubGraphAndDataLayerEntryPoints() {
  // Sub-graph build test (pure function, no DOM needed)
  const { buildRecallSubGraph } = await import("../recall-message-ui.js");

  const graph = {
    nodes: [
      { id: "n1", type: "character", name: "赵管家", importance: 7 },
      { id: "n2", type: "event", name: "喂食", importance: 5 },
      {
        id: "n3",
        type: "location",
        name: "厨房",
        importance: 3,
        archived: true,
      },
      { id: "n4", type: "thread", name: "主线", importance: 8 },
    ],
    edges: [
      { fromId: "n1", toId: "n2", strength: 0.8, relation: "related" },
      { fromId: "n2", toId: "n3", strength: 0.5, relation: "located" },
      { fromId: "n1", toId: "n4", strength: 0.6, relation: "participates" },
    ],
  };

  const sub1 = buildRecallSubGraph(graph, ["n1", "n2"]);
  assert.equal(sub1.nodes.length, 2);
  assert.equal(sub1.edges.length, 1);
  assert.equal(sub1.edges[0].fromId, "n1");

  // archived node should be excluded
  const sub2 = buildRecallSubGraph(graph, ["n1", "n3"]);
  assert.equal(sub2.nodes.length, 1);
  assert.equal(sub2.edges.length, 0);

  // empty/null safety
  assert.equal(buildRecallSubGraph(null, ["n1"]).nodes.length, 0);
  assert.equal(buildRecallSubGraph(graph, null).nodes.length, 0);
  assert.equal(buildRecallSubGraph(graph, []).nodes.length, 0);

  // Data layer: edit and delete still work
  const chat = [
    {
      is_user: true,
      mes: "u0",
      extra: {
        bme_recall: {
          version: 1,
          injectionText: "test",
          selectedNodeIds: ["n1"],
          generationCount: 0,
          manuallyEdited: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          recallInput: "u0",
          recallSource: "test",
          hookName: "TEST",
          tokenEstimate: 4,
        },
      },
    },
  ];
  assert.ok(readPersistedRecallFromUserMessage(chat, 0));
  assert.equal(removePersistedRecallFromUserMessage(chat, 0), true);
  assert.equal(readPersistedRecallFromUserMessage(chat, 0), null);
}

async function testRerollUsesBatchBoundaryRollbackAndPersistsState() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
    { is_user: true, mes: "u3" },
    { is_user: false, mes: "a3" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 5,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
        5: "hash-5",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [{ id: "journal-1" }],
    lastProcessedSeq: 5,
  };
  harness.postRollbackGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: {
        1: "hash-1",
        3: "stale-hash",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "reverse-journal",
    affectedBatchCount: 1,
    affectedJournals: [{ id: "journal-1" }],
  });
  harness.buildReverseJournalRecoveryPlanImpl = () => ({
    backendDeleteHashes: ["hash-old"],
    replayRequiredNodeIds: ["node-1"],
    pendingRepairFromFloor: 2,
    legacyGapFallback: false,
    dirtyReason: "history-recovery-replay",
  });

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, true);
  assert.equal(result.rollbackPerformed, true);
  assert.equal(result.recoveryPath, "reverse-journal");
  assert.equal(result.effectiveFromFloor, 2);
  assert.equal(result.resultCode, "reroll.rollback.applied");
  assert.equal(harness.rollbackAffectedJournalsCalls.length, 1);
  assert.equal(harness.deletedHashesCalls.length, 1);
  assert.equal(harness.prepareVectorStateCalls.length, 1);
  assert.equal(harness.prepareVectorStateCalls[0][2].skipBackendPurge, true);
  assert.equal(harness.saveGraphToChatCalls, 1);
  assert.equal(harness.refreshPanelCalls, 2);
  assert.equal(harness.clearInjectionCalls, 1);
  assert.equal(harness.onManualExtractCalls, 1);
  assert.equal(
    harness.currentGraph.historyState.processedMessageHashes[3],
    undefined,
  );
  assert.equal(harness.currentGraph.vectorIndexState.lastIntegrityIssue, null);
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.resultCode,
    "reroll.rollback.applied",
  );
  assert.equal(harness.lastExtractedItems.length, 0);
}

async function testRerollRejectsInvalidReverseJournalPlanFailClosed() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 3,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
      },
      lastRecoveryResult: null,
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [{ id: "journal-1" }],
    lastProcessedSeq: 3,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "reverse-journal",
    affectedBatchCount: 1,
    affectedJournals: [{ id: "journal-1" }],
  });
  harness.buildReverseJournalRecoveryPlanImpl = () => ({
    valid: false,
    invalidReason: "pending-repair-floor-missing",
    backendDeleteHashes: [],
    replayRequiredNodeIds: [],
  });

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, false);
  assert.equal(result.recoveryPath, "reverse-journal-rejected");
  assert.equal(result.resultCode, "reroll.rollback.plan-invalid");
  assert.equal(harness.rollbackAffectedJournalsCalls.length, 0);
  assert.equal(harness.prepareVectorStateCalls.length, 0);
  assert.equal(harness.deletedHashesCalls.length, 0);
  assert.equal(harness.saveGraphToChatCalls, 1);
  assert.equal(harness.refreshPanelCalls, 1);
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.status,
    "reroll-rollback-rejected",
  );
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.resultCode,
    "reroll.rollback.plan-invalid",
  );
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.debugReason,
    "reroll-rollback-plan-invalid:pending-repair-floor-missing",
  );
}

async function testHistoryRecoveryAbortClearsVectorRepairState() {
  const harness = await createHistoryRecoveryHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: { 1: "hash-1" },
      historyDirtyFrom: 1,
      lastMutationSource: "message-edited",
    },
    vectorIndexState: {
      collectionId: "col-1",
      dirty: true,
      dirtyReason: "history-recovery-replay",
      pendingRepairFromFloor: 1,
      replayRequiredNodeIds: ["node-1"],
      lastWarning: "repair pending",
      lastIntegrityIssue: { code: "dangling-vector" },
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "full-rebuild",
    affectedBatchCount: 0,
  });
  harness.prepareVectorStateForReplayImpl = async () => {
    throw harness.createAbortError("manual abort");
  };

  const result = await harness.result.recoverFromHistoryMutation({
    trigger: "message-edited",
    dirtyFrom: 1,
    detection: { source: "manual-test", reason: "edited" },
  });

  assert.equal(result, false);
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.resultCode,
    "history.recovery.aborted",
  );
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.debugReason,
    "history-recovery-aborted:full-rebuild",
  );
  assert.equal(harness.currentGraph.vectorIndexState.lastIntegrityIssue, null);
  assert.equal(harness.currentGraph.vectorIndexState.lastWarning, "");
  assert.equal(
    harness.currentGraph.vectorIndexState.pendingRepairFromFloor,
    null,
  );
  assert.equal(
    harness.currentGraph.vectorIndexState.replayRequiredNodeIds.length,
    0,
  );
  assert.equal(harness.currentGraph.vectorIndexState.dirty, false);
  assert.equal(harness.currentGraph.vectorIndexState.dirtyReason, "");
}

async function testHistoryRecoveryFallbackFullRebuildCarriesResultCode() {
  const harness = await createHistoryRecoveryHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: { 1: "hash-1" },
      historyDirtyFrom: 1,
      lastMutationSource: "message-edited",
    },
    vectorIndexState: {
      collectionId: "col-1",
      dirty: true,
      dirtyReason: "history-recovery-replay",
      pendingRepairFromFloor: 1,
      replayRequiredNodeIds: ["node-1"],
      lastWarning: "repair pending",
      lastIntegrityIssue: { code: "dangling-vector" },
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "legacy-snapshot",
    affectedBatchCount: 2,
    snapshotBefore: {
      historyState: { extractionCount: 0 },
      vectorIndexState: { collectionId: "col-1" },
      batchJournal: [],
      lastProcessedSeq: -1,
    },
  });
  let replayCallCount = 0;
  harness.replayExtractionFromHistoryImpl = async () => {
    replayCallCount += 1;
    if (replayCallCount === 1) {
      throw new Error("replay failed");
    }
    return 1;
  };

  const result = await harness.result.recoverFromHistoryMutation({
    trigger: "message-edited",
    dirtyFrom: 1,
    detection: { source: "manual-test", reason: "edited" },
  });

  assert.equal(result, true);
  assert.equal(
    harness.clearedHistoryDirty.resultCode,
    "history.recovery.fallback-full-rebuild",
  );
  assert.equal(
    harness.clearedHistoryDirty.debugReason,
    "history-recovery-fallback-full-rebuild:legacy-snapshot",
  );
}

async function testHistoryRecoverySuccessRestoresProcessedHashesAfterReplay() {
  const harness = await createHistoryRecoveryHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: { 1: "old-hash-1" },
      historyDirtyFrom: 1,
      lastMutationSource: "message-edited",
    },
    vectorIndexState: {
      collectionId: "col-1",
      dirty: false,
      dirtyReason: "",
      pendingRepairFromFloor: null,
      replayRequiredNodeIds: [],
      lastWarning: "",
      lastIntegrityIssue: null,
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "full-rebuild",
    affectedBatchCount: 0,
  });
  harness.replayExtractionFromHistoryImpl = async () => {
    harness.currentGraph.historyState.lastProcessedAssistantFloor = 1;
    harness.currentGraph.lastProcessedSeq = 1;
    return 1;
  };

  const result = await harness.result.recoverFromHistoryMutation({
    trigger: "message-edited",
    dirtyFrom: 1,
    detection: { source: "manual-test", reason: "edited" },
  });

  assert.equal(result, true);
  assert.deepEqual(harness.updatedProcessedHistorySnapshot, {
    chatLength: 2,
    lastProcessedAssistantFloor: 1,
  });
  assert.deepEqual(harness.currentGraph.historyState.processedMessageHashes, {
    1: "hash-1",
  });
}

async function testHistoryRecoveryFailureCarriesResultCode() {
  const harness = await createHistoryRecoveryHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: { 1: "hash-1" },
      historyDirtyFrom: 1,
      lastMutationSource: "message-edited",
    },
    vectorIndexState: {
      collectionId: "col-1",
      dirty: true,
      dirtyReason: "history-recovery-replay",
      pendingRepairFromFloor: 1,
      replayRequiredNodeIds: ["node-1"],
      lastWarning: "repair pending",
      lastIntegrityIssue: { code: "dangling-vector" },
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "legacy-snapshot",
    affectedBatchCount: 1,
    snapshotBefore: {
      historyState: { extractionCount: 0 },
      vectorIndexState: { collectionId: "col-1" },
      batchJournal: [],
      lastProcessedSeq: -1,
    },
  });
  harness.replayExtractionFromHistoryImpl = async () => {
    throw new Error("replay failed twice");
  };

  const result = await harness.result.recoverFromHistoryMutation({
    trigger: "message-edited",
    dirtyFrom: 1,
    detection: { source: "manual-test", reason: "edited" },
  });

  assert.equal(result, false);
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.resultCode,
    "history.recovery.failed",
  );
  assert.equal(
    harness.currentGraph.historyState.lastRecoveryResult.debugReason,
    "history-recovery-failed:legacy-snapshot",
  );
  assert.equal(harness.currentGraph.vectorIndexState.lastIntegrityIssue, null);
}
async function testRerollRejectsMissingRecoveryPoint() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 3,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 3,
  };

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, false);
  assert.equal(result.recoveryPath, "unavailable");
  assert.equal(result.resultCode, "reroll.rollback.unavailable");
  assert.equal(harness.onManualExtractCalls, 0);
  assert.equal(harness.saveGraphToChatCalls, 0);
}

async function testRerollFallsBackToDirectExtractForUnprocessedFloor() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: {
        1: "hash-1",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, true);
  assert.equal(result.rollbackPerformed, false);
  assert.equal(result.recoveryPath, "direct-extract");
  assert.equal(result.effectiveFromFloor, 2);
  assert.equal(result.resultCode, undefined);
  assert.equal(harness.onManualExtractCalls, 1);
  assert.equal(harness.saveGraphToChatCalls, 0);
}

async function testRerollPreservesPrefixHashesWhenReextractDoesNotAdvance() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
    { is_user: true, mes: "u3" },
    { is_user: false, mes: "a3" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 5,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
        5: "hash-5",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [{ id: "journal-1" }],
    lastProcessedSeq: 5,
  };
  harness.postRollbackGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: {
        1: "old-hash-1",
        3: "stale-hash",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "reverse-journal",
    affectedBatchCount: 1,
    affectedJournals: [{ id: "journal-1" }],
  });
  harness.buildReverseJournalRecoveryPlanImpl = () => ({
    backendDeleteHashes: [],
    replayRequiredNodeIds: [],
    pendingRepairFromFloor: 2,
    legacyGapFallback: false,
    dirtyReason: "history-recovery-replay",
  });
  harness.manualExtractLevel = "error";

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, true);
  assert.equal(result.extractionStatus, "error");
  assert.deepEqual(harness.updatedProcessedHistorySnapshot, {
    chatLength: 6,
    lastProcessedAssistantFloor: 1,
  });
  assert.deepEqual(harness.currentGraph.historyState.processedMessageHashes, {
    1: "hash-1",
  });
}

async function testLlmDebugSnapshotRedactsSecretsBeforeStorage() {
  const originalFetch = globalThis.fetch;
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  delete globalThis.__stBmeRuntimeDebugState;
  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-secret-redaction",
    llmModel: "gpt-test",
    timeoutMs: 1234,
  };

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"ok":true}',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  try {
    const result = await llm.callLLMForJSON({
      systemPrompt: "system",
      userPrompt: "user",
      maxRetries: 0,
      requestSource: "test:redaction",
    });
    assert.deepEqual(result, { ok: true });

    const snapshot =
      globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.["test:redaction"];
    assert.ok(snapshot);
    assert.equal(snapshot.redacted, true);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /sk-secret-redaction/);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testEmbeddingUsesConfigTimeoutInsteadOfDefault() {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let capturedDelay = null;

  globalThis.setTimeout = (fn, delay, ...args) => {
    capturedDelay = delay;
    return originalSetTimeout(fn, 0, ...args);
  };
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.fetch = async (_url, options = {}) =>
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      embedding.embedText("timeout test", {
        apiUrl: "https://example.com/v1",
        model: "text-embedding-test",
        timeoutMs: 7,
      }),
      /Embedding 请求超时/,
    );
    assert.equal(capturedDelay, 7);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

async function testLlmOutputRegexCleansResponseBeforeJsonParse() {
  const originalFetch = globalThis.fetch;
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  delete globalThis.__stBmeRuntimeDebugState;

  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles.extract.profiles[0].regex = {
    ...taskProfiles.extract.profiles[0].regex,
    enabled: true,
    inheritStRegex: false,
    stages: {
      ...taskProfiles.extract.profiles[0].regex.stages,
      "output.rawResponse": true,
      "output.beforeParse": true,
    },
    localRules: [
      {
        id: "strip-prefix",
        script_name: "strip-prefix",
        enabled: true,
        find_regex: "/^NOTE:\\s*/g",
        replace_string: "",
        trim_strings: [],
        source: {
          ai_output: true,
        },
        destination: {
          prompt: true,
          display: false,
        },
      },
      {
        id: "strip-suffix",
        script_name: "strip-suffix",
        enabled: true,
        find_regex: "/\\s*END$/g",
        replace_string: "",
        trim_strings: [],
        source: {
          ai_output: true,
        },
        destination: {
          prompt: true,
          display: false,
        },
      },
    ],
  };

  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-secret-redaction",
    llmModel: "gpt-test",
    taskProfilesVersion: 1,
    taskProfiles,
  };

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'NOTE: {"ok":true} END',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  try {
    const result = await llm.callLLMForJSON({
      systemPrompt: "system",
      userPrompt: "user",
      maxRetries: 0,
      taskType: "extract",
      requestSource: "test:output-regex",
    });
    assert.deepEqual(result, { ok: true });

    const snapshot =
      globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.extract;
    assert.ok(snapshot);
    assert.equal(snapshot.responseCleaning?.applied, true);
    assert.equal(snapshot.responseCleaning?.changed, true);
    assert.deepEqual(
      snapshot.responseCleaning?.stages?.map((entry) => entry.stage),
      ["output.rawResponse", "output.beforeParse"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testManualCompressSkipsWithoutCandidatesAndDoesNotPretendItRan() {
  const calls = {
    compressAll: 0,
    recordGraphMutation: 0,
    recordMaintenanceAction: 0,
  };
  const toastMessages = [];
  const graph = { nodes: [], historyState: {} };

  const result = await onManualCompressController({
    getCurrentGraph: () => graph,
    ensureGraphMutationReady: () => true,
    getSchema: () => [],
    inspectCompressionCandidates: () => ({
      hasCandidates: false,
      reason: "当前没有可压缩候选组，本次未发起 LLM 压缩",
    }),
    cloneGraphSnapshot: (value) => JSON.parse(JSON.stringify(value ?? null)),
    compressAll: async () => {
      calls.compressAll += 1;
      return { created: 1, archived: 1 };
    },
    getEmbeddingConfig: () => ({}),
    getSettings: () => ({}),
    recordMaintenanceAction() {
      calls.recordMaintenanceAction += 1;
    },
    recordGraphMutation: async () => {
      calls.recordGraphMutation += 1;
    },
    toastr: {
      info(message) {
        toastMessages.push(["info", message]);
      },
      success(message) {
        toastMessages.push(["success", message]);
      },
    },
  });

  assert.equal(calls.compressAll, 0);
  assert.equal(calls.recordMaintenanceAction, 0);
  assert.equal(calls.recordGraphMutation, 0);
  assert.equal(result?.handledToast, true);
  assert.equal(result?.requestDispatched, false);
  assert.match(String(toastMessages[0]?.[1] || ""), /未发起 LLM 压缩/);
}

async function testManualCompressUsesForcedCompressionAndPersistsRealMutation() {
  const calls = {
    forceFlag: null,
    recordGraphMutation: 0,
    recordMaintenanceAction: 0,
  };
  const graph = { nodes: [], historyState: {} };

  const result = await onManualCompressController({
    getCurrentGraph: () => graph,
    ensureGraphMutationReady: () => true,
    getSchema: () => [{ id: "event", compression: { mode: "hierarchical" } }],
    inspectCompressionCandidates: () => ({
      hasCandidates: true,
      reason: "",
    }),
    cloneGraphSnapshot: (value) => JSON.parse(JSON.stringify(value ?? null)),
    compressAll: async (_graph, _schema, _embeddingConfig, force) => {
      calls.forceFlag = force;
      return { created: 1, archived: 2 };
    },
    getEmbeddingConfig: () => ({}),
    getSettings: () => ({}),
    recordMaintenanceAction() {
      calls.recordMaintenanceAction += 1;
    },
    recordGraphMutation: async () => {
      calls.recordGraphMutation += 1;
    },
    buildMaintenanceSummary: () => "手动压缩",
    toastr: {
      info() {},
      success() {},
    },
  });

  assert.equal(calls.forceFlag, true);
  assert.equal(calls.recordMaintenanceAction, 1);
  assert.equal(calls.recordGraphMutation, 1);
  assert.equal(result?.handledToast, true);
  assert.equal(result?.requestDispatched, true);
  assert.equal(result?.mutated, true);
}

async function testManualEvolveFallsBackToLatestExtractionBatchAfterRefresh() {
  const graph = {
    nodes: [
      {
        id: "evt-1",
        type: "event",
        archived: false,
        level: 0,
      },
    ],
    historyState: {
      extractionCount: 3,
    },
    batchJournal: [
      {
        stateBefore: {
          extractionCount: 3,
        },
        createdNodeIds: ["compression-1"],
      },
      {
        stateBefore: {
          extractionCount: 2,
        },
        createdNodeIds: ["evt-1"],
      },
    ],
  };
  let receivedCandidateIds = null;
  let recordGraphMutationCalls = 0;
  const toastMessages = [];

  const result = await onManualEvolveController({
    getCurrentGraph: () => graph,
    ensureGraphMutationReady: () => true,
    getEmbeddingConfig: () => ({ mode: "direct" }),
    validateVectorConfig: () => ({ valid: true }),
    getLastExtractedItems: () => [],
    cloneGraphSnapshot: (value) => JSON.parse(JSON.stringify(value ?? null)),
    getSettings: () => ({
      consolidationNeighborCount: 5,
      consolidationThreshold: 0.85,
    }),
    consolidateMemories: async ({ newNodeIds }) => {
      receivedCandidateIds = [...newNodeIds];
      return {
        merged: 0,
        skipped: 0,
        kept: 1,
        evolved: 0,
        connections: 0,
        updates: 0,
      };
    },
    recordMaintenanceAction() {
      throw new Error("keep-only 结果不应写入维护账本");
    },
    recordGraphMutation: async () => {
      recordGraphMutationCalls += 1;
    },
    toastr: {
      info(message) {
        toastMessages.push(["info", message]);
      },
      success(message) {
        toastMessages.push(["success", message]);
      },
      warning(message) {
        toastMessages.push(["warning", message]);
      },
    },
  });

  assert.deepEqual(receivedCandidateIds, ["evt-1"]);
  assert.equal(recordGraphMutationCalls, 0);
  assert.equal(result?.handledToast, true);
  assert.equal(result?.requestDispatched, true);
  assert.equal(result?.mutated, false);
  assert.match(String(toastMessages[0]?.[1] || ""), /最近一批提取落盘/);
}

async function testManualEvolveWarnsOnInvalidVectorConfigInsteadOfPretendingComplete() {
  let consolidateCalls = 0;
  const toastMessages = [];

  const result = await onManualEvolveController({
    getCurrentGraph: () => ({
      nodes: [{ id: "evt-2", type: "event", archived: false, level: 0 }],
      historyState: { extractionCount: 1 },
      batchJournal: [],
    }),
    ensureGraphMutationReady: () => true,
    getEmbeddingConfig: () => ({ mode: "direct" }),
    validateVectorConfig: () => ({
      valid: false,
      error: "Embedding 配置无效",
    }),
    getLastExtractedItems: () => [{ id: "evt-2" }],
    consolidateMemories: async () => {
      consolidateCalls += 1;
      return {
        merged: 1,
        skipped: 0,
        kept: 0,
        evolved: 0,
        connections: 0,
        updates: 0,
      };
    },
    toastr: {
      warning(message) {
        toastMessages.push(["warning", message]);
      },
      info(message) {
        toastMessages.push(["info", message]);
      },
    },
  });

  assert.equal(consolidateCalls, 0);
  assert.equal(result?.handledToast, true);
  assert.equal(result?.requestDispatched, false);
  assert.match(String(toastMessages[0]?.[1] || ""), /配置无效/);
}

async function testManualSleepExplainsThatItIsLocalOnlyWhenNothingChanges() {
  let recordGraphMutationCalls = 0;
  const toastMessages = [];

  const result = await onManualSleepController({
    getCurrentGraph: () => ({ nodes: [] }),
    ensureGraphMutationReady: () => true,
    cloneGraphSnapshot: (value) => JSON.parse(JSON.stringify(value ?? null)),
    sleepCycle: () => ({ forgotten: 0 }),
    getSettings: () => ({ forgetThreshold: 0.5 }),
    recordMaintenanceAction() {
      throw new Error("无归档时不应写入维护账本");
    },
    recordGraphMutation: async () => {
      recordGraphMutationCalls += 1;
    },
    toastr: {
      info(message) {
        toastMessages.push(["info", message]);
      },
      success(message) {
        toastMessages.push(["success", message]);
      },
    },
  });

  assert.equal(recordGraphMutationCalls, 0);
  assert.equal(result?.handledToast, true);
  assert.equal(result?.requestDispatched, false);
  assert.match(String(toastMessages[0]?.[1] || ""), /不会发送 LLM 请求/);
}

await testCompressorMigratesEdgesToCompressedNode();
await testVectorIndexKeepsDirtyOnDirectPartialEmbeddingFailure();
await testExtractorFailsOnUnknownOperation();
await testExtractorNormalizesFlatCreateOperation();
await testExtractorNormalizesArrayPayloadAndPreservesScopeField();
await testConsolidatorMergeUpdatesSeqRange();
await testConsolidatorMergeFallbackKeepsNodeWhenTargetMissing();
await testBatchJournalVectorDeltaCapturesRecoveryFields();
await testReverseJournalRecoveryPlanLegacyFallback();
await testReverseJournalRecoveryPlanAggregatesDeletesAndReplay();
await testReverseJournalRollbackStateFormsReplayClosure();
await testReverseJournalRecoveryPlanMixedLegacyAndCurrentRetainsRepairSet();
await testBatchStatusStructuralPartialRemainsRecoverable();
await testBatchStatusSemanticFailureDoesNotHideCoreSuccess();
await testAutoConsolidationRunsOnHighDuplicateRiskSingleNode();
await testAutoConsolidationSkipsLowRiskSingleNode();
await testAutoCompressionRunsOnlyOnConfiguredInterval();
await testAutoCompressionSkipsWhenNotScheduledOrNoCandidates();
await testBatchStatusFinalizeFailureIsNotCompleteSuccess();
await testProcessedHistoryAdvanceTracksCoreExtractionSuccess();
await testGenerationRecallTransactionDedupesDoubleHookBySameKey();
await testGenerationRecallTransactionDedupesReverseHookOrder();
await testGenerationRecallHistoryModesUseSameBindingAcrossHooks();
await testGenerationRecallFrozenBindingSurvivesCrossHookInputDrift();
await testGenerationRecallSkipsUntilTargetUserFloorAvailable();
await testGenerationRecallBeforeCombineCanUseProvisionalSendIntentBinding();
await testGenerationRecallHostLifecycleSnapshotSurvivesTextareaClearWithoutDomIntent();
await testGenerationRecallAfterCommandsStillSkipsWithoutStableUserFloor();
await testGenerationRecallSendIntentBeatsChatTailAndStaysObservable();
await testGenerationRecallSendIntentWinsOverHostSnapshotStably();
await testGenerationRecallLockedSourceDoesNotDriftWithinTransaction();
await testGenerationRecallSameKeyCanRunAgainImmediatelyAsNewGeneration();
await testGenerationRecallSameKeyCanRunAgainAfterBridgeWindow();
await testBeforeCombineRecallNotSkippedWhenGraphLoadingButRuntimeGraphReadable();
await testGenerationRecallBeforeCombineRunsStandalone();
await testGenerationRecallDryRunPreviewDoesNotTriggerBeforeCombineRecall();
await testGenerationRecallDifferentKeyCanRunAgain();
await testGenerationRecallSkippedStateDoesNotLoopToBeforeCombine();
await testGenerationRecallSentMessageClearsStaleTransactionForSameKey();
await testRegisterCoreEventHooksIsIdempotent();
await testChatChangedDoesNotClearCoreEventBindings();
await testSwipeRoutesToRerollWithoutHistoryRecoveryFallback();
await testMessageSentFallsBackToLatestUserWhenHostMessageIdInvalid();
await testUserMessageRenderedRefreshesRecallUiAfterRealDomRender();
await testCharacterMessageRenderedRefreshesRecallUiAfterAssistantRender();
await testMessageReceivedQueuesExtractionWithoutRuntimeQueueMicrotask();
await testAutoExtractionDefersWhenGraphNotReady();
await testAutoExtractionDefersWhenAlreadyExtracting();
await testAutoExtractionDefersWhenHistoryRecoveryBusy();
await testRemoveNodeHandlesCyclicChildGraph();
await testGenerationRecallAppliesFinalInjectionOncePerTransaction();
await testGenerationRecallDeferredRewriteMutatesFinalMesSendPayload();
await testPersistentRecallDataLayerLifecycleAndCompatibility();
await testPersistentRecallSourceResolutionAndTargetRouting();
await testGenerationRecallFinalInjectionRebindsLatestMatchingUserFloor();
await testGenerationRecallFinalInjectionBackfillsPersistedRecord();
await testGenerationRecallImmediateAfterCommandsBackfillsPersistedRecord();
await testGenerationEndedBackfillsRecentRecallAndSchedulesHideRefresh();
await testRecallCardMountsOnStandardUserMessageDom();
await testRecallCardSkipsMountWithoutStableMessageIndex();
await testRecallCardDelayedDomInsertionEventuallyRenders();
await testRecallCardDelayedStableMessageIndexEventuallyRenders();
await testRecallCardSurvivesLateMessageDomReplacement();
await testRecallCardKeepsRetryingWhenOlderCardsAlreadyRendered();
await testRecallCardPrefersBetterDuplicateMessageAnchor();
await testRecallCardDoesNotMountOnNonUserFloor();
await testRecallCardRefreshCleansLegacyBadgeAndAvoidsDuplicates();
await testRecallCardExpandedContentRerendersAfterRecordUpdate();
await testRecallCardUserTextRefreshesWithoutCardRecreate();
await testRecallCardDisplayModeToggleRestoresOriginalUserText();
await testRecallSubGraphAndDataLayerEntryPoints();
await testRerollUsesBatchBoundaryRollbackAndPersistsState();
await testHistoryRecoveryAbortClearsVectorRepairState();
await testHistoryRecoveryFallbackFullRebuildCarriesResultCode();
await testHistoryRecoverySuccessRestoresProcessedHashesAfterReplay();
await testHistoryRecoveryFailureCarriesResultCode();
await testRerollRejectsMissingRecoveryPoint();
await testRerollFallsBackToDirectExtractForUnprocessedFloor();
await testRerollPreservesPrefixHashesWhenReextractDoesNotAdvance();
await testLlmDebugSnapshotRedactsSecretsBeforeStorage();
await testEmbeddingUsesConfigTimeoutInsteadOfDefault();
await testLlmOutputRegexCleansResponseBeforeJsonParse();
await testManualCompressSkipsWithoutCandidatesAndDoesNotPretendItRan();
await testManualCompressUsesForcedCompressionAndPersistsRealMutation();
await testManualEvolveFallsBackToLatestExtractionBatchAfterRefresh();
await testManualEvolveWarnsOnInvalidVectorConfigInsteadOfPretendingComplete();
await testManualSleepExplainsThatItIsLocalOnlyWhenNothingChanges();

console.log("p0-regressions tests passed");
