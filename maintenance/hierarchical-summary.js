import { debugLog } from "../runtime/debug-logging.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { getActiveTaskProfile } from "../prompting/prompt-profiles.js";
import {
  appendSummaryEntry,
  createSummaryEntry,
  createDefaultSummaryState,
  getActiveSummaryEntries,
  markSummaryEntriesFolded,
  normalizeGraphSummaryState,
} from "../graph/summary-state.js";
import { buildSummarySourceMessages } from "./chat-history.js";
import { getSTContextForPrompt } from "../host/st-context.js";
import {
  deriveStoryTimeSpanFromNodes,
  describeNodeStoryTime,
} from "../graph/story-timeline.js";
import { getNode, getActiveNodes } from "../graph/graph.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import { normalizeMemoryScope } from "../graph/memory-scope.js";

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

function createTaskLlmDebugContext(promptBuild, regexInput) {
  return typeof buildTaskExecutionDebugContext === "function"
    ? buildTaskExecutionDebugContext(promptBuild, { regexInput })
    : null;
}

function resolveTaskPromptPayload(promptBuild, fallbackUserPrompt = "") {
  if (typeof buildTaskLlmPayload === "function") {
    return buildTaskLlmPayload(promptBuild, fallbackUserPrompt);
  }

  return {
    systemPrompt: String(promptBuild?.systemPrompt || ""),
    userPrompt: String(fallbackUserPrompt || ""),
    promptMessages: [],
    additionalMessages: Array.isArray(promptBuild?.privateTaskMessages)
      ? promptBuild.privateTaskMessages
      : [],
  };
}

function resolveTaskLlmSystemPrompt(promptPayload, fallbackSystemPrompt = "") {
  const hasPromptMessages =
    Array.isArray(promptPayload?.promptMessages) &&
    promptPayload.promptMessages.length > 0;
  if (hasPromptMessages) {
    return String(promptPayload?.systemPrompt || "");
  }
  return String(promptPayload?.systemPrompt || fallbackSystemPrompt || "");
}

function clampInt(value, fallback = 0, min = 0, max = 999999) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeRange(range, fallback = [-1, -1]) {
  if (!Array.isArray(range) || range.length < 2) {
    return [...fallback];
  }
  const start = Number.isFinite(Number(range[0])) ? Number(range[0]) : fallback[0];
  const end = Number.isFinite(Number(range[1])) ? Number(range[1]) : fallback[1];
  return [start, end];
}

function getSummaryTaskInputConfig(settings = {}, taskType = "synopsis") {
  const profile = getActiveTaskProfile(settings, taskType);
  const input =
    profile?.input && typeof profile.input === "object" && !Array.isArray(profile.input)
      ? profile.input
      : {};
  return {
    rawChatContextFloors: clampInt(input.rawChatContextFloors, 0, 0, 200),
    rawChatSourceMode:
      String(input.rawChatSourceMode || "ignore_bme_hide").trim() ===
      "ignore_bme_hide"
        ? "ignore_bme_hide"
        : "ignore_bme_hide",
  };
}

