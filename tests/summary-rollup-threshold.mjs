import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '',",
  "    name2: '',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
].join("\n");

const openAiShimSource = [
  "export const chat_completion_sources = { OPENAI: 'openai' };",
  "export async function sendOpenAIRequest() {",
  "  throw new Error('sendOpenAIRequest should not be called in summary-rollup-threshold test');",
  "}",
].join("\n");

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
  {
    specifiers: [
      "../../../openai.js",
      "../../../../openai.js",
    ],
    url: toDataModuleUrl(openAiShimSource),
  },
]);

const { createEmptyGraph } = await import("../graph/graph.js");
const { appendSummaryEntry } = await import("../graph/summary-state.js");
const { rollupSummaryFrontier } = await import("../maintenance/hierarchical-summary.js");

const graph = createEmptyGraph();

appendSummaryEntry(graph, {
  id: "summary-a",
  level: 0,
  kind: "small",
  text: "第一条小总结",
  messageRange: [1, 2],
  extractionRange: [1, 1],
});
appendSummaryEntry(graph, {
  id: "summary-b",
  level: 0,
  kind: "small",
  text: "第二条小总结",
  messageRange: [3, 4],
  extractionRange: [2, 2],
});
appendSummaryEntry(graph, {
  id: "summary-c",
  level: 0,
  kind: "small",
  text: "第三条小总结",
  messageRange: [5, 6],
  extractionRange: [3, 3],
});

const result = await rollupSummaryFrontier({
  graph,
  settings: {
    summaryRollupFanIn: 3,
  },
  force: false,
});

assert.equal(result.createdCount, 0);
assert.equal(result.foldedCount, 0);
assert.equal(result.skipped, true);
assert.match(String(result.reason || ""), /超过 3 条同层活跃总结/);

console.log("summary-rollup-threshold tests passed");
