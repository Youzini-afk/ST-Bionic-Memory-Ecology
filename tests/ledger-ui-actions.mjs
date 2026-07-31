import assert from "node:assert/strict";

import {
  onClearGraphRangeController,
  onImportGraphController,
} from "../ui/ui-actions-controller.js";

function importRuntime(fileText) {
  const calls = { replace: 0, errors: [] };
  const input = {
    onchange: null,
    addEventListener() {},
    click() {
      queueMicrotask(() =>
        this.onchange?.({
          target: {
            files: [{ text: async () => fileText }],
          },
        }),
      );
    },
  };
  return {
    calls,
    runtime: {
      clearInjectionState() {},
      clearTimeout,
      document: { createElement: () => input },
      ensureGraphMutationReady: () => true,
      getAssistantTurns: () => [],
      getContext: () => ({ chat: [] }),
      getCurrentChatId: () => "chat:ui-import",
      importGraph: (text) => JSON.parse(text),
      markVectorStateDirty() {},
      normalizeGraphRuntimeState: (graph, chatId) => ({
        ...graph,
        historyState: { ...(graph.historyState || {}), chatId },
      }),
      async replaceGraphWithLedger(graph) {
        calls.replace += 1;
        return { projection: { graph } };
      },
      setExtractionCount() {},
      setLastExtractedItems() {},
      toastr: {
        success() {},
        error(message) {
          calls.errors.push(String(message || ""));
        },
      },
      updateLastRecalledItems() {},
      window: {
        addEventListener() {},
        removeEventListener() {},
      },
    },
  };
}

{
  const { calls, runtime } = importRuntime("not json");
  await assert.rejects(() => onImportGraphController(runtime), /Unexpected token|JSON/);
  assert.equal(calls.replace, 0);
}

{
  const { calls, runtime } = importRuntime(JSON.stringify({ version: 9, nodes: [] }));
  await assert.rejects(() => onImportGraphController(runtime), /有效的 ST-BME 图谱导出/);
  assert.equal(calls.replace, 0);
}

{
  const { calls, runtime } = importRuntime(JSON.stringify({ version: 9, nodes: [], edges: [] }));
  const result = await onImportGraphController(runtime);
  assert.equal(result.imported, true);
  assert.equal(calls.replace, 1);
}

{
  const calls = [];
  const result = await onClearGraphRangeController(
    {
      confirm: () => true,
      ensureGraphMutationReady: () => true,
      getCurrentGraph: () => ({
        nodes: [
          { id: "memory:inside", seqRange: [3, 5] },
          { id: "memory:outside", seqRange: [9, 9] },
        ],
      }),
      async archiveGraphMemories(memoryIds, options) {
        calls.push({ memoryIds, options });
        return { archivedMemoryIds: memoryIds, archivedRelationIds: [] };
      },
      markVectorStateDirty() {},
      refreshPanelLiveState() {},
      toastr: { success() {}, warning() {} },
    },
    4,
    6,
  );
  assert.equal(result.handledToast, true);
  assert.deepEqual(calls, [
    {
      memoryIds: ["memory:inside"],
      options: { reason: "manual-clear-graph-range" },
    },
  ]);
}

console.log("ledger UI action tests passed");