function buildTranscript(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const seq = Number.isFinite(Number(message?.seq)) ? Number(message.seq) : "?";
      const role = String(message?.role || "assistant").trim() || "assistant";
      return `#${seq} [${role}]: ${String(message?.content || "")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function uniqueIds(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function collectJournalTouchedNodeIds(journal = {}) {
  return uniqueIds([
    ...(Array.isArray(journal?.createdNodeIds) ? journal.createdNodeIds : []),
    ...((Array.isArray(journal?.previousNodeSnapshots)
      ? journal.previousNodeSnapshots
      : []
    ).map((node) => node?.id)),
  ]);
}

function findJournalForExtractionCount(graph, extractionCountBefore) {
  const target = Number(extractionCountBefore);
  const journals = Array.isArray(graph?.batchJournal) ? graph.batchJournal : [];
  for (let index = journals.length - 1; index >= 0; index -= 1) {
    const journal = journals[index];
    if (
      Number(journal?.stateBefore?.extractionCount) === target &&
      Array.isArray(journal?.processedRange)
    ) {
      return journal;
    }
  }
  return null;
}

function buildPseudoCurrentSlice(currentExtractionCount, currentRange, currentNodeIds = []) {
  return {
    id: `summary-pending-${currentExtractionCount}`,
    extractionCountBefore: Math.max(0, currentExtractionCount - 1),
    extractionCountAfter: currentExtractionCount,
    processedRange: normalizeRange(currentRange),
    touchedNodeIds: uniqueIds(currentNodeIds),
  };
}

function buildSliceFromJournal(journal = {}) {
  return {
    id: String(journal?.id || ""),
    extractionCountBefore: clampInt(journal?.stateBefore?.extractionCount, 0, 0, 999999),
    extractionCountAfter:
      clampInt(journal?.stateBefore?.extractionCount, 0, 0, 999999) + 1,
    processedRange: normalizeRange(journal?.processedRange),
    touchedNodeIds: collectJournalTouchedNodeIds(journal),
  };
}

function collectSlicesForSummaryWindow(
  graph,
  {
    lastSummarizedExtractionCount = 0,
    currentExtractionCount = 0,
    currentRange = null,
    currentNodeIds = [],
    includeCurrentPending = false,
  } = {},
) {
  const slices = [];
  const safeLastCount = clampInt(lastSummarizedExtractionCount, 0, 0, 999999);
  const safeCurrentCount = clampInt(currentExtractionCount, 0, 0, 999999);
  const hasCurrentPendingRange =
    includeCurrentPending &&
    Array.isArray(currentRange) &&
    Number.isFinite(Number(currentRange[0])) &&
    Number.isFinite(Number(currentRange[1])) &&
    Number(currentRange[1]) >= Number(currentRange[0]);
  for (
    let beforeCount = safeLastCount;
    beforeCount < safeCurrentCount - (hasCurrentPendingRange ? 1 : 0);
    beforeCount += 1
  ) {
    const journal = findJournalForExtractionCount(graph, beforeCount);
    if (!journal) continue;
    slices.push(buildSliceFromJournal(journal));
  }
  if (hasCurrentPendingRange && safeCurrentCount > safeLastCount) {
    slices.push(
      buildPseudoCurrentSlice(safeCurrentCount, currentRange, currentNodeIds),
    );
  }
  return slices.sort(
    (left, right) => left.extractionCountAfter - right.extractionCountAfter,
  );
}

function collectNodeHints(graph, nodeIds = []) {
  const nodes = uniqueIds(nodeIds)
    .map((nodeId) => getNode(graph, nodeId))
    .filter(Boolean);
  const regionHints = new Set();
  const ownerHints = new Set();
  for (const node of nodes) {
    const scope = normalizeMemoryScope(node?.scope);
    if (scope.regionPrimary) regionHints.add(scope.regionPrimary);
    if (scope.ownerName) ownerHints.add(scope.ownerName);
  }
  return {
    nodes,
    regionHints: [...regionHints],
    ownerHints: [...ownerHints],
  };
}

function describeNodeForSummary(node) {
  if (!node) return "";
  const storyLabel = describeNodeStoryTime(node);
  const prefix = storyLabel ? `[${storyLabel}] ` : "";
  switch (String(node.type || "")) {
    case "event":
      return `${prefix}${node.fields?.title || getNodeDisplayName(node)}: ${node.fields?.summary || "(无摘要)"}`;
    case "character":
      return `${prefix}${node.fields?.name || getNodeDisplayName(node)}: ${node.fields?.state || node.fields?.summary || "(无状态)"}`;
    case "thread":
      return `${prefix}${node.fields?.title || getNodeDisplayName(node)}: ${node.fields?.status || node.fields?.summary || "(无状态)"}`;
    case "pov_memory":
      return `${prefix}${getNodeDisplayName(node)}: ${node.fields?.summary || "(无摘要)"}`;
    default:
      return `${prefix}${getNodeDisplayName(node)}: ${node.fields?.summary || node.fields?.title || node.fields?.name || "(无摘要)"}`;
  }
}

function buildNodeDigest(graph, nodeIds = []) {
  return collectNodeHints(graph, nodeIds).nodes
    .map((node) => describeNodeForSummary(node))
    .filter(Boolean)
    .slice(0, 24)
    .join("\n");
}

function buildFrontierHint(graph) {
  const activeEntries = getActiveSummaryEntries(graph);
  if (activeEntries.length === 0) {
    return "当前还没有活跃总结前沿。";
  }
  return activeEntries
    .slice(-6)
    .map((entry) => {
      const range = normalizeRange(entry.messageRange);
      return `L${entry.level} · 楼 ${range[0]} ~ ${range[1]} · ${String(entry.text || "").slice(0, 90)}`;
    })
    .join("\n");
}

function buildSummaryGraphStats(graph, activeEntries = []) {
  const historyState = graph?.historyState || {};
  const activeRegion = String(historyState.activeRegion || historyState.lastExtractedRegion || "").trim();
  const activeStoryTime = String(
    historyState.activeStoryTimeLabel || historyState.activeStorySegmentId || "",
  ).trim();
  return [
    `active_summary_count=${activeEntries.length}`,
    activeRegion ? `active_region=${activeRegion}` : "",
    activeStoryTime ? `active_story_time=${activeStoryTime}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callSummaryTask({
  settings = {},
  taskType = "synopsis",
  context = {},
  fallbackSystemPrompt = "",
  fallbackUserPrompt = "",
  signal,
}) {
  const promptBuild = await buildTaskPrompt(settings, taskType, {
    taskName: taskType,
    ...context,
    ...getSTContextForPrompt(),
  });
  const regexInput = { entries: [] };
  const systemPrompt = applyTaskRegex(
    settings,
    taskType,
    "finalPrompt",
    promptBuild.systemPrompt || fallbackSystemPrompt,
    regexInput,
    "system",
  );
  const promptPayload = resolveTaskPromptPayload(promptBuild, fallbackUserPrompt);
  return await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(promptPayload, systemPrompt),
    userPrompt: promptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType,
    debugContext: createTaskLlmDebugContext(promptBuild, regexInput),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
  });
}

