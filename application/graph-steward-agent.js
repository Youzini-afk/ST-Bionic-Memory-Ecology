import { buildAgentProfileMessages } from "../agent/profile-runtime.js";
import { GraphStewardAgentToolset } from "../agent/graph-steward-tools.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { TransientAgentJournal } from "../agent/transient-journal.js";
import { createBmeAgentRunId } from "../agent/journal.js";
import { createDomainId } from "../domain/memory-id.js";
import { createBmeAgentRuntime } from "./bme-agent-runtime.js";

export async function runGraphStewardAgent({
  chatId,
  startFloor,
  endFloor,
  context,
  allowedCapabilities = {},
  settings = {},
  runPipeline,
  completeWithoutChanges,
  model,
  countTokens,
  journal = new TransientAgentJournal(),
  signal = null,
  instructions = "",
  agentPromptBuilder = buildAgentProfileMessages,
  taskPromptBuilder = null,
  stPromptContext = null,
} = {}) {
  const taskId = createDomainId("graph-steward-task", {
    chatId,
    startFloor,
    endFloor,
    historyFingerprint: context?.historyFingerprint || "",
  });
  const runId = createBmeAgentRunId({ chatId, taskId });
  const registry = new AgentToolRegistry();
  const toolset = new GraphStewardAgentToolset({
    runPipeline,
    completeWithoutChanges,
  });
  const unregister = toolset.registerInto(registry);
  toolset.openTask({ runId, context, allowedCapabilities });
  let runResult = null;
  let runError = null;
  try {
    try {
      const prompt = await agentPromptBuilder({
        settings,
        taskType: "agent_steward",
        toolSnapshot: registry.capture(),
        assignment: {
          chatId: String(chatId || ""),
          startFloor: Number(startFloor),
          endFloor: Number(endFloor),
          instructions: String(instructions || "").trim(),
          startWith: "memory_task_context",
          settleWith: ["memory_run_pipeline", "memory_complete_without_changes"],
        },
        context: {
          recentMessages: (context?.messages || [])
            .map((message) => `#${message?.floor ?? "?"} [${message?.role || "unknown"}]: ${message?.content || ""}`)
            .join("\n"),
          chatMessages: (context?.messages || []).map((message) => ({
            seq: Number(message?.floor),
            role: String(message?.role || ""),
            content: String(message?.content || ""),
          })),
          graphStats: context?.graphStats || {},
        },
        promptBuilder: taskPromptBuilder,
        stPromptContext,
      });
      const runtime = createBmeAgentRuntime({
        journal,
        settings,
        toolRegistry: registry,
        ...(model ? { model } : {}),
        ...(countTokens ? { countTokens } : {}),
      });
      runResult = await runtime.run({
        chatId,
        taskId,
        runId,
        agentKind: "graph-memory-steward",
        taskType: "agent_steward",
        messages: prompt.messages,
        metadata: {
          startFloor,
          endFloor,
          historyFingerprint: context?.historyFingerprint || "",
          taskProfileId: prompt.profileId,
          taskProfileName: prompt.profileName,
          toolSnapshotFingerprint: prompt.toolSnapshotFingerprint,
        },
        signal,
      });
    } catch (error) {
      const settledOutcome = toolset.getOutcome(runId);
      if (
        (signal?.aborted || error?.name === "AbortError") &&
        !["pipeline", "no_change"].includes(settledOutcome.kind)
      ) {
        throw error;
      }
      runError = error;
    }
    let outcome = toolset.getOutcome(runId);
    if (outcome.kind === "pending") {
      const result = await runPipeline({
        capabilities: {
          consolidate: allowedCapabilities.consolidate === true,
          summarize: allowedCapabilities.summarize === true,
          reflect: allowedCapabilities.reflect === true,
          compress: allowedCapabilities.compress === true,
          forget: allowedCapabilities.forget === true,
          enableConsolidation: allowedCapabilities.consolidate === true,
          enableHierarchicalSummary: allowedCapabilities.summarize === true,
          enableSynopsis: allowedCapabilities.summarize === true,
          enableReflection: allowedCapabilities.reflect === true,
          enableAutoCompression: allowedCapabilities.compress === true,
          enableSleepCycle: allowedCapabilities.forget === true,
        },
        reason: runError?.message || "Agent 未提交任务决策，已运行完整工作流兜底",
        signal,
        fallback: true,
      });
      const completed = result?.success === true;
      outcome = {
        kind: completed ? "pipeline_fallback" : "pipeline_fallback_failed",
        completed,
        reason: runError?.message || "missing-agent-disposition",
        result,
      };
    }
    return {
      success: outcome.completed === true,
      runId,
      taskId,
      runResult,
      runError,
      outcome,
    };
  } finally {
    toolset.closeTask(runId);
    unregister();
  }
}
