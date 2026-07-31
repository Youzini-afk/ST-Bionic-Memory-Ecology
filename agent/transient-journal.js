import {
  AGENT_EVENT_TYPE,
  isAgentEventTransitionAllowed,
  isTerminalAgentEventType,
} from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  createDomainId,
  hashDomainValue,
} from "../domain/memory-id.js";
import { BmeAgentError } from "./errors.js";

function runKey(chatId, runId) {
  return `${String(chatId || "").trim()}::${String(runId || "").trim()}`;
}

function cloneRun(run) {
  return run ? cloneDomainValue(run, null) : null;
}

/**
 * A control-plane journal for graph-backed Agents.
 *
 * Memory mutations never live here: they still commit through the existing
 * per-chat graph persistence path. This journal only protects one live Agent
 * loop from duplicate tool/model events and intentionally disappears on page
 * reload, where an uncommitted task is safe to plan again from the graph.
 */
export class TransientAgentJournal {
  constructor({ now = () => Date.now() } = {}) {
    this.now = typeof now === "function" ? now : () => Date.now();
    this.runs = new Map();
  }

  async getRun(chatId, runId) {
    return cloneRun(this.runs.get(runKey(chatId, runId)) || null);
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
    const key = runKey(chatId, runId);
    if (!String(chatId || "").trim() || !String(runId || "").trim()) {
      throw new TypeError("Transient Agent journal requires chatId and runId");
    }
    if (this.runs.has(key)) {
      throw new BmeAgentError(`BME Agent run already exists: ${runId}`, {
        code: "bme_agent_run_exists",
        details: { chatId, runId },
      });
    }
    const event = {
      id: createDomainId("transient-agent-event", { chatId, runId, sequence: 0 }),
      chatId: String(chatId),
      runId: String(runId),
      taskId: String(taskId || ""),
      agentKind: String(agentKind || "memory-agent"),
      sequence: 0,
      eventType: AGENT_EVENT_TYPE.RUN_STARTED,
      previousEventId: "",
      sourceRecordIds: cloneDomainValue(sourceRecordIds, []),
      payload: {
        initialMessages: cloneDomainValue(initialMessages, []),
        toolSnapshot: cloneDomainValue(toolSnapshot, null),
        runtimeSettings: cloneDomainValue(runtimeSettings, {}),
        metadata: cloneDomainValue(metadata, {}),
      },
      createdAt: this.now(),
    };
    const run = {
      chatId: event.chatId,
      runId: event.runId,
      taskId: event.taskId,
      agentKind: event.agentKind,
      events: [event],
      eventKeys: {},
      status: "running",
      terminal: false,
    };
    this.runs.set(key, run);
    return { event: cloneDomainValue(event, event), replayed: false };
  }

  async append({
    chatId,
    runId,
    eventType,
    payload = {},
    sourceRecordIds = [],
    eventKey = "",
  } = {}) {
    const key = runKey(chatId, runId);
    const run = this.runs.get(key);
    if (!run) {
      throw new BmeAgentError(`BME Agent run not found: ${runId}`, {
        code: "bme_agent_run_missing",
        details: { chatId, runId },
      });
    }
    const operationKey = String(eventKey || "").trim();
    const fingerprint = hashDomainValue({ eventType, payload, sourceRecordIds });
    if (operationKey && run.eventKeys[operationKey]) {
      const existing = run.eventKeys[operationKey];
      if (existing.fingerprint !== fingerprint) {
        throw new BmeAgentError(
          "Agent event idempotency key was reused with another payload",
          {
            code: "bme_agent_event_conflict",
            details: { operationKey, existingEventId: existing.eventId },
          },
        );
      }
      return {
        event: cloneDomainValue(
          run.events.find((event) => event.id === existing.eventId),
          null,
        ),
        replayed: true,
      };
    }
    const previous = run.events.at(-1);
    if (!isAgentEventTransitionAllowed(previous?.eventType, eventType)) {
      throw new BmeAgentError(
        `Invalid Agent event transition: ${previous?.eventType || "missing"} -> ${eventType}`,
        {
          code: "bme_agent_event_transition",
          details: { chatId, runId, eventType },
        },
      );
    }
    const sequence = Number(previous.sequence) + 1;
    const event = {
      id: createDomainId("transient-agent-event", {
        chatId,
        runId,
        sequence,
        eventType,
      }),
      chatId: run.chatId,
      runId: run.runId,
      taskId: run.taskId,
      agentKind: run.agentKind,
      sequence,
      eventType,
      previousEventId: previous.id,
      sourceRecordIds: cloneDomainValue(sourceRecordIds, []),
      payload: cloneDomainValue(payload, {}),
      createdAt: this.now(),
    };
    run.events.push(event);
    if (operationKey) {
      run.eventKeys[operationKey] = { eventId: event.id, fingerprint };
    }
    run.terminal = isTerminalAgentEventType(eventType);
    run.status = run.terminal
      ? String(eventType).replace(/^run_/, "")
      : "running";
    return { event: cloneDomainValue(event, event), replayed: false };
  }

  async recoverInterruptedRuns(chatId, { agentKind = "" } = {}) {
    const recovered = [];
    for (const run of this.runs.values()) {
      if (
        run.chatId !== String(chatId || "").trim() ||
        run.terminal ||
        (agentKind && run.agentKind !== agentKind)
      ) {
        continue;
      }
      const result = await this.append({
        chatId: run.chatId,
        runId: run.runId,
        eventType: AGENT_EVENT_TYPE.RUN_SUSPENDED,
        eventKey: `agent-run:${run.runId}:transient-recovery`,
        payload: {
          reason: "transient-agent-run-interrupted",
          replayedProviderOrTool: false,
        },
      });
      recovered.push(result.event);
    }
    return recovered;
  }

  inspect(chatId = "") {
    const normalizedChatId = String(chatId || "").trim();
    return [...this.runs.values()]
      .filter((run) => !normalizedChatId || run.chatId === normalizedChatId)
      .map(cloneRun);
  }
}