export async function generateSmallSummary({
  graph,
  chat = [],
  settings = {},
  currentExtractionCount = 0,
  currentAssistantFloor = -1,
  currentRange = [-1, -1],
  currentNodeIds = [],
  signal,
  force = false,
} = {}) {
  normalizeGraphSummaryState(graph);
  const summaryState = createDefaultSummaryState(graph?.summaryState || {});
  graph.summaryState = summaryState;

  const threshold = clampInt(
    settings.smallSummaryEveryNExtractions,
    3,
    1,
    100,
  );
  const deltaCount = Math.max(
    0,
    clampInt(currentExtractionCount, 0, 0, 999999) -
      clampInt(summaryState.lastSummarizedExtractionCount, 0, 0, 999999),
  );
  if (!force && deltaCount < threshold) {
    return {
      created: false,
      skipped: true,
      reason: `当前只累计了 ${deltaCount} 次未总结提取，未到小总结门槛 ${threshold}`,
    };
  }

  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: summaryState.lastSummarizedExtractionCount,
    currentExtractionCount,
    currentRange,
    currentNodeIds,
    includeCurrentPending: true,
  });
  if (slices.length === 0) {
    return {
      created: false,
      skipped: true,
      reason: "当前没有可用于生成小总结的提取批次",
    };
  }

  const firstSlice = slices[0];
  const lastSlice = slices[slices.length - 1];
  const inputConfig = getSummaryTaskInputConfig(settings, "synopsis");
  const messageStart = normalizeRange(firstSlice.processedRange)[0];
  const messageEnd = Math.max(
    normalizeRange(lastSlice.processedRange)[1],
    clampInt(currentAssistantFloor, -1, -1, 999999),
  );
  const sourceMessages = buildSummarySourceMessages(chat, messageStart, messageEnd, {
    rawChatContextFloors: inputConfig.rawChatContextFloors,
  });
  if (sourceMessages.length === 0) {
    return {
      created: false,
      skipped: true,
      reason: "小总结原文窗口为空，已跳过",
    };
  }

  const messageRange = [
    Number.isFinite(Number(sourceMessages[0]?.seq)) ? Number(sourceMessages[0].seq) : messageStart,
    Number.isFinite(Number(sourceMessages[sourceMessages.length - 1]?.seq))
      ? Number(sourceMessages[sourceMessages.length - 1].seq)
      : messageEnd,
  ];
  const sourceNodeIds = uniqueIds(
    slices.flatMap((slice) => Array.isArray(slice.touchedNodeIds) ? slice.touchedNodeIds : []),
  );
  const nodeDigest = buildNodeDigest(graph, sourceNodeIds) || "(无关键节点辅助)";
  const activeFrontier = getActiveSummaryEntries(graph);
  const result = await callSummaryTask({
    settings,
    taskType: "synopsis",
    context: {
      recentMessages: buildTranscript(sourceMessages),
      chatMessages: sourceMessages,
      candidateText: nodeDigest,
      graphStats: [
        buildSummaryGraphStats(graph, activeFrontier),
        `frontier_hint:\n${buildFrontierHint(graph)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      currentRange: `楼 ${messageRange[0]} ~ ${messageRange[1]}`,
    },
    fallbackSystemPrompt: [
      "你是小总结生成器。",
      "请基于最近原文聊天窗口为主、关键节点为辅，生成一条贴近当前局面的短总结。",
      '输出 JSON：{"summary":"总结文本（80-220字）"}',
      "不要写未来预测，不要脱离原文杜撰，不要把多段时间线硬糅在一起。",
    ].join("\n"),
    fallbackUserPrompt: [
      "## 原文聊天窗口",
      buildTranscript(sourceMessages),
      "",
      "## 关键节点辅助",
      nodeDigest,
      "",
      "## 当前活跃总结前沿",
      buildFrontierHint(graph),
    ].join("\n"),
    signal,
  });

  const summaryText = String(result?.summary || "").trim();
  if (!summaryText) {
    return {
      created: false,
      skipped: true,
      reason: "小总结任务未返回有效 summary",
    };
  }

  const nodeHints = collectNodeHints(graph, sourceNodeIds);
  const storyTimeSpan = deriveStoryTimeSpanFromNodes(
    graph,
    nodeHints.nodes,
    "derived",
  );
  const entry = appendSummaryEntry(graph, {
    level: 0,
    kind: "small",
    status: "active",
    text: summaryText,
    sourceTask: "synopsis",
    extractionRange: [firstSlice.extractionCountAfter, lastSlice.extractionCountAfter],
    messageRange,
    sourceBatchIds: uniqueIds(slices.map((slice) => slice.id)),
    sourceSummaryIds: [],
    sourceNodeIds,
    storyTimeSpan,
    regionHints: nodeHints.regionHints,
    ownerHints: nodeHints.ownerHints,
  });
  summaryState.lastSummarizedExtractionCount = lastSlice.extractionCountAfter;
  summaryState.lastSummarizedAssistantFloor = messageRange[1];
  debugLog("[ST-BME] 已生成小总结", {
    entryId: entry.id,
    extractionRange: entry.extractionRange,
    messageRange: entry.messageRange,
  });
  return {
    created: true,
    entry,
    sourceMessages,
    sourceNodeIds,
    messageRange,
  };
}

function buildRollupCandidateText(entries = []) {
  return entries
    .map((entry, index) => {
      const range = normalizeRange(entry.messageRange);
      return [
        `#${index + 1}`,
        `level=L${entry.level}`,
        `message_range=${range[0]}~${range[1]}`,
        `text=${String(entry.text || "")}`,
      ].join(" | ");
    })
    .join("\n");
}

