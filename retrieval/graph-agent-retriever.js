import { GraphRecallAgentToolset } from "./graph-recall-tools.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { TransientAgentJournal } from "../agent/transient-journal.js";
import { buildAgentProfileMessages } from "../agent/profile-runtime.js";
import { createBmeAgentRunId } from "../agent/journal.js";
import { isAbortLikeError } from "../agent/errors.js";
import { cloneDomainValue, createDomainId } from "../domain/memory-id.js";
import { createBmeAgentRuntime } from "../application/bme-agent-runtime.js";
import { buildRecallCandidatePacket } from "./recall-candidate-packet.js";
import { compareNodesByRecallInjectionPlan } from "./recall-injection-plan.js";

async function loadWorkflowRetriever() {
  return (await import("./retriever.js")).retrieve;
}

async function loadResultBuilder() {
  return (await import("./retriever.js")).buildRetrievalResultForSelectedNodes;
}

function uniqueMemoryIds(values = []) {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

function collectInjectableMemoryIds(result = {}) {
  const buckets = result?.scopeBuckets;
  if (!buckets || typeof buckets !== "object") return [];
  return uniqueMemoryIds([
    ...(buckets.characterPov || []).map((node) => node?.id),
    ...(buckets.userPov || []).map((node) => node?.id),
    ...(buckets.objectiveCurrentRegion || []).map((node) => node?.id),
    ...(buckets.objectiveGlobal || []).map((node) => node?.id),
  ]);
}

async function filterPacketByInjectionScope(packet, authorizeMemoryIds) {
  const allowedMemoryIds = await authorizeMemoryIds({
    memoryIds: packet?.candidateMemoryIds || [],
  });
  const allowed = new Set(allowedMemoryIds);
  const candidates = (packet?.candidates || []).filter((candidate) =>
    allowed.has(String(candidate?.memoryId || "")),
  );
  return {
    ...packet,
    candidateMemoryIds: candidates.map((candidate) => candidate.memoryId),
    initialSelectedMemoryIds: uniqueMemoryIds(
      packet?.initialSelectedMemoryIds || [],
    ).filter((memoryId) => allowed.has(memoryId)),
    candidates,
    channels: {
      programmatic: candidates.filter((candidate) =>
        candidate?.channels?.includes?.("programmatic"),
      ).length,
      vectorTail: candidates.filter((candidate) =>
        candidate?.channels?.includes?.("vector-tail"),
      ).length,
    },
  };
}

function applyRecallInjectionPlanOrdering(result = {}, plan = null) {
  if (!Array.isArray(plan?.items) || plan.items.length === 0) return result;
  const sortNodes = (nodes) =>
    Array.isArray(nodes)
      ? [...nodes].sort((left, right) =>
          compareNodesByRecallInjectionPlan(plan, left, right),
        )
      : nodes;
  const buckets = result?.scopeBuckets;
  if (!buckets || typeof buckets !== "object") return result;
  const characterPovByOwner = Object.fromEntries(
    Object.entries(buckets.characterPovByOwner || {}).map(([ownerKey, nodes]) => [
      ownerKey,
      sortNodes(nodes),
    ]),
  );
  return {
    ...result,
    scopeBuckets: {
      ...buckets,
      characterPov: sortNodes(buckets.characterPov),
      characterPovByOwner,
      userPov: sortNodes(buckets.userPov),
      objectiveCurrentRegion: sortNodes(buckets.objectiveCurrentRegion),
      objectiveGlobal: sortNodes(buckets.objectiveGlobal),
    },
  };
}

async function buildResult({
  graph,
  schema,
  packet,
  selectedMemoryIds,
  runResult = null,
  outcome = null,
  fallbackReason = "",
  resultBuilder = null,
} = {}) {
  const fallback = Boolean(fallbackReason);
  const selectionProtocol = fallback
    ? "graph-agent-programmatic-fallback"
    : "graph-agent-tool-selection";
  const baselineScopeContext = packet?.baseline?.scopeContext || {};
  const activeOwnerKeys =
    outcome?.kind === "published"
      ? uniqueMemoryIds(outcome?.activeOwnerKeys || [])
      : uniqueMemoryIds(baselineScopeContext.activeRecallOwnerKeys || []);
  const retrievalMeta = {
    ...(packet.baseline?.retrievalMeta || {}),
    agent: {
      mode: "graph-backed",
      runId: String(runResult?.runId || ""),
      toolCallCount: Number(runResult?.toolCallCount || 0),
      modelRequestCount: Number(runResult?.modelRequestCount || 0),
      elapsedMs: Number(runResult?.elapsedMs || 0),
      fallback,
      fallbackReason: String(fallbackReason || ""),
      reason: String(outcome?.reason || ""),
      activeOwnerKeys,
      injectionPlan: cloneDomainValue(outcome?.injectionPlan, null),
    },
    llm: {
      status: fallback ? "fallback" : "llm",
      reason: fallback
        ? `Recall Agent 未能结算，已使用程序召回：${fallbackReason}`
        : outcome?.reason || "Recall Agent 已发布选择",
      selectionProtocol,
      rawSelectedKeys: [...selectedMemoryIds],
      resolvedSelectedKeys: [...selectedMemoryIds],
      resolvedSelectedNodeIds: [...selectedMemoryIds],
      fallbackReason: String(fallbackReason || ""),
      fallbackType: fallback ? "programmatic" : "",
      emptySelectionAccepted: selectedMemoryIds.length === 0,
      candidateKeyMapPreview: {},
      legacySelectionUsed: false,
      candidatePool: Number(packet.candidates?.length || 0),
    },
  };
  const buildRetrievalResult = resultBuilder || (await loadResultBuilder());
  const result = await buildRetrievalResult({
    graph,
    selectedNodeIds: selectedMemoryIds,
    schema,
    meta: {
      retrieval: retrievalMeta,
      scopeContext: {
        ...baselineScopeContext,
        activeRecallOwnerKeys: activeOwnerKeys,
        activeRecallOwnerKey: activeOwnerKeys[0] || "",
        sceneOwnerResolutionMode:
          outcome?.kind === "published"
            ? "graph-agent"
            : String(
                baselineScopeContext.sceneOwnerResolutionMode || "unresolved",
              ),
        recallInjectionPlan: cloneDomainValue(outcome?.injectionPlan, null),
        graph,
      },
    },
  });
  return applyRecallInjectionPlanOrdering(result, outcome?.injectionPlan);
}

export async function retrieveWithGraphAgent({
  graph,
  userMessage = "",
  recentMessages = [],
  embeddingConfig = {},
  schema = [],
  signal,
  settings = {},
  options = {},
  model,
  countTokens,
  journal = new TransientAgentJournal(),
  observer = null,
  retrieveFn = null,
  resultBuilder = null,
  agentPromptBuilder = buildAgentProfileMessages,
  taskPromptBuilder = null,
  stPromptContext = null,
} = {}) {
  const runRetrieve = retrieveFn || (await loadWorkflowRetriever());
  const buildRetrievalResult = resultBuilder || (await loadResultBuilder());
  const recallGraph = cloneDomainValue(graph, graph);
  const rawPacket = await buildRecallCandidatePacket({
    graph: recallGraph,
    graphIsFrozen: true,
    userMessage,
    recentMessages,
    embeddingConfig,
    schema,
    settings,
    options,
    signal,
    retrieveFn: runRetrieve,
  });
  const authorizeMemoryIds = async ({ memoryIds = [] } = {}) => {
    const requested = uniqueMemoryIds(memoryIds);
    if (!requested.length) return [];
    const exploratoryOwnerKeys = uniqueMemoryIds(
      (rawPacket?.baseline?.scopeContext?.sceneOwnerCandidates || []).map(
        (candidate) => candidate?.ownerKey,
      ),
    );
    const scopedResult = await buildRetrievalResult({
      graph: recallGraph,
      selectedNodeIds: requested,
      schema,
      meta: {
        scopeContext: {
          ...(rawPacket.baseline?.scopeContext || {}),
          ...(exploratoryOwnerKeys.length
            ? {
                activeRecallOwnerKeys: exploratoryOwnerKeys,
                activeRecallOwnerKey: exploratoryOwnerKeys[0],
                sceneOwnerResolutionMode: "graph-agent-candidate-set",
              }
            : {}),
          graph: recallGraph,
        },
      },
    });
    const injectable = new Set(collectInjectableMemoryIds(scopedResult));
    return requested.filter((memoryId) => injectable.has(memoryId));
  };
  const packet = await filterPacketByInjectionScope(
    rawPacket,
    authorizeMemoryIds,
  );
  const chatId = String(
    options.chatId || recallGraph?.historyState?.chatId || "graph-agent-chat",
  ).trim();
  const turnId = String(options.turnId || options.recallKey || userMessage).trim();
  const hasActiveGraphMemory = Array.isArray(recallGraph?.nodes)
    ? recallGraph.nodes.some((node) => node && !node.archived && node.id)
    : false;
  if (!hasActiveGraphMemory) {
    return await buildResult({
      graph: recallGraph,
      schema,
      packet,
      selectedMemoryIds: [],
      fallbackReason: "当前聊天没有可召回的记忆",
      resultBuilder: buildRetrievalResult,
    });
  }
  const registry = new AgentToolRegistry();
  const toolset = new GraphRecallAgentToolset({
    authorizeMemoryIds,
    searchCandidates: async ({ query, graph: searchGraph, signal: searchSignal }) =>
      await filterPacketByInjectionScope(
        await buildRecallCandidatePacket({
          graph: searchGraph,
          graphIsFrozen: true,
          userMessage: query,
          recentMessages,
          embeddingConfig,
          schema,
          settings,
          options,
          signal: searchSignal,
          retrieveFn: runRetrieve,
        }),
        authorizeMemoryIds,
      ),
  });
  const unregister = toolset.registerInto(registry);
  const taskId = createDomainId("graph-recall-agent-task", {
    chatId,
    turnId,
    userMessage,
  });
  const runId = createBmeAgentRunId({ chatId, taskId });
  toolset.openTask({
    runId,
    chatId,
    turnId,
    userMessage,
    recentMessages,
    graph: recallGraph,
    packet,
    signal,
  });
  let runResult = null;
  let runError = null;
  try {
    try {
      const prompt = await agentPromptBuilder({
        settings,
        taskType: "agent_recall",
        toolSnapshot: registry.capture(),
        assignment: {
          turnId,
          userMessage,
          recentMessages,
          historyFingerprint: String(options.historyFingerprint || ""),
          startWith: "recall_context",
          settleWith: "recall_publish",
        },
        context: {
          userMessage,
          recentMessages: recentMessages.join("\n---\n"),
        },
        promptBuilder: taskPromptBuilder,
        stPromptContext,
      });
      const runtime = createBmeAgentRuntime({
        journal,
        settings,
        toolRegistry: registry,
        observer,
        ...(model ? { model } : {}),
        ...(countTokens ? { countTokens } : {}),
      });
      runResult = await runtime.run({
        chatId,
        taskId,
        runId,
        agentKind: "graph-recall-agent",
        taskType: "agent_recall",
        messages: prompt.messages,
        metadata: {
          recallKey: String(options.recallKey || ""),
          candidateCount: packet.candidates.length,
          taskProfileId: prompt.profileId,
          taskProfileName: prompt.profileName,
          toolSnapshotFingerprint: prompt.toolSnapshotFingerprint,
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) throw error;
      runError = error;
    }
    const outcome = toolset.getOutcome(runId);
    if (outcome.kind === "published") {
      try {
        observer?.recordOutcome?.({
          runId,
          outcome: {
            kind: "published",
            completed: true,
            selectedMemoryCount: Array.isArray(outcome.selectedMemoryIds)
              ? outcome.selectedMemoryIds.length
              : 0,
          },
        });
      } catch {}
      return await buildResult({
        graph: recallGraph,
        schema,
        packet,
        selectedMemoryIds: outcome.selectedMemoryIds || [],
        runResult,
        outcome,
        resultBuilder: buildRetrievalResult,
      });
    }
    try {
      observer?.recordOutcome?.({
        runId,
        outcome: {
          kind: String(outcome.kind || "fallback"),
          completed: true,
          fallback: true,
          reason: String(runError?.message || "missing-agent-publication"),
          selectedMemoryCount: Array.isArray(packet.initialSelectedMemoryIds)
            ? packet.initialSelectedMemoryIds.length
            : 0,
        },
      });
    } catch {}
    return await buildResult({
      graph: recallGraph,
      schema,
      packet,
      selectedMemoryIds: packet.initialSelectedMemoryIds || [],
      runResult,
      outcome,
      fallbackReason:
        runError?.message || "Agent 结束时没有发布有效的召回选择",
      resultBuilder: buildRetrievalResult,
    });
  } finally {
    toolset.closeTask(runId);
    unregister();
  }
}
