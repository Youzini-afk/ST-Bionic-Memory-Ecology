import { AGENT_EVENT_TYPE } from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  hashDomainValue,
  stableStringify,
} from "../domain/memory-id.js";
import {
  BmeAgentCancelledError,
  BmeAgentGuardError,
  BmeAgentProtocolError,
  BmeAgentSuspendedError,
  isAbortLikeError,
} from "./errors.js";
import { createBmeAgentRunId } from "./journal.js";
import {
  normalizeAgentModelResponse,
  toAgentAssistantMessage,
  toAgentToolMessage,
} from "./model-protocol.js";
import { normalizeBmeAgentRuntimeSettings } from "./runtime-settings.js";

const COMPACTION_SYSTEM_PROMPT = `You compact the private working context of a memory-management Agent.
Preserve concrete facts, source identifiers, decisions, unresolved questions, tool results, cursors, and pending work.
Distinguish evidence from inference. Do not invent facts. Do not include commentary about summarizing.
Return only the compact working-context summary.`;

function buildCompactionModelMessages(messages) {
  return [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    { role: "user", content: stableStringify(messages) },
  ];
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError("BME Agent requires initial messages");
  }
  return messages.map((message) => {
    const role = String(message?.role || "").trim().toLowerCase();
    if (!role) throw new TypeError("BME Agent message role is required");
    return cloneDomainValue({ ...message, role }, message);
  });
}

function createRunAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener?.("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new BmeAgentGuardError("BME Agent exceeded its run time guard", {
      maxRunMs: timeoutMs,
    }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", abortFromExternal);
    },
  };
}

function terminalPayload(error, extra = {}) {
  return {
    reason: String(error?.message || error || "Agent run stopped"),
    code: String(error?.code || error?.name || "agent_error"),
    details: cloneDomainValue(error?.details, {}),
    ...extra,
  };
}