function getFoldableSummaryGroup(graph, fanIn = 3) {
  const activeEntries = getActiveSummaryEntries(graph);
  const byLevel = new Map();
  for (const entry of activeEntries) {
    if (!byLevel.has(entry.level)) {
      byLevel.set(entry.level, []);
    }
    byLevel.get(entry.level).push(entry);
  }
  const sortedLevels = [...byLevel.keys()].sort((left, right) => left - right);
  for (const level of sortedLevels) {
    const entries = byLevel.get(level) || [];
    if (entries.length >= fanIn) {
      return entries.slice(0, fanIn);
    }
  }
  return [];
}

export async function rollupSummaryFrontier({
  graph,
  settings = {},
  signal,
  force = false,
} = {}) {
  normalizeGraphSummaryState(graph);
  const fanIn = clampInt(settings.summaryRollupFanIn, 3, 2, 10);
  const createdEntries = [];
  let foldedCount = 0;

  while (true) {
    throwIfAborted(signal);
    const candidates = getFoldableSummaryGroup(graph, fanIn);
    if (candidates.length < fanIn) {
      break;
    }

    const sourceNodeIds = uniqueIds(
      candidates.flatMap((entry) =>
        Array.isArray(entry.sourceNodeIds) ? entry.sourceNodeIds : [],
      ),
    );
    const nodeHints = collectNodeHints(graph, sourceNodeIds);
    const result = await callSummaryTask({
      settings,
      taskType: "summary_rollup",
      context: {
        candidateText: buildRollupCandidateText(candidates),
        graphStats: buildSummaryGraphStats(graph, getActiveSummaryEntries(graph)),
        currentRange: `楼 ${normalizeRange(candidates[0]?.messageRange)[0]} ~ ${
          normalizeRange(candidates[candidates.length - 1]?.messageRange)[1]
        }`,
      },
      fallbackSystemPrompt: [
        "你是总结折叠器。",
        "请把多条同层活跃总结折叠成一条更稳定、更高层的总结。",
        '输出 JSON：{"summary":"折叠后的总结文本（120-260字）"}',
        "不要重复原句，不要丢掉当前仍然生效的局面，不要打乱先后顺序。",
      ].join("\n"),
      fallbackUserPrompt: [
        "## 待折叠总结",
        buildRollupCandidateText(candidates),
        "",
        "## 关键节点辅助",
        buildNodeDigest(graph, sourceNodeIds) || "(无关键节点辅助)",
      ].join("\n"),
      signal,
    });
    const summaryText = String(result?.summary || "").trim();
    if (!summaryText) {
      return {
        createdCount: createdEntries.length,
        foldedCount,
        skipped: createdEntries.length === 0,
        reason: "总结折叠任务未返回有效 summary",
        createdEntries,
      };
    }

    const extractionRange = [
      Math.min(...candidates.map((entry) => normalizeRange(entry.extractionRange)[0])),
      Math.max(...candidates.map((entry) => normalizeRange(entry.extractionRange)[1])),
    ];
    const messageRange = [
      Math.min(...candidates.map((entry) => normalizeRange(entry.messageRange)[0])),
      Math.max(...candidates.map((entry) => normalizeRange(entry.messageRange)[1])),
    ];
    const storyTimeSpan = deriveStoryTimeSpanFromNodes(
      graph,
      nodeHints.nodes,
      "derived",
    );
    markSummaryEntriesFolded(
      graph,
      candidates.map((entry) => entry.id),
    );
    foldedCount += candidates.length;
    const createdEntry = appendSummaryEntry(graph, {
      level: Number(candidates[0]?.level || 0) + 1,
      kind: "rollup",
      status: "active",
      text: summaryText,
      sourceTask: "summary_rollup",
      extractionRange,
      messageRange,
      sourceBatchIds: uniqueIds(
        candidates.flatMap((entry) =>
          Array.isArray(entry.sourceBatchIds) ? entry.sourceBatchIds : [],
        ),
      ),
      sourceSummaryIds: candidates.map((entry) => entry.id),
      sourceNodeIds,
      storyTimeSpan,
      regionHints: nodeHints.regionHints,
      ownerHints: nodeHints.ownerHints,
    });
    createdEntries.push(createdEntry);
    debugLog("[ST-BME] 已完成总结折叠", {
      createdEntryId: createdEntry.id,
      sourceSummaryIds: createdEntry.sourceSummaryIds,
    });
    if (!force) {
      continue;
    }
  }

  return {
    createdCount: createdEntries.length,
    foldedCount,
    createdEntries,
    skipped: createdEntries.length === 0,
    reason:
      createdEntries.length === 0
        ? `当前没有达到 ${fanIn} 条同层活跃总结的折叠候选`
        : "",
  };
}

