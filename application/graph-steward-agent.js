import { buildGraphStewardMessages } from "../agent/graph-steward-prompt.js";
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
  const runtime = createBmeAgentRuntime({
    journal,
    settings,
    toolRegistry: registry,
    ...(model ? { model } : {}),
    ...(countTokens ? { countTokens } : {}),
  });
  let runResult = null;
  let runError = null;
  try {
    try {
      runResult = await runtime.run({
        chatId,
        taskId,
        runId,
        agentKind: "graph-memory-steward",
        taskType: "memory_steward",
        messages: buildGraphStewardMessages({
          chatId,
          startFloor,
          endFloor,
          instructions,
        }),
        metadata: {
          startFloor,
          endFloor,
          historyFingerprint: context?.historyFingerprint || "",
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
