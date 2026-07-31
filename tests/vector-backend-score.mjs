import assert from "node:assert/strict";
import { parseBackendVectorQueryResponse } from "../vector/backend-query-result.js";

const mapping = { 11: "memory:a", 22: "memory:b", 33: "memory:c" };
const allowedIds = new Set(Object.values(mapping));

const scored = parseBackendVectorQueryResponse(
  { hashes: [11, 22, 33], scores: [0.32, 0.91, 0.54] },
  { nodeIdByHash: mapping, allowedIds, topK: 3 },
);
assert.equal(scored.scoreSource, "server");
assert.deepEqual(scored.results.map((entry) => entry.nodeId), [
  "memory:b",
  "memory:c",
  "memory:a",
]);
assert.deepEqual(scored.results.map((entry) => entry.score), [0.91, 0.54, 0.32]);

const rich = parseBackendVectorQueryResponse(
  {
    results: [
      { metadata: { hash: 11 }, similarity: 0.82 },
      { hash: 22, score: 0.44 },
    ],
  },
  { nodeIdByHash: mapping, allowedIds, topK: 2 },
);
assert.equal(rich.scoreSource, "server");
assert.deepEqual(rich.results.map((entry) => entry.nodeId), ["memory:a", "memory:b"]);

const distance = parseBackendVectorQueryResponse(
  {
    results: [
      { hash: 11, distance: 0.5 },
      { hash: 22, distance: 0.1 },
      { hash: 33, similarity: -0.2 },
    ],
  },
  { nodeIdByHash: mapping, allowedIds, topK: 3 },
);
assert.equal(distance.scoreSource, "server");
assert.deepEqual(distance.results.map((entry) => entry.nodeId), [
  "memory:b",
  "memory:a",
  "memory:c",
]);
assert.equal(distance.results[0].scoreSource, "server-distance");
assert.equal(distance.results[2].score, 0);

const legacy = parseBackendVectorQueryResponse(
  { hashes: [33, 11, 22] },
  { nodeIdByHash: mapping, allowedIds, topK: 2 },
);
assert.equal(legacy.scoreSource, "rank-fallback");
assert.deepEqual(legacy.results.map((entry) => entry.nodeId), ["memory:c", "memory:a"]);
assert.ok(legacy.results.every((entry) => entry.scoreSource === "rank-fallback"));

console.log("backend vector score tests passed");