export async function runHierarchicalSummaryPostProcess({
  graph,
  chat = [],
  settings = {},
  signal,
  currentExtractionCount = 0,
  currentAssistantFloor = -1,
  currentRange = [-1, -1],
  currentNodeIds = [],
} = {}) {
  normalizeGraphSummaryState(graph);
  if (settings.enableHierarchicalSummary === false) {
    return {
      smallSummary: null,
      rollup: null,
      created: false,
      reason: "层级总结开关已关闭",
    };
  }

  const smallSummary = await generateSmallSummary({
    graph,
    chat,
    settings,
    currentExtractionCount,
    currentAssistantFloor,
    currentRange,
    currentNodeIds,
    signal,
    force: false,
  });
  if (!smallSummary?.created) {
    return {
      smallSummary,
      rollup: null,
      created: false,
      reason: smallSummary?.reason || "",
    };
  }

  const rollup = await rollupSummaryFrontier({
    graph,
    settings,
    signal,
    force: false,
  });
  return {
    smallSummary,
    rollup,
    created: true,
  };
}

function clearSummaryState(graph) {
  graph.summaryState = createDefaultSummaryState();
}

export async function rebuildHierarchicalSummaryState({
  graph,
  chat = [],
  settings = {},
  signal,
} = {}) {
  normalizeGraphSummaryState(graph);
  clearSummaryState(graph);
  const currentExtractionCount = clampInt(
    graph?.historyState?.extractionCount,
    0,
    0,
    999999,
  );
  if (currentExtractionCount <= 0) {
    return {
      rebuilt: false,
      smallSummaryCount: 0,
      rollupCount: 0,
      reason: "当前还没有成功提取批次",
    };
  }

  const threshold = clampInt(settings.smallSummaryEveryNExtractions, 3, 1, 100);
  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: 0,
    currentExtractionCount,
    currentRange: null,
    currentNodeIds: [],
    includeCurrentPending: false,
  });
  let pendingSlices = [];
  let smallSummaryCount = 0;
  let rollupCount = 0;

  for (const slice of slices) {
    pendingSlices.push(slice);
    if (pendingSlices.length < threshold) {
      continue;
    }

    const firstSlice = pendingSlices[0];
    const lastSlice = pendingSlices[pendingSlices.length - 1];
    const sourceNodeIds = uniqueIds(
      pendingSlices.flatMap((item) => item.touchedNodeIds || []),
    );
    const sourceMessages = buildSummarySourceMessages(
      chat,
      normalizeRange(firstSlice.processedRange)[0],
      normalizeRange(lastSlice.processedRange)[1],
      {
        rawChatContextFloors: getSummaryTaskInputConfig(settings, "synopsis")
          .rawChatContextFloors,
      },
    );
    if (sourceMessages.length > 0) {
      const nodeHints = collectNodeHints(graph, sourceNodeIds);
      const result = await callSummaryTask({
        settings,
        taskType: "synopsis",
        context: {
          recentMessages: buildTranscript(sourceMessages),
          chatMessages: sourceMessages,
          candidateText: buildNodeDigest(graph, sourceNodeIds) || "(无关键节点辅助)",
          graphStats: [
            buildSummaryGraphStats(graph, getActiveSummaryEntries(graph)),
            `frontier_hint:\n${buildFrontierHint(graph)}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          currentRange: `楼 ${sourceMessages[0]?.seq ?? "?"} ~ ${
            sourceMessages[sourceMessages.length - 1]?.seq ?? "?"
          }`,
        },
        fallbackSystemPrompt: [
          "你是小总结生成器。",
          '输出 JSON：{"summary":"总结文本（80-220字）"}',
        ].join("\n"),
        fallbackUserPrompt: [
          "## 原文聊天窗口",
          buildTranscript(sourceMessages),
        ].join("\n"),
        signal,
      });
      const summaryText = String(result?.summary || "").trim();
      if (summaryText) {
        const entry = appendSummaryEntry(graph, {
          level: 0,
          kind: "small",
          status: "active",
          text: summaryText,
          sourceTask: "synopsis",
          extractionRange: [firstSlice.extractionCountAfter, lastSlice.extractionCountAfter],
          messageRange: [
            Number(sourceMessages[0]?.seq ?? -1),
            Number(sourceMessages[sourceMessages.length - 1]?.seq ?? -1),
          ],
          sourceBatchIds: pendingSlices.map((item) => item.id),
          sourceSummaryIds: [],
          sourceNodeIds,
          storyTimeSpan: deriveStoryTimeSpanFromNodes(
            graph,
            nodeHints.nodes,
            "derived",
          ),
          regionHints: nodeHints.regionHints,
          ownerHints: nodeHints.ownerHints,
        });
        graph.summaryState.lastSummarizedExtractionCount =
          lastSlice.extractionCountAfter;
        graph.summaryState.lastSummarizedAssistantFloor =
          normalizeRange(lastSlice.processedRange)[1];
        if (entry) smallSummaryCount += 1;
        const rollup = await rollupSummaryFrontier({
          graph,
          settings,
          signal,
          force: false,
        });
        rollupCount += Number(rollup?.createdCount || 0);
      }
    }
    pendingSlices = [];
  }

  return {
    rebuilt: smallSummaryCount > 0 || rollupCount > 0,
    smallSummaryCount,
    rollupCount,
    reason:
      smallSummaryCount > 0 || rollupCount > 0
        ? ""
        : "根据现有提取批次未能重建出新的总结链",
  };
}

export function resetHierarchicalSummaryState(graph) {
  clearSummaryState(graph);
  return graph?.summaryState || null;
}
