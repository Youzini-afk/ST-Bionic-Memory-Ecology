// ST-BME restrained rebirth — durable graph snapshot schema contract tests.
//
// Locks the forward-compatibility discipline: frozen top-level keys, explicit
// schemaVersion, tolerant parsing (unknown nested fields preserved), and that
// the real durable buildSnapshotFromGraph path stamps the top-level version.

import assert from "node:assert/strict";

import {
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  GRAPH_SNAPSHOT_TOP_LEVEL_KEYS,
  findUnknownTopLevelSnapshotKeys,
  inspectGraphSnapshotContract,
  normalizeGraphSnapshotShape,
  readGraphSnapshotSchemaVersion,
} from "../sync/graph-snapshot-schema.js";
import {
  BME_DB_SCHEMA_VERSION,
  buildSnapshotFromGraph,
} from "../sync/bme-db.js";
import { createEmptyGraph } from "../graph/graph.js";

// 1. Top-level key set is frozen and matches the durable contract.
assert.deepEqual(
  [...GRAPH_SNAPSHOT_TOP_LEVEL_KEYS].sort(),
  ["edges", "meta", "nodes", "schemaVersion", "state", "tombstones"],
);
assert.throws(() => {
  "use strict";
  GRAPH_SNAPSHOT_TOP_LEVEL_KEYS.push("rogue");
});
console.log("  ✓ durable snapshot top-level key set is frozen");

// 2. Tolerant parse preserves unknown nested fields, drops unknown top-level.
const dirty = {
  schemaVersion: 1,
  meta: { schemaVersion: 1, chatId: "chat-a", futureMetaField: { a: 1 } },
  nodes: [{ id: "n1", type: "char", futureNodeField: "keep-me" }],
  edges: [{ id: "e1", fromId: "n1", toId: "n2", futureEdgeField: 7 }],
  tombstones: [{ id: "t1", kind: "node", futureTombField: true }],
  state: { lastProcessedFloor: 3, futureStateField: "keep" },
  rogueTopLevel: "should-be-dropped",
};
const normalized = normalizeGraphSnapshotShape(dirty);
assert.deepEqual(findUnknownTopLevelSnapshotKeys(dirty), ["rogueTopLevel"]);
assert.equal("rogueTopLevel" in normalized, false, "unknown top-level dropped");
assert.equal(normalized.nodes[0].futureNodeField, "keep-me", "unknown node field preserved");
assert.equal(normalized.edges[0].futureEdgeField, 7, "unknown edge field preserved");
assert.equal(normalized.tombstones[0].futureTombField, true, "unknown tombstone field preserved");
assert.equal(normalized.meta.futureMetaField.a, 1, "unknown meta field preserved");
assert.equal(normalized.state.futureStateField, "keep", "unknown state field preserved");
console.log("  ✓ tolerant parse preserves unknown nested fields, drops unknown top-level");

// 3. Malformed input never throws; returns an empty valid snapshot.
for (const bad of [null, undefined, 42, "x", [], true]) {
  const safe = normalizeGraphSnapshotShape(bad);
  const inspection = inspectGraphSnapshotContract(safe);
  assert.equal(inspection.valid, true, "normalized malformed input is contract-valid");
  assert.equal(safe.schemaVersion, GRAPH_SNAPSHOT_SCHEMA_VERSION);
}
console.log("  ✓ malformed input normalizes to an empty valid snapshot without throwing");

// 4. schemaVersion is read from top-level first, then meta fallback.
assert.equal(readGraphSnapshotSchemaVersion({ schemaVersion: 3, meta: { schemaVersion: 1 } }), 3);
assert.equal(readGraphSnapshotSchemaVersion({ meta: { schemaVersion: 2 } }), 2);
assert.equal(readGraphSnapshotSchemaVersion({}), 0);
console.log("  ✓ schemaVersion resolves from top-level then meta fallback");

// 5. The REAL durable path stamps an explicit top-level schemaVersion.
const graph = createEmptyGraph();
const durable = buildSnapshotFromGraph(graph, { chatId: "chat-real" });
const durableInspection = inspectGraphSnapshotContract(durable);
assert.equal(durableInspection.valid, true, "durable snapshot matches frozen contract");
assert.equal(durable.schemaVersion, BME_DB_SCHEMA_VERSION, "durable snapshot has top-level schemaVersion");
assert.equal(durable.meta.schemaVersion, BME_DB_SCHEMA_VERSION, "meta schemaVersion mirrors top-level");
assert.deepEqual(findUnknownTopLevelSnapshotKeys(durable), [], "durable snapshot has no rogue top-level keys");
console.log("  ✓ real buildSnapshotFromGraph stamps explicit top-level schemaVersion");

console.log("graph-snapshot-schema tests passed");
