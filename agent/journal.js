import {
  AGENT_EVENT_TYPE,
  isAgentEventTransitionAllowed,
} from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  createDomainId,
  hashDomainValue,
  normalizeStringArray,
} from "../domain/memory-id.js";
import {
  buildMemoryLedgerIndex,
  createMemoryLedgerReplayTransaction,
} from "../domain/memory-ledger.js";
import { materializeAgentRuns } from "../domain/memory-materializer.js";
import { createAgentEvent } from "../domain/memory-records.js";
import { BmeAgentError } from "./errors.js";

export class BmeAgentRunExistsError extends BmeAgentError {
  constructor(runId) {
    super(`BME Agent run already exists: ${runId}`, {
      code: "bme_agent_run_exists",
      details: { runId },
    });
    this.name = "BmeAgentRunExistsError";
  }
}

export function createBmeAgentRunId({ chatId = "", taskId = "", now = Date.now() } = {}) {
  return createDomainId("agent-run", {
    chatId: String(chatId || ""),
    taskId: String(taskId || ""),
    now: Number(now),
    nonce: createDomainId("nonce"),
  });
}

export function projectAgentRunMessages(run) {
  if (!run) return [];
  const messages = [];
  for (const event of run.events || []) {
    if (event.eventType === AGENT_EVENT_TYPE.RUN_STARTED) {
      messages.push(...cloneDomainValue(event.payload?.initialMessages, []));
    } else if (event.eventType === AGENT_EVENT_TYPE.ASSISTANT_MESSAGE) {
      const message = cloneDomainValue(event.payload?.message, null);
      if (message) messages.push(message);
    } else if (
      event.eventType === AGENT_EVENT_TYPE.TOOL_FINISHED ||
      event.eventType === AGENT_EVENT_TYPE.TOOL_INTERRUPTED
    ) {
      const message = cloneDomainValue(event.payload?.message, null);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function interruptionReason(latestEvent) {
  switch (latestEvent?.eventType) {
    case AGENT_EVENT_TYPE.MODEL_REQUESTED:
      return "provider-boundary-interrupted";
    case AGENT_EVENT_TYPE.TOOL_STARTED:
      return "tool-boundary-interrupted";
    default:
      return "agent-run-interrupted";
  }
}

export class DurableAgentJournal {
  constructor({ repository, now = () => Date.now() } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("DurableAgentJournal requires a memory ledger repository");
    }
    this.repository = repository;
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  async getRun(chatId, runId, { fresh = false } = {}) {
    const ledger = await this.repository.load(chatId, { fresh });
    return materializeAgentRuns(ledger).runs.get(String(runId || "").trim()) || null;
  }

  async startRun({
    chatId,
    runId,
    taskId,
    agentKind,
    initialMessages = [],
    sourceRecordIds = [],
    toolSnapshot = null,
    runtimeSettings = {},
    metadata = {},
  } = {}) {
    const createdAt = this.now();
    let appendedEvent = null;
    let transactionWasBuilt = false;
    const result = await this.repository.transact(chatId, (ledger) => {
      if (materializeAgentRuns(ledger).runs.has(runId)) {
        const replayCommit = buildMemoryLedgerIndex(ledger).commitsByIdempotencyKey.get(
          `agent-run:${runId}:start`,
        );
        if (transactionWasBuilt && replayCommit) {
          appendedEvent = ledger.records.find(
            (record) => replayCommit.appendedRecordIds.includes(record.id),
          );
          return createMemoryLedgerReplayTransaction(ledger, replayCommit);
        }
        throw new BmeAgentRunExistsError(runId);
      }
      const event = createAgentEvent({
        chatId: ledger.chatId,
        runId,
        taskId,
        agentKind,
        sequence: 0,
        eventType: AGENT_EVENT_TYPE.RUN_STARTED,
        sourceRecordIds,
        payload: {
          initialMessages: cloneDomainValue(initialMessages, []),
          toolSnapshot: toolSnapshot
            ? {
                fingerprint: String(toolSnapshot.fingerprint || ""),
                names: cloneDomainValue(toolSnapshot.names, []),
                definitions: cloneDomainValue(toolSnapshot.definitions, []),
              }
            : null,
          runtimeSettings: cloneDomainValue(runtimeSettings, {}),
          metadata: cloneDomainValue(metadata, {}),
        },
        createdAt,
      });
      appendedEvent = event;
      transactionWasBuilt = true;
      return {
        baseRevision: ledger.revision,
        idempotencyKey: `agent-run:${runId}:start`,
        records: [event],
        readRecordIds: sourceRecordIds,
        sourceEvidenceIds: [],
        reason: `agent-run-start:${agentKind || "agent"}`,
        now: createdAt,
      };
    });
    return {
      ...result,
      event:
        result.appendedRecords?.find((record) => record.id === appendedEvent?.id) ||
        appendedEvent,
    };
  }

  async append({
    chatId,
    runId,
    eventType,
    payload = {},
    sourceRecordIds = [],
    eventKey = "",
  } = {}) {
    const createdAt = this.now();
    let appendedEvent = null;
    const operationKey = String(eventKey || "").trim() ||
      `agent-run:${runId}:append:${createDomainId("operation")}`;
    const result = await this.repository.transact(chatId, (ledger) => {
      const replayCommit = buildMemoryLedgerIndex(ledger).commitsByIdempotencyKey.get(
        operationKey,
      );
      if (replayCommit) {
        appendedEvent = ledger.records.find(
          (record) => replayCommit.appendedRecordIds.includes(record.id),
        );
        const intendedFingerprint = hashDomainValue({
          eventType,
          payload,
          sourceRecordIds: normalizeStringArray(sourceRecordIds),
        });
        const existingFingerprint = hashDomainValue({
          eventType: appendedEvent?.eventType,
          payload: appendedEvent?.payload,
          sourceRecordIds: normalizeStringArray(appendedEvent?.sourceRecordIds),
        });
        if (intendedFingerprint !== existingFingerprint) {
          throw new BmeAgentError("Agent event idempotency key was reused with another payload", {
            code: "memory_ledger_conflict",
            details: { operationKey, existingEventId: appendedEvent?.id || "" },
          });
        }
        return createMemoryLedgerReplayTransaction(ledger, replayCommit);
      }
      const run = materializeAgentRuns(ledger).runs.get(runId);
      if (!run) throw new BmeAgentError(`BME Agent run not found: ${runId}`, {
        code: "bme_agent_run_missing",
        details: { chatId, runId },
      });
      if (run.terminal) {
        throw new BmeAgentError(`BME Agent run is already ${run.status}: ${runId}`, {
          code: "bme_agent_run_terminal",
          details: { chatId, runId, status: run.status },
        });
      }
      const previous = run.latestEvent;
      if (!isAgentEventTransitionAllowed(previous.eventType, eventType)) {
        throw new BmeAgentError(
          `Invalid Agent event transition: ${previous.eventType} -> ${eventType}`,
          {
            code: "bme_agent_event_transition",
            details: { runId, previousEventId: previous.id, eventType },
          },
        );
      }
      const event = createAgentEvent({
        chatId: ledger.chatId,
        runId,
        taskId: run.taskId,
        agentKind: run.agentKind,
        sequence: Number(previous.sequence) + 1,
        eventType,
        previousEventId: previous.id,
        sourceRecordIds,
        payload,
        createdAt,
      });
      appendedEvent = event;
      return {
        baseRevision: ledger.revision,
        idempotencyKey: operationKey,
        records: [event],
        readRecordIds: [previous.id, ...sourceRecordIds],
        sourceEvidenceIds: [],
        reason: `agent-event:${eventType}`,
        now: createdAt,
      };
    });
    return {
      ...result,
      event:
        result.appendedRecords?.find((record) => record.id === appendedEvent?.id) ||
        appendedEvent,
    };
  }

  async recoverInterruptedRuns(chatId, { reason = "", agentKind = "" } = {}) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const active = materializeAgentRuns(ledger).active.filter(
      (run) => !agentKind || run.agentKind === agentKind,
    );
    const recovered = [];
    for (const run of active) {
      const resolvedReason = reason || interruptionReason(run.latestEvent);
      const result = await this.append({
        chatId,
        runId: run.runId,
        eventType: AGENT_EVENT_TYPE.RUN_SUSPENDED,
        eventKey: `agent-run:${run.runId}:recovery-suspend`,
        payload: {
          reason: resolvedReason,
          interruptedAfterEventId: run.latestEvent?.id || "",
          interruptedAfterEventType: run.latestEvent?.eventType || "",
          replayedProviderOrTool: false,
        },
      });
      recovered.push(result.event);
    }
    return recovered;
  }
}
