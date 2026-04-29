import assert from "node:assert/strict";

import {
  buildDialogueFloorMap,
  normalizeDialogueFloorRange,
} from "../maintenance/chat-history.js";
import {
  onExtractionTaskController,
  onManualExtractController,
} from "../maintenance/extraction-controller.js";
import { onRebuildSummaryStateController } from "../ui/ui-actions-controller.js";

const chat = [
  { is_system: true, is_user: false, mes: "greeting" },
  { is_user: true, mes: "user-1" },
  { is_user: false, mes: "assistant-1" },
  { is_system: true, is_user: false, mes: "real-system" },
  {
    is_system: true,
    is_user: false,
    mes: "managed-hidden-assistant",
    extra: { __st_bme_hide_managed: true },
  },
  { is_user: true, mes: "user-2" },
  { is_user: false, mes: "assistant-2" },
];

{
  const mapping = buildDialogueFloorMap(chat);
  assert.equal(mapping.latestDialogueFloor, 5);
  assert.deepEqual(Array.from(mapping.floorToChatIndex), [0, 1, 2, 4, 5, 6]);
  assert.equal(mapping.floorToRole[0], "greeting");
  assert.deepEqual(Array.from(mapping.assistantDialogueFloors), [2, 3, 5]);
  assert.deepEqual(Array.from(mapping.assistantChatIndices), [2, 4, 6]);
}

{
  const normalized = normalizeDialogueFloorRange(chat, 2, null);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.startFloor, 2);
  assert.equal(normalized.endFloor, 5);
}

{
  const normalized = normalizeDialogueFloorRange(chat, null, 4);
  assert.equal(normalized.valid, false);
  assert.equal(normalized.reason, "end-without-start");
}

{
  const calls = {
    rollback: [],
    manual: [],
    warning: [],
    info: [],
    extractionStatus: [],
  };
  const runtime = {
    getContext() {
      return { chat };
    },
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    setRuntimeStatus() {},
    setLastExtractionStatus(text, meta, level) {
      calls.extractionStatus.push({ text, meta, level });
    },
    rollbackGraphForReroll: async (fromFloor) => {
      calls.rollback.push(fromFloor);
      return { success: true, effectiveFromFloor: fromFloor };
    },
    onManualExtract: async (options = {}) => {
      calls.manual.push({ ...options });
    },
    toastr: {
      warning(message) {
        calls.warning.push(String(message || ""));
      },
      info(message) {
        calls.info.push(String(message || ""));
      },
    },
  };

  const result = await onExtractionTaskController(runtime, {
    mode: "rerun",
    startFloor: 2,
    endFloor: 2,
  });

  assert.equal(result.success, true);
  assert.equal(result.fallbackToLatest, true);
  assert.deepEqual(calls.rollback, [2]);
  assert.equal(calls.manual.length, 1);
  assert.equal(calls.manual[0].lockedEndFloor, null);
  assert.equal(calls.manual[0].taskLabel, "重新提取");
  assert.equal(calls.manual[0].showStartToast, false);
  assert.equal(calls.extractionStatus[0]?.text, "重新提取准备中");
  assert.match(calls.extractionStatus[0]?.meta || "", /退化为从 2 到最新重提/);
  assert.equal(calls.extractionStatus[1]?.text, "重新提取中");
  assert.match(calls.extractionStatus[1]?.meta || "", /正在开始重新提取/);
  assert.match(result.reason, /退化为从起始楼层到最新重提/);
}

{
  const calls = {
    rollback: [],
    manual: [],
    extractionStatus: [],
    warning: [],
  };
  const runtime = {
    getContext() {
      return { chat };
    },
    getSettings() {
      return {
        hideOldMessagesEnabled: true,
        hideOldMessagesKeepLastN: 2,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 4,
      };
    },
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    setRuntimeStatus() {},
    setLastExtractionStatus(text, meta, level) {
      calls.extractionStatus.push({ text, meta, level });
    },
    rollbackGraphForReroll: async (fromFloor) => {
      calls.rollback.push(fromFloor);
      return { success: true, effectiveFromFloor: fromFloor };
    },
    onManualExtract: async (options = {}) => {
      calls.manual.push({ ...options });
    },
    toastr: {
      warning(message) {
        calls.warning.push(String(message || ""));
      },
      info() {},
    },
  };

  const result = await onExtractionTaskController(runtime, {
    mode: "rerun",
  });

  assert.equal(result.success, true);
  assert.equal(result.fallbackToLatest, false);
  assert.deepEqual(calls.rollback, [6]);
  assert.equal(calls.manual[0].lockedEndFloor, 6);
  assert.equal(calls.manual[0].suppressIntermediateAutoConsolidation, true);
  assert.equal(calls.manual[0].showStartToast, false);
  assert.equal(calls.extractionStatus[0]?.text, "重新提取准备中");
  assert.match(calls.extractionStatus[0]?.meta || "", /旧楼层隐藏/);
  assert.match(calls.extractionStatus[0]?.meta || "", /渲染楼层限制/);
  assert.match(calls.warning[0] || "", /解除消息隐藏/);
  assert.match(result.visibilityWarning || "", /渲染楼层限制/);
}

