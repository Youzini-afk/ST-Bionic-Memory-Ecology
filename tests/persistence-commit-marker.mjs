import assert from "node:assert/strict";

import {
  buildGraphCommitMarker,
  detectIndexedDbSnapshotCommitMarkerMismatch,
  getAcceptedCommitMarkerRevision,
  GRAPH_COMMIT_MARKER_KEY,
  normalizeGraphCommitMarker,
  readGraphCommitMarker,
  writeChatMetadataPatch,
} from "../graph/graph-persistence.js";
import { addNode, createEmptyGraph, createNode } from "../graph/graph.js";

const graph = createEmptyGraph();
graph.historyState.chatId = "chat-marker";
graph.historyState.lastProcessedAssistantFloor = 10;
graph.historyState.extractionCount = 4;
addNode(
  graph,
  createNode({
    type: "event",
    fields: { title: "事件A", summary: "测试事件" },
    seq: 10,
  }),
);

const marker = buildGraphCommitMarker(graph, {
  revision: 12,
  storageTier: "indexeddb",
  accepted: true,
  reason: "unit-test",
});
assert.equal(marker.revision, 12);
assert.equal(marker.accepted, true);
assert.equal(marker.lastProcessedAssistantFloor, 10);
assert.equal(marker.extractionCount, 4);
assert.equal(marker.nodeCount, 1);
assert.equal(marker.edgeCount, 0);
assert.equal(marker.archivedCount, 0);
assert.equal(getAcceptedCommitMarkerRevision(marker), 12);

const normalized = normalizeGraphCommitMarker({
  revision: "15",
  lastProcessedAssistantFloor: "18",
  extractionCount: "6",
  nodeCount: "9",
  edgeCount: "3",
  archivedCount: "2",
  storageTier: "shadow",
  accepted: true,
  reason: "normalized",
});
assert.equal(normalized.revision, 15);
assert.equal(normalized.lastProcessedAssistantFloor, 18);
assert.equal(normalized.storageTier, "shadow");

const context = {
  chatMetadata: {},
};
writeChatMetadataPatch(context, {
  [GRAPH_COMMIT_MARKER_KEY]: marker,
});
assert.deepEqual(readGraphCommitMarker(context), marker);

const mismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
  {
    meta: {
      revision: 9,
    },
  },
  marker,
);
assert.equal(mismatch.mismatched, true);
assert.equal(
  mismatch.reason,
  "persist-mismatch:indexeddb-behind-commit-marker",
);
assert.equal(mismatch.markerRevision, 12);
assert.equal(mismatch.snapshotRevision, 9);

const noMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
  {
    meta: {
      revision: 12,
    },
  },
  marker,
);
assert.equal(noMismatch.mismatched, false);

console.log("persistence-commit-marker tests passed");
