import assert from "node:assert/strict";

import {
  buildDialogueFloorMap,
  normalizeDialogueFloorRange,
} from "../maintenance/chat-history.js";
import { onExtractionTaskController } from "../maintenance/extraction-controller.js";
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
  assert.match(result.reason, /退化为从起始楼层到最新重提/);
}

{
  const calls = {
    rollback: [],
    manual: [],
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
    rollbackGraphForReroll: async (fromFloor) => {
      calls.rollback.push(fromFloor);
      return { success: true, effectiveFromFloor: fromFloor };
    },
    onManualExtract: async (options = {}) => {
      calls.manual.push({ ...options });
    },
    toastr: {
      warning() {},
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
