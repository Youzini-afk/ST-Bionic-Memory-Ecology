import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { onManualExtractController } from "../extraction-controller.js";
import { onRebuildController } from "../ui-actions-controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../index.js");
const indexSource = await fs.readFile(indexPath, "utf8");

function extractSnippet(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`无法提取 index.js 片段: ${startMarker} -> ${endMarker}`);
  }
  return indexSource.slice(start, end).replace(/^export\s+/gm, "");
}

const statusSnippet = extractSnippet(
  "function setRuntimeStatus(",
  "function notifyExtractionIssue(",
);
const vectorSnippet = extractSnippet(
  "async function syncVectorState({",
  "async function ensureVectorReadyIfNeeded(",
);
const manualExtractSnippet = extractSnippet(
  "async function onManualExtract(options = {}) {",
  "async function onReroll(",
);
const rebuildSnippet = extractSnippet(
  "async function onRebuild() {",
  "async function onManualCompress() {",
);

function createBaseStatusContext() {
  return {
    console,
    Date,
    createUiStatus(text = "待命", meta = "", level = "idle") {
      return {
        text: String(text || "待命"),
        meta: String(meta || ""),
        level,
        updatedAt: Date.now(),
      };
    },
    runtimeStatus: { text: "待命", meta: "", level: "idle" },
    lastExtractionStatus: { text: "待命", meta: "", level: "idle" },
    lastVectorStatus: { text: "待命", meta: "", level: "idle" },
    lastRecallStatus: { text: "待命", meta: "", level: "idle" },
    lastStatusToastAt: {},
    STATUS_TOAST_THROTTLE_MS: 1500,
    _panelModule: {
      updateFloatingBallStatus() {},
    },
    refreshPanelLiveState() {},
    updateStageNotice() {},
    notifyStatusToast() {},
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
  };
}

function testIndexDefinesLastProcessedAssistantFloorHelper() {
  assert.match(
    indexSource,
    /function\s+getLastProcessedAssistantFloor\s*\(/,
  );
}

async function testVectorSyncTerminalStateUpdatesRuntime() {
  const context = {
    ...createBaseStatusContext(),
    currentGraph: {
      vectorIndexState: {
        dirty: true,
        lastWarning: "",
      },
    },
    ensureCurrentGraphRuntimeState() {
      return context.currentGraph;
    },
    getEmbeddingConfig() {
      return { mode: "direct" };
    },
    validateVectorConfig() {
      return { valid: true };
    },
    async syncGraphVectorIndex() {
      return {
        insertedHashes: [],
        stats: {
          indexed: 12,
          pending: 0,
        },
      };
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getVectorIndexStats() {
      return { indexed: 12, pending: 0 };
    },
    isAbortError() {
      return false;
    },
    markVectorStateDirty() {},
    result: null,
  };
  vm.createContext(context);
  vm.runInContext(
    `${statusSnippet}\n${vectorSnippet}\nresult = { syncVectorState };`,
    context,
    { filename: indexPath },
  );

  const result = await context.result.syncVectorState({ force: true });
  assert.equal(result.stats.indexed, 12);
  assert.equal(context.lastVectorStatus.text, "向量完成");
  assert.equal(context.runtimeStatus.text, "向量完成");
  assert.equal(context.runtimeStatus.level, "success");
}

async function testManualExtractNoBatchesDoesNotStayRunning() {
  let assistantTurnCallCount = 0;
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    isExtracting: false,
    currentGraph: {},
    getCurrentChatId() {
      return "chat-mobile";
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    createEmptyGraph() {
      return {};
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      assistantTurnCallCount += 1;
      return assistantTurnCallCount === 1 ? [1] : [];
    },
    getLastProcessedAssistantFloor() {
      return 0;
    },
    clampInt(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    beginStageAbortController() {
      return { signal: {} };
    },
    async executeExtractionBatch() {
      throw new Error("不应进入批次执行");
    },
    isAbortError() {
      return false;
    },
    onManualExtractController,
    finishStageAbortController() {},
    result: null,
  };
  vm.createContext(context);
  vm.runInContext(
    `${statusSnippet}\n${manualExtractSnippet}\nresult = { onManualExtract };`,
    context,
    { filename: indexPath },
  );

  await context.result.onManualExtract();
  assert.equal(context.isExtracting, false);
  assert.equal(context.lastExtractionStatus.text, "无待提取内容");
  assert.equal(context.runtimeStatus.text, "无待提取内容");
  assert.notEqual(context.runtimeStatus.level, "running");
}

async function testManualRebuildSetsTerminalRuntimeStatus() {
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    __confirmHost: true,
    currentGraph: {
      vectorIndexState: {
        lastWarning: "",
      },
      batchJournal: [],
    },
    confirm() {
      assert.equal(this?.__confirmHost, true);
      return true;
    },
    ensureGraphMutationReady() {
      return true;
    },
    getContext() {
      return { chat };
    },
    cloneGraphSnapshot(graph) {
      return graph;
    },
    snapshotRuntimeUiState() {
      return {};
    },
    getSettings() {
      return {};
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    createEmptyGraph() {
      return {
        vectorIndexState: {
          lastWarning: "",
        },
        batchJournal: [],
      };
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    clearInjectionState() {},
    async prepareVectorStateForReplay() {},
    async replayExtractionFromHistory() {
      context.currentGraph.vectorIndexState.lastWarning = "";
      return 2;
    },
    clearHistoryDirty() {},
    buildRecoveryResult(status, extra = {}) {
      return { status, ...extra };
    },
    saveGraphToChat() {},
    restoreRuntimeUiState() {},
    onRebuildController,
    result: null,
  };
  vm.createContext(context);
  vm.runInContext(
    `${statusSnippet}\n${rebuildSnippet}\nresult = { onRebuild };`,
    context,
    { filename: indexPath },
  );

  await context.result.onRebuild();
  assert.equal(context.lastExtractionStatus.text, "图谱重建完成");
  assert.equal(context.runtimeStatus.text, "图谱重建完成");
  assert.equal(context.runtimeStatus.level, "success");
}

testIndexDefinesLastProcessedAssistantFloorHelper();
await testVectorSyncTerminalStateUpdatesRuntime();
await testManualExtractNoBatchesDoesNotStayRunning();
await testManualRebuildSetsTerminalRuntimeStatus();

console.log("mobile-status-regressions tests passed");
