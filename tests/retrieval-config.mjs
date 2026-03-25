import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadRetrieve(stubs) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const retrieverPath = path.resolve(__dirname, "../retriever.js");
  const source = await fs.readFile(retrieverPath, "utf8");
  const transformed = `${source
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace("export async function retrieve", "async function retrieve")}
this.retrieve = retrieve;
`;

  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    ...stubs,
  });
  new vm.Script(transformed).runInContext(context);
  return context.retrieve;
}

function createGraph() {
  const nodes = [
    {
      id: "rule-1",
      type: "rule",
      importance: 9,
      createdTime: 1,
      archived: false,
      fields: { title: "规则一" },
      seqRange: [1, 1],
    },
    {
      id: "rule-2",
      type: "rule",
      importance: 7,
      createdTime: 2,
      archived: false,
      fields: { title: "规则二" },
      seqRange: [2, 2],
    },
    {
      id: "rule-3",
      type: "rule",
      importance: 3,
      createdTime: 3,
      archived: false,
      fields: { title: "规则三" },
      seqRange: [3, 3],
    },
  ];
  return { nodes, edges: [] };
}

function createGraphHelpers(graph) {
  return {
    getActiveNodes(target, type = null) {
      const source = target?.nodes || graph.nodes;
      return source.filter(
        (node) => !node.archived && (!type || node.type === type),
      );
    },
    getNode(target, id) {
      return (target?.nodes || graph.nodes).find((node) => node.id === id) || null;
    },
    getNodeEdges(target, nodeId) {
      return (target?.edges || graph.edges).filter(
        (edge) => edge.fromId === nodeId || edge.toId === nodeId,
      );
    },
    buildTemporalAdjacencyMap() {
      return new Map();
    },
  };
}

const schema = [{ id: "rule", label: "规则", alwaysInject: false }];

const state = {
  vectorCalls: [],
  diffusionCalls: [],
  llmCalls: [],
  llmCandidateCount: 0,
};

const graph = createGraph();
const helpers = createGraphHelpers(graph);
const retrieve = await loadRetrieve({
  ...helpers,
  buildTaskPrompt() {
    return { systemPrompt: "" };
  },
  applyTaskRegex(_settings, _taskType, _stage, text) {
    return text;
  },
  hybridScore: ({ graphScore = 0, vectorScore = 0, importance = 0 }) =>
    graphScore + vectorScore + importance,
  reinforceAccessBatch() {},
  validateVectorConfig() {
    return { valid: true };
  },
  async findSimilarNodesByText(_graph, _message, _embeddingConfig, topK) {
    state.vectorCalls.push(topK);
    return [
      { nodeId: "rule-1", score: 0.9 },
      { nodeId: "rule-2", score: 0.8 },
      { nodeId: "rule-3", score: 0.7 },
    ];
  },
  diffuseAndRank(_adjacencyMap, seeds, options) {
    state.diffusionCalls.push({ seeds, options });
    return [
      { nodeId: "rule-2", energy: 1.2 },
      { nodeId: "rule-3", energy: 0.9 },
    ];
  },
  async callLLMForJSON({ userPrompt }) {
    state.llmCalls.push(userPrompt);
    state.llmCandidateCount = userPrompt
      .split("\n")
      .filter((line) => line.trim().startsWith("[")).length;
    return { selected_ids: ["rule-2", "rule-1"] };
  },
});

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
const noStageResult = await retrieve({
  graph,
  userMessage: "只看当前规则",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 2,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
  },
});
assert.equal(state.vectorCalls.length, 0);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCalls.length, 0);
assert.deepEqual(Array.from(noStageResult.selectedNodeIds), ["rule-1", "rule-2"]);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmCandidateCount = 0;
const llmPoolResult = await retrieve({
  graph,
  userMessage: "请根据规则给出结论",
  recentMessages: ["用户：现在该怎么做？"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.deepEqual(state.vectorCalls, [4]);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCandidateCount, 2);
assert.deepEqual(Array.from(llmPoolResult.selectedNodeIds), ["rule-2", "rule-1"]);
assert.equal(llmPoolResult.meta.retrieval.llm.status, "llm");
assert.equal(llmPoolResult.meta.retrieval.llm.candidatePool, 2);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
await retrieve({
  graph,
  userMessage: "规则一和规则二有什么关联",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 3,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: true,
    diffusionTopK: 7,
    enableLLMRecall: false,
  },
});
assert.deepEqual(state.vectorCalls, [3]);
assert.equal(state.diffusionCalls.length, 1);
assert.equal(state.diffusionCalls[0].options.topK, 7);
assert.equal(noStageResult.meta.retrieval.llm.status, "disabled");

console.log("retrieval-config tests passed");
