import assert from "node:assert/strict";

import {
  addNode,
  createEmptyGraph,
  createNode,
  deserializeGraph,
  serializeGraph,
} from "../graph/graph.js";
import {
  appendSummaryEntry,
  getActiveSummaryEntries,
  markSummaryEntriesFolded,
} from "../graph/summary-state.js";
import { buildGraphFromSnapshot, buildSnapshotFromGraph } from "../sync/bme-db.js";

const emptyGraph = createEmptyGraph();
assert.ok(emptyGraph.summaryState);
assert.equal(emptyGraph.summaryState.enabled, true);
assert.deepEqual(emptyGraph.summaryState.activeEntryIds, []);

const legacyGraph = createEmptyGraph();
addNode(
  legacyGraph,
  createNode({
    type: "synopsis",
    seq: 12,
    fields: {
      summary: "旧版概要节点：钟楼调查从线索确认推进到准备下探。",
    },
  }),
);
delete legacyGraph.summaryState;
const reloadedLegacyGraph = deserializeGraph(serializeGraph(legacyGraph));
assert.equal(getActiveSummaryEntries(reloadedLegacyGraph).length, 1);
assert.equal(
  getActiveSummaryEntries(reloadedLegacyGraph)[0].kind,
  "legacy-import",
);

const clearedLegacyGraph = createEmptyGraph();
addNode(
  clearedLegacyGraph,
  createNode({
    type: "synopsis",
    seq: 18,
    fields: {
      summary: "旧概要不应在显式空 summaryState 下自动复活。",
    },
  }),
);
clearedLegacyGraph.summaryState = {
  version: 1,
  enabled: true,
  entries: [],
  activeEntryIds: [],
  lastSummarizedExtractionCount: 0,
  lastSummarizedAssistantFloor: -1,
};
const clearedReloadedGraph = deserializeGraph(serializeGraph(clearedLegacyGraph));
assert.equal(getActiveSummaryEntries(clearedReloadedGraph).length, 0);

const graph = createEmptyGraph();
const first = appendSummaryEntry(graph, {
  level: 0,
  kind: "small",
  text: "第一条小总结",
  extractionRange: [1, 3],
  messageRange: [2, 7],
});
const second = appendSummaryEntry(graph, {
  level: 0,
  kind: "small",
  text: "第二条小总结",
  extractionRange: [4, 6],
  messageRange: [8, 13],
});
assert.deepEqual(
  getActiveSummaryEntries(graph).map((entry) => entry.id),
  [first.id, second.id],
);
assert.equal(markSummaryEntriesFolded(graph, [first.id]), 1);
assert.deepEqual(
  getActiveSummaryEntries(graph).map((entry) => entry.id),
  [second.id],
);

const snapshot = buildSnapshotFromGraph(graph, {
  chatId: "summary-chat",
  revision: 3,
});
const restoredGraph = buildGraphFromSnapshot(snapshot, {
  chatId: "summary-chat",
});
assert.equal(getActiveSummaryEntries(restoredGraph).length, 1);
assert.equal(getActiveSummaryEntries(restoredGraph)[0].text, "第二条小总结");
assert.equal(
  restoredGraph.summaryState.entries.some((entry) => entry.id === first.id && entry.status === "folded"),
  true,
);

console.log("summary-state tests passed");
