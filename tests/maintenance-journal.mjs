import assert from "node:assert/strict";

import {
  appendMaintenanceJournal,
  createMaintenanceJournalEntry,
  normalizeGraphRuntimeState,
  undoLatestMaintenance,
} from "../runtime-state.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildNode(id, extra = {}) {
  return {
    id,
    type: "character",
    archived: false,
    seq: 1,
    seqRange: [1, 1],
    importance: 5,
    fields: {},
    childIds: [],
    parentId: null,
    prevId: null,
    nextId: null,
    ...extra,
  };
}

function buildEdge(id, fromId, toId, extra = {}) {
  return {
    id,
    fromId,
    toId,
    relation: "related",
    strength: 1,
    ...extra,
  };
}

{
  const before = {
    nodes: [buildNode("sleep-1")],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;

  const graph = normalizeGraphRuntimeState(clone(after), "chat-sleep");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "sleep",
    mode: "manual",
    summary: "手动遗忘：归档 1 个节点",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(graph.nodes[0].archived, false);
  assert.equal(graph.maintenanceJournal.length, 0);
}

{
  const before = {
    nodes: [
      buildNode("child-1"),
      buildNode("child-2"),
      buildNode("location-1", { type: "location", fields: { title: "大厅" } }),
    ],
    edges: [buildEdge("edge-old", "child-1", "location-1")],
  };
  const after = clone(before);
  after.nodes[0].archived = true;
  after.nodes[0].parentId = "parent-1";
  after.nodes[1].archived = true;
  after.nodes[1].parentId = "parent-1";
  after.nodes.push(
    buildNode("parent-1", {
      level: 1,
      fields: { summary: "压缩父节点" },
      childIds: ["child-1", "child-2"],
    }),
  );
  after.edges.push(buildEdge("edge-new", "parent-1", "location-1"));

  const graph = normalizeGraphRuntimeState(clone(after), "chat-compress");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "compress",
    mode: "manual",
    summary: "手动压缩：新建 1，归档 2",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(graph.nodes.some((node) => node.id === "parent-1"), false);
  assert.equal(
    graph.edges.some((edge) => edge.id === "edge-new"),
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "child-1")?.archived,
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "child-2")?.archived,
    false,
  );
}

{
  const before = {
    nodes: [
      buildNode("new-1", { fields: { summary: "新线索" } }),
      buildNode("old-1", { fields: { summary: "旧描述" } }),
    ],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;
  after.nodes[1].fields.summary = "被新信息修正后的旧描述";
  after.edges.push(buildEdge("edge-merge", "new-1", "old-1"));

  const graph = normalizeGraphRuntimeState(clone(after), "chat-consolidate");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "consolidate",
    mode: "manual",
    summary: "手动整合：合并 1，更新 1",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(
    graph.nodes.find((node) => node.id === "new-1")?.archived,
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "old-1")?.fields?.summary,
    "旧描述",
  );
  assert.equal(
    graph.edges.some((edge) => edge.id === "edge-merge"),
    false,
  );
}

{
  const before = {
    nodes: [buildNode("sleep-2")],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;

  const graph = normalizeGraphRuntimeState(clone(after), "chat-diverged");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "sleep",
    mode: "manual",
    summary: "手动遗忘：归档 1 个节点",
  });

  appendMaintenanceJournal(graph, entry);
  graph.nodes[0].importance = 9;

  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, false);
  assert.match(result.reason, /当前状态已变化|已被后续操作改写/);
  assert.equal(graph.maintenanceJournal.length, 1);
}

console.log("maintenance-journal tests passed");
