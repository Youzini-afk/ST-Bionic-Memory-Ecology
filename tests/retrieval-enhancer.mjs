import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { addNode, createEmptyGraph, createNode } from "../graph.js";

async function loadEnhancer() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const enhancerPath = path.resolve(__dirname, "../retrieval-enhancer.js");
  const source = await fs.readFile(enhancerPath, "utf8");
  const transformed = `${source
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace(/export function /g, "function ")
    .replace(/export async function /g, "async function ")}
this.exports = {
  applyDiversitySampling,
  createCooccurrenceIndex,
  nmfQueryAnalysis,
  sparseCodeResidual,
  splitIntentSegments,
};
`;

  const context = vm.createContext({
    Math,
    Date,
    console,
    WeakMap,
    Map,
    Set,
    Array,
    Number,
    String,
    JSON,
    embedText: async () => null,
    searchSimilar: () => [],
    getNode(graph, nodeId) {
      return graph.nodes.find((node) => node.id === nodeId) || null;
    },
    isDirectVectorConfig() {
      return true;
    },
  });
  new vm.Script(transformed).runInContext(context);
  return context.exports;
}

const {
  applyDiversitySampling,
  createCooccurrenceIndex,
  nmfQueryAnalysis,
  sparseCodeResidual,
  splitIntentSegments,
} = await loadEnhancer();

const segments = splitIntentSegments("规则一，然后规则二。另外规则三", {
  maxSegments: 4,
});
assert.deepEqual(Array.from(segments), ["规则一", "规则二", "规则三"]);

const diversity = applyDiversitySampling(
  [
    {
      nodeId: "a",
      finalScore: 0.95,
      node: { embedding: [1, 0, 0] },
    },
    {
      nodeId: "b",
      finalScore: 0.9,
      node: { embedding: [0.99, 0.01, 0] },
    },
    {
      nodeId: "c",
      finalScore: 0.85,
      node: { embedding: [0, 1, 0] },
    },
  ],
  { k: 2, qualityWeight: 1.0 },
);
assert.equal(diversity.applied, true);
assert.equal(diversity.selected.length, 2);
assert.ok(Array.from(diversity.selected).some((item) => item.nodeId === "a"));
assert.ok(Array.from(diversity.selected).some((item) => item.nodeId === "c"));

const graph = createEmptyGraph();
const ruleA = createNode({
  type: "rule",
  seq: 1,
  seqRange: [1, 2],
  fields: { title: "规则A" },
});
const ruleB = createNode({
  type: "rule",
  seq: 2,
  seqRange: [2, 3],
  fields: { title: "规则B" },
});
const location = createNode({
  type: "location",
  seq: 2,
  seqRange: [2, 2],
  fields: { name: "酒馆" },
});
addNode(graph, ruleA);
addNode(graph, ruleB);
addNode(graph, location);
graph.batchJournal = [{ processedRange: [2, 2] }];

const cooccurrence = createCooccurrenceIndex(graph, {
  eligibleNodes: graph.nodes,
  maxAnchorsPerBatch: 10,
});
assert.equal(cooccurrence.source, "batchJournal");
assert.equal(cooccurrence.batchCount, 1);
assert.ok(
  (cooccurrence.map.get(ruleA.id) || []).some((item) => item.nodeId === ruleB.id),
);

graph.batchJournal = [];
const fallbackCooccurrence = createCooccurrenceIndex(graph, {
  eligibleNodes: graph.nodes,
  maxAnchorsPerBatch: 10,
});
assert.equal(fallbackCooccurrence.source, "seqRange");
assert.ok(
  (fallbackCooccurrence.map.get(ruleA.id) || []).some(
    (item) => item.nodeId === ruleB.id,
  ),
);

const nmf = nmfQueryAnalysis(
  [0.8, 0.6, 0, 0],
  [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ],
  { nTopics: 2, maxIter: 50 },
);
assert.ok(nmf.semanticDepth >= 0);
assert.ok(nmf.novelty >= 0);

const sparse = sparseCodeResidual(
  [0.8, 0.6, 0, 0],
  [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ],
  { lambda: 0.01, maxIter: 100 },
);
assert.ok(sparse.residualNorm < 0.2);

console.log("retrieval-enhancer tests passed");