{
  const statuses = [];
  const executeCalls = [];
  let lastProcessedAssistantFloor = -1;
  const runtime = {
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    getCurrentGraph() {
      return { historyState: {} };
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      return [2, 6];
    },
    getLastProcessedAssistantFloor() {
      return lastProcessedAssistantFloor;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    clampInt(value, fallback, min, max) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(numeric)));
    },
    setIsExtracting() {},
    beginStageAbortController() {
      return { signal: null };
    },
    finishStageAbortController() {},
    setLastExtractionStatus(text, meta, level) {
      statuses.push({ text, meta, level });
    },
    async executeExtractionBatch(options = {}) {
      executeCalls.push(options);
      const endIdx = options.endIdx;
      lastProcessedAssistantFloor = endIdx;
      return {
        success: true,
        result: {
          newNodes: 1,
          updatedNodes: 0,
          newEdges: 1,
        },
        effects: {
          warnings: [],
        },
        historyAdvanceAllowed: true,
      };
    },
    isAbortError() {
      return false;
    },
    refreshPanelLiveState() {},
    retryPendingGraphPersist: async () => ({ accepted: true }),
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
  };

  await onManualExtractController(runtime, {
    taskLabel: "重新提取",
    toastTitle: "ST-BME 重新提取",
    showStartToast: false,
    suppressIntermediateAutoConsolidation: true,
  });

  assert.equal(statuses[0]?.text, "重新提取中");
  assert.match(statuses[0]?.meta || "", /待处理 AI 回复 2 条/);
  assert.ok(
    statuses.some(
      (entry) =>
        entry.text === "重新提取中" &&
        /已处理 1\/2 条 AI 回复/.test(entry.meta || ""),
    ),
  );
  assert.equal(statuses[statuses.length - 1]?.text, "重新提取完成");
  assert.equal(executeCalls.length, 2);
  assert.equal(
    executeCalls[0]?.postProcessContext?.suppressAutoConsolidation,
    true,
  );
  assert.equal(executeCalls[0]?.postProcessContext?.remainingAssistantTurnsAfterBatch, 1);
  assert.equal(executeCalls[1]?.postProcessContext, null);
}

{
  const executeCalls = [];
  let lastProcessedAssistantFloor = -1;
  const assistantTurns = [2, 4, 6, 8];
  const runtime = {
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    getCurrentGraph() {
      return { historyState: {} };
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      return assistantTurns;
    },
    getLastProcessedAssistantFloor() {
      return lastProcessedAssistantFloor;
    },
    getSettings() {
      return { extractEvery: 1, bulkAutoConsolidationEveryBatches: 2 };
    },
    clampInt(value, fallback, min, max) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(numeric)));
    },
    setIsExtracting() {},
    beginStageAbortController() {
      return { signal: null };
    },
    finishStageAbortController() {},
    setLastExtractionStatus() {},
    async executeExtractionBatch(options = {}) {
      executeCalls.push(options);
      lastProcessedAssistantFloor = options.endIdx;
      return {
        success: true,
        result: {
          newNodes: 1,
          newNodeIds: [`node-${options.endIdx}`],
          updatedNodes: 0,
          newEdges: 1,
        },
        effects: {
          warnings: [],
        },
        historyAdvanceAllowed: true,
      };
    },
    isAbortError() {
      return false;
    },
    refreshPanelLiveState() {},
    retryPendingGraphPersist: async () => ({ accepted: true }),
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
  };

  await onManualExtractController(runtime, {
    taskLabel: "重新提取",
    toastTitle: "ST-BME 重新提取",
    showStartToast: false,
    suppressIntermediateAutoConsolidation: true,
  });

  assert.equal(executeCalls.length, 4);
  assert.equal(
    executeCalls[0]?.postProcessContext?.suppressAutoConsolidation,
    true,
  );
  assert.equal(
    executeCalls[1]?.postProcessContext?.suppressAutoConsolidation,
    false,
  );
  assert.deepEqual(
    executeCalls[1]?.postProcessContext?.pendingAutoConsolidationNodeIds,
    ["node-2"],
  );
  assert.equal(
    executeCalls[2]?.postProcessContext?.suppressAutoConsolidation,
    true,
  );
  assert.equal(
    executeCalls[3]?.postProcessContext?.suppressAutoConsolidation,
    false,
  );
  assert.deepEqual(
    executeCalls[3]?.postProcessContext?.pendingAutoConsolidationNodeIds,
    ["node-6"],
  );
}

{
  const captured = [];
  const runtime = {
    getCurrentGraph() {
      return {};
    },
    ensureGraphMutationReady() {
      return true;
    },
    getContext() {
      return { chat };
    },
    getSettings() {
      return {};
    },
    rebuildHierarchicalSummaryState: async (payload) => {
      captured.push(payload);
      return { rebuilt: false, reason: "noop" };
    },
    saveGraphToChat() {},
    refreshPanelLiveState() {},
    setRuntimeStatus() {},
    toastr: {
      info() {},
      success() {},
    },
  };

  await onRebuildSummaryStateController(runtime, {});
  await onRebuildSummaryStateController(runtime, { startFloor: 1, endFloor: 3 });

  assert.equal(captured[0].mode, "current");
  assert.equal(captured[0].startFloor, null);
  assert.equal(captured[1].mode, "range");
  assert.equal(captured[1].startFloor, 1);
  assert.equal(captured[1].endFloor, 3);
}

console.log("dialogue-floor-range-tasks tests passed");
