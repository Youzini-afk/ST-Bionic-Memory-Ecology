import { recordsEqual } from "../core/change-set.js";
import { createEmptyGraph } from "../../graph/graph.js";

export const GRAPH_RUNTIME_ID = "runtime";

function jsonClone(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("graph records must be JSON-compatible");
  return JSON.parse(text);
}

function recordMap(records, label) {
  const map = new Map();
  for (const record of records) {
    const id = String(record?.id || "").trim();
    if (!id) throw new TypeError(`${label} record requires an id`);
    if (map.has(id)) throw new TypeError(`duplicate ${label} record ${id}`);
    map.set(id, jsonClone(record));
  }
  return map;
}

function orderedRecords(records, order = []) {
  const pending = new Map(records);
  const result = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (!pending.has(id)) continue;
    result.push(pending.get(id));
    pending.delete(id);
  }
  result.push(...[...pending.values()].sort((left, right) =>
    String(left.id).localeCompare(String(right.id))));
  return result;
}

export function materializeGraph(state) {
  const runtime = state?.collections?.graphState?.get(GRAPH_RUNTIME_ID) || null;
  const graph = runtime
    ? jsonClone(Object.fromEntries(
        Object.entries(runtime).filter(([key]) =>
          key !== "id" && key !== "nodeOrder" && key !== "edgeOrder"),
      ))
    : createEmptyGraph();
  graph.historyState ||= {};
  graph.historyState.chatId = String(state?.head?.chatKey || graph.historyState.chatId || "");
  graph.nodes = orderedRecords(
    state?.collections?.nodes || new Map(),
    runtime?.nodeOrder,
  );
  graph.edges = orderedRecords(
    state?.collections?.edges || new Map(),
    runtime?.edgeOrder,
  );
  return graph;
}

export function graphRecords(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new TypeError("graph must be an object");
  }
  const nodes = recordMap(Array.isArray(graph.nodes) ? graph.nodes : [], "node");
  const edges = recordMap(Array.isArray(graph.edges) ? graph.edges : [], "edge");
  const runtime = jsonClone(Object.fromEntries(
    Object.entries(graph).filter(([key]) => key !== "nodes" && key !== "edges"),
  ));
  runtime.id = GRAPH_RUNTIME_ID;
  runtime.nodeOrder = [...nodes.keys()];
  runtime.edgeOrder = [...edges.keys()];
  return {
    nodes,
    edges,
    graphState: new Map([[GRAPH_RUNTIME_ID, runtime]]),
  };
}

export function diffGraphs(beforeGraph, afterGraph) {
  const before = graphRecords(beforeGraph);
  const after = graphRecords(afterGraph);
  return diffRecordCollections(before, after);
}

function diffRecordCollections(before, after) {
  const changes = [];
  for (const collection of ["nodes", "edges", "graphState"]) {
    const ids = new Set([...before[collection].keys(), ...after[collection].keys()]);
    for (const id of ids) {
      const beforeRecord = before[collection].get(id) || null;
      const afterRecord = after[collection].get(id) || null;
      if (recordsEqual(beforeRecord, afterRecord)) continue;
      changes.push({ collection, id, before: beforeRecord, after: afterRecord });
    }
  }
  return { changes };
}

export function diffStateGraph(state, afterGraph) {
  const before = Object.fromEntries(
    ["nodes", "edges", "graphState"].map((collection) => [
      collection,
      new Map(state?.collections?.[collection] || []),
    ]),
  );
  return diffRecordCollections(before, graphRecords(afterGraph));
}

export async function planGraphMutation(state, mutate) {
  if (typeof mutate !== "function") throw new TypeError("mutate must be a function");
  const beforeGraph = materializeGraph(state);
  const draft = structuredClone(beforeGraph);
  const result = await mutate(draft);
  const domainChanges = diffGraphs(beforeGraph, draft);
  return {
    result,
    graph: draft,
    changeSet: domainChanges.changes.length > 0
      ? diffStateGraph(state, draft)
      : domainChanges,
  };
}
