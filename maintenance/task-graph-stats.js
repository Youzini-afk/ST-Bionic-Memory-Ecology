import { getActiveNodes } from "../graph/graph.js";
import { createPromptNodeReferenceMap } from "../prompting/prompt-node-references.js";
import { rankNodesForTaskContext } from "../retrieval/shared-ranking.js";
import { resolveConcurrencyConfig } from "../runtime/concurrency.js";

const DEFAULT_TYPE_LABELS = Object.freeze({
  event: "事件",
  character: "角色",
  location: "地点",
  rule: "规则",
  thread: "主线",
  synopsis: "全局概要（旧）",
  reflection: "反思",
  pov_memory: "主观记忆",
});

function createTypeLabelMap(schema = []) {
  return new Map(
    (Array.isArray(schema) ? schema : [])
      .filter((typeDef) => String(typeDef?.id || "").trim())
      .map((typeDef) => [
        String(typeDef?.id || "").trim(),
        String(typeDef?.label || typeDef?.id || "").trim(),
      ]),
  );
}

function resolveTypeLabel(typeId = "", typeLabelMap = new Map()) {
  const normalizedTypeId = String(typeId || "").trim();
  return (
    typeLabelMap.get(normalizedTypeId) ||
    DEFAULT_TYPE_LABELS[normalizedTypeId] ||
    normalizedTypeId ||
    "节点"
  );
}

function listGraphTypeCounts(activeNodes = [], schema = [], typeLabelMap = new Map()) {
  const safeActiveNodes = Array.isArray(activeNodes) ? activeNodes : [];
  if (Array.isArray(schema) && schema.length > 0) {
    return schema
      .map((typeDef) => {
        const typeId = String(typeDef?.id || "").trim();
        const count = safeActiveNodes.filter((node) => node?.type === typeId).length;
        return {
          typeId,
          label: resolveTypeLabel(typeId, typeLabelMap),
          count,
        };
      })
      .filter((entry) => entry.count > 0);
  }

  const countMap = new Map();
  for (const node of safeActiveNodes) {
    const typeId = String(node?.type || "").trim();
    if (!typeId) continue;
    countMap.set(typeId, (countMap.get(typeId) || 0) + 1);
  }
  return [...countMap.entries()]
    .map(([typeId, count]) => ({
      typeId,
      label: resolveTypeLabel(typeId, typeLabelMap),
      count,
    }))
    .sort((left, right) => left.typeId.localeCompare(right.typeId));
}

export function buildRelevantNodeReferenceMap(
  scoredNodes = [],
  schema = [],
  {
    maxCount = 6,
    prefix = "G",
    maxLength = 28,
  } = {},
) {
  const typeLabelMap = createTypeLabelMap(schema);
  const relevantNodes = (Array.isArray(scoredNodes) ? scoredNodes : [])
    .filter(
      (entry) =>
        entry?.node &&
        !entry.node.archived &&
        ((Number(entry?.vectorScore) || 0) > 0 ||
          (Number(entry?.graphScore) || 0) > 0 ||
          (Number(entry?.lexicalScore) || 0) > 0),
    )
    .slice(0, Math.max(1, maxCount));

  return createPromptNodeReferenceMap(relevantNodes, {
    prefix,
    maxLength,
    buildMeta: ({ entry, node }) => ({
      typeLabel: resolveTypeLabel(node?.type, typeLabelMap),
      score:
        Math.round((Number(entry?.weightedScore ?? entry?.finalScore) || 0) * 1000) /
        1000,
    }),
  });
}

export function buildGraphOverview(
  graph,
  schema = [],
  relevantReferenceMap = null,
  {
    relevantHeading = "与当前任务最相关的既有节点",
  } = {},
) {
  const activeNodes = graph?.nodes
    ?.filter((node) => node && !node.archived)
    ?.sort((left, right) => (left.seq || 0) - (right.seq || 0));
  if (!Array.isArray(activeNodes) || activeNodes.length === 0) {
    return "";
  }

  const typeLabelMap = createTypeLabelMap(schema);
  const typeCounts = listGraphTypeCounts(activeNodes, schema, typeLabelMap);
  const lines = ["### 图谱节点统计"];

  for (const entry of typeCounts) {
    lines.push(`  - ${entry.label}: ${entry.count}`);
  }

  const references = Array.isArray(relevantReferenceMap?.references)
    ? relevantReferenceMap.references
    : [];
  if (references.length > 0) {
    lines.push("", `### ${String(relevantHeading || "与当前任务最相关的既有节点").trim() || "与当前任务最相关的既有节点"}`);
    for (const reference of references) {
      const typeLabel =
        String(reference?.meta?.typeLabel || reference?.meta?.type || "节点").trim() ||
        "节点";
      const label = String(reference?.meta?.label || "—").trim() || "—";
      const score = Number(reference?.meta?.score || 0).toFixed(3);
      lines.push(`  - [${reference.key}|${typeLabel}] ${label} (score=${score})`);
    }
  }

  return lines.join("\n");
}

function normalizeActiveNodes(graph, activeNodes = null) {
  if (Array.isArray(activeNodes)) {
    return activeNodes.filter((node) => node && !node.archived);
  }
  return getActiveNodes(graph).filter((node) => node && !node.archived);
}

export async function buildTaskGraphStats({
  graph,
  schema = [],
  userMessage = "",
  recentMessages = [],
  embeddingConfig,
  signal,
  activeNodes = null,
  rankingOptions = {},
  settings = {},
  relevantHeading = "与当前任务最相关的既有节点",
  maxRelevantNodes = 6,
  prefix = "G",
  maxLabelLength = 28,
} = {}) {
  const normalizedActiveNodes = normalizeActiveNodes(graph, activeNodes);
  const normalizedUserMessage = String(userMessage || "").trim();
  const concurrency = resolveConcurrencyConfig(settings);

  let ranking = null;
  if (graph && normalizedActiveNodes.length > 0 && normalizedUserMessage) {
    ranking = await rankNodesForTaskContext({
      graph,
      userMessage: normalizedUserMessage,
      recentMessages,
      embeddingConfig,
      signal,
      options: {
        activeNodes: normalizedActiveNodes,
        topK: 12,
        diffusionTopK: 48,
        enableContextQueryBlend: false,
        enableMultiIntent: true,
        maxTextLength: 1200,
        vectorQueryConcurrency: concurrency.vectorQueryConcurrency,
        ...rankingOptions,
      },
    });
  }

  const relevantReferenceMap = buildRelevantNodeReferenceMap(
    ranking?.scoredNodes,
    schema,
    {
      maxCount: maxRelevantNodes,
      prefix,
      maxLength: maxLabelLength,
    },
  );

  return {
    ranking,
    relevantReferenceMap,
    graphStats: buildGraphOverview(graph, schema, relevantReferenceMap, {
      relevantHeading,
    }),
  };
}