export class BmeAgentLoop {
  constructor({
    model,
    toolRegistry,
    journal,
    context,
    settings = {},
    now = () => Date.now(),
  } = {}) {
    if (!model || (typeof model !== "function" && typeof model.complete !== "function")) {
      throw new TypeError("BmeAgentLoop requires a model client");
    }
    if (!toolRegistry || typeof toolRegistry.capture !== "function") {
      throw new TypeError("BmeAgentLoop requires an Agent tool registry");
    }
    if (!journal || typeof journal.startRun !== "function" || typeof journal.append !== "function") {
      throw new TypeError("BmeAgentLoop requires a durable Agent journal");
    }
    if (!context || typeof context.prepare !== "function") {
      throw new TypeError("BmeAgentLoop requires a token-aware context manager");
    }
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.journal = journal;
    this.context = context;
    this.settings = normalizeBmeAgentRuntimeSettings(settings);
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  async _complete(request) {
    return typeof this.model === "function"
      ? await this.model(request)
      : await this.model.complete(request);
  }

  async run({
    chatId,
    taskId,
    agentKind = "memory-agent",
    runId = "",
    messages: initialMessages,
    sourceRecordIds = [],
    metadata = {},
    signal: externalSignal,
    taskType = "",
  } = {}) {
    const startedAt = this.now();
    const resolvedRunId = String(runId || "").trim() ||
      createBmeAgentRunId({ chatId, taskId, now: startedAt });
    let messages = normalizeMessages(initialMessages);
    const toolSnapshot = this.toolRegistry.capture();
    const runAbort = createRunAbortSignal(externalSignal, this.settings.maxRunMs);
    let toolCallCount = 0;
    let modelRequestCount = 0;
    let terminalWritten = false;
    let runStarted = false;

    const append = async (eventType, payload = {}, eventKey = "") =>
      await this.journal.append({
        chatId,
        runId: resolvedRunId,
        eventType,
        payload,
        eventKey,
      });

    const elapsedMs = () => Math.max(0, Number(this.now()) - Number(startedAt));
    const assertRunGuard = () => {
      if (runAbort.didTimeOut() || elapsedMs() >= this.settings.maxRunMs) {
        throw new BmeAgentGuardError("BME Agent exceeded its run time guard", {
          maxRunMs: this.settings.maxRunMs,
          elapsedMs: elapsedMs(),
        });
      }
      if (externalSignal?.aborted) {
        throw new BmeAgentCancelledError("BME Agent run was cancelled", {
          reason: String(externalSignal.reason?.message || externalSignal.reason || ""),
        });
      }
    };

    try {
      await this.journal.startRun({
        chatId,
        runId: resolvedRunId,
        taskId,
        agentKind,
        initialMessages: messages,
        sourceRecordIds,
        toolSnapshot,
        runtimeSettings: this.settings,
        metadata,
      });
      runStarted = true;

      while (true) {
        assertRunGuard();
        const prepared = await this.context.prepare({
          messages,
          tools: toolSnapshot.definitions,
          signal: runAbort.signal,
          measureCompaction: async ({ messages: removedMessages }) =>
            await this.context.measure(
              buildCompactionModelMessages(removedMessages),
              [],
            ),
          compact: async ({
            messages: removedMessages,
            maxSummaryTokens,
            signal,
            stage = "direct",
            depth = 0,
            chunkIndex = 0,
            chunkCount = 1,
          }) => {
            assertRunGuard();
            modelRequestCount += 1;
            const requestEvent = await append(
              AGENT_EVENT_TYPE.MODEL_REQUESTED,
              {
                purpose: "context-compaction",
                requestNumber: modelRequestCount,
                messageFingerprint: hashDomainValue(removedMessages),
                messageCount: removedMessages.length,
                maxCompletionTokens: maxSummaryTokens,
                toolsIncluded: false,
                compactionStage: stage,
                compactionDepth: depth,
                chunkIndex,
                chunkCount,
              },
              `agent-run:${resolvedRunId}:model-request:${modelRequestCount}`,
            );
            const response = normalizeAgentModelResponse(
              await this._complete({
                messages: buildCompactionModelMessages(removedMessages),
                tools: [],
                toolChoice: "none",
                signal,
                maxCompletionTokens: maxSummaryTokens,
                maxContextTokens: this.settings.contextWindowTokens,
                taskType,
                requestSource: `agent:${agentKind}:context-compaction`,
              }),
            );
            if (response.toolCalls.length > 0) {
              throw new BmeAgentProtocolError("context compactor attempted to call a tool");
            }
            await append(
              AGENT_EVENT_TYPE.CONTEXT_SUMMARY_CREATED,
              {
                requestEventId: requestEvent.event?.id || "",
                summary: response.content,
                sourceMessageFingerprint: hashDomainValue(removedMessages),
                sourceMessageCount: removedMessages.length,
                compactionStage: stage,
                compactionDepth: depth,
                chunkIndex,
                chunkCount,
              },
              `agent-run:${resolvedRunId}:context-summary:${modelRequestCount}`,
            );
            return { summary: response.content };
          },
        });
        if (prepared.compacted) {
          await append(
            AGENT_EVENT_TYPE.CONTEXT_COMPACTED,
            {
              summary: prepared.summary,
              sourceMessageFingerprint: hashDomainValue(prepared.removedMessages),
              sourceMessageCount: prepared.removedMessages.length,
              beforeTokens: prepared.currentTokens,
              afterTokens: prepared.projectedTokens,
              inputCapacity: prepared.inputCapacity,
            },
            `agent-run:${resolvedRunId}:context-compacted:${modelRequestCount}`,
          );
          messages = prepared.messages;
        }

        assertRunGuard();
        modelRequestCount += 1;
        const requestEvent = await append(
          AGENT_EVENT_TYPE.MODEL_REQUESTED,
          {
            purpose: "agent-turn",
            requestNumber: modelRequestCount,
            messageFingerprint: hashDomainValue(messages),
            messageCount: messages.length,
            contextTokens: prepared.projectedTokens,
            toolSnapshotFingerprint: toolSnapshot.fingerprint,
            toolsIncluded: toolSnapshot.definitions.length > 0,
          },
          `agent-run:${resolvedRunId}:model-request:${modelRequestCount}`,
        );
        const canonical = toAgentAssistantMessage(
          await this._complete({
            messages: cloneDomainValue(messages, messages),
            tools: toolSnapshot.definitions,
            toolChoice: toolSnapshot.definitions.length > 0 ? "auto" : "none",
            signal: runAbort.signal,
            maxCompletionTokens: this.settings.completionReserveTokens,
            maxContextTokens: this.settings.contextWindowTokens,
            taskType,
            requestSource: `agent:${agentKind}:turn`,
          }),
        );
        const response = canonical.response;
        const assistantMessage = canonical.message;
        await append(
          AGENT_EVENT_TYPE.ASSISTANT_MESSAGE,
          {
            requestEventId: requestEvent.event?.id || "",
            message: assistantMessage,
            finishReason: response.finishReason,
            reasoningContent: response.reasoningContent,
            usage: response.usage,
          },
          `agent-run:${resolvedRunId}:assistant:${modelRequestCount}`,
        );
        messages.push(assistantMessage);
        assertRunGuard();

        if (response.toolCalls.length === 0) {
          // The runaway guard covers model/tool execution, not the latency of
          // durably recording an already-decided terminal result. Stop its
          // timer before the final write so storage latency cannot race the
          // completed state.
          assertRunGuard();
          const completedElapsedMs = elapsedMs();
          runAbort.dispose();
          await append(
            AGENT_EVENT_TYPE.RUN_COMPLETED,
            {
              content: response.content,
              finishReason: response.finishReason,
              toolCallCount,
              modelRequestCount,
              elapsedMs: completedElapsedMs,
            },
            `agent-run:${resolvedRunId}:completed`,
          );
          terminalWritten = true;
          return {
            runId: resolvedRunId,
            content: response.content,
            finishReason: response.finishReason,
            messages,
            toolCallCount,
            modelRequestCount,
            elapsedMs: completedElapsedMs,
          };
        }

        for (const toolCall of response.toolCalls) {
          assertRunGuard();
          if (toolCallCount >= this.settings.maxToolCalls) {
            throw new BmeAgentGuardError("BME Agent exceeded its tool-call guard", {
              maxToolCalls: this.settings.maxToolCalls,
              toolCallCount,
            });
          }
          toolCallCount += 1;
          const toolEventKey = `agent-run:${resolvedRunId}:tool:${toolCallCount}`;
          await append(
            AGENT_EVENT_TYPE.TOOL_STARTED,
            {
              toolCall,
              toolCallNumber: toolCallCount,
              toolSnapshotFingerprint: toolSnapshot.fingerprint,
            },
            `${toolEventKey}:started`,
          );
          let toolResult;
          try {
            toolResult = await toolSnapshot.execute(toolCall, {
              chatId,
              taskId,
              runId: resolvedRunId,
              agentKind,
              toolCallId: toolCall.id,
              toolCallNumber: toolCallCount,
              signal: runAbort.signal,
            });
          } catch (error) {
            const interruptedMessage = toAgentToolMessage(toolCall, {
              content: stableStringify({
                ok: false,
                error: {
                  code: "tool_interrupted",
                  message: error?.message || String(error),
                },
              }),
            });
            await append(
              AGENT_EVENT_TYPE.TOOL_INTERRUPTED,
              {
                toolCall,
                toolCallNumber: toolCallCount,
                message: interruptedMessage,
                replayed: false,
              },
              `${toolEventKey}:interrupted`,
            );
            throw error;
          }
          const toolMessage = toAgentToolMessage(toolCall, toolResult);
          await append(
            AGENT_EVENT_TYPE.TOOL_FINISHED,
            {
              toolCall,
              toolCallNumber: toolCallCount,
              ok: toolResult.ok,
              message: toolMessage,
            },
            `${toolEventKey}:finished`,
          );
          messages.push(toolMessage);
        }
      }
    } catch (error) {
      if (!terminalWritten && runStarted) {
        let terminalType = AGENT_EVENT_TYPE.RUN_FAILED;
        let outgoing = error;
        if (error instanceof BmeAgentGuardError || runAbort.didTimeOut()) {
          terminalType = AGENT_EVENT_TYPE.RUN_SUSPENDED;
          if (!(error instanceof BmeAgentGuardError)) {
            outgoing = new BmeAgentGuardError("BME Agent exceeded its run time guard", {
              maxRunMs: this.settings.maxRunMs,
              elapsedMs: elapsedMs(),
            });
          }
        } else if (externalSignal?.aborted || error instanceof BmeAgentCancelledError) {
          terminalType = AGENT_EVENT_TYPE.RUN_CANCELLED;
          if (!(error instanceof BmeAgentCancelledError)) {
            outgoing = new BmeAgentCancelledError(error?.message || "BME Agent run was cancelled");
          }
        } else if (isAbortLikeError(error)) {
          terminalType = AGENT_EVENT_TYPE.RUN_SUSPENDED;
          outgoing = new BmeAgentSuspendedError(
            "BME Agent stopped at an interrupted provider or tool boundary",
            { causeCode: error?.code || error?.name || "abort" },
            error,
          );
        } else if (!error?.code?.startsWith?.("bme_agent_")) {
          terminalType = AGENT_EVENT_TYPE.RUN_SUSPENDED;
          outgoing = new BmeAgentSuspendedError(
            "BME Agent stopped at a provider or tool boundary",
            { causeCode: error?.code || error?.name || "provider_error" },
            error,
          );
        }
        try {
          await append(
            terminalType,
            terminalPayload(outgoing, {
              toolCallCount,
              modelRequestCount,
              elapsedMs: elapsedMs(),
              replayedProviderOrTool: false,
            }),
            `agent-run:${resolvedRunId}:terminal:${terminalType}`,
          );
          terminalWritten = true;
        } catch (journalError) {
          outgoing.journalError = journalError;
        }
        throw outgoing;
      }
      throw error;
    } finally {
      runAbort.dispose();
    }
  }
}
