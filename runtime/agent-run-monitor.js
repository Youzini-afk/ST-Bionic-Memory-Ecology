import { AGENT_EVENT_TYPE } from "../domain/memory-contract.js";

const TERMINAL_STATUS_BY_EVENT = Object.freeze({
  [AGENT_EVENT_TYPE.RUN_COMPLETED]: "completed",
  [AGENT_EVENT_TYPE.RUN_SUSPENDED]: "suspended",
  [AGENT_EVENT_TYPE.RUN_FAILED]: "failed",
  [AGENT_EVENT_TYPE.RUN_CANCELLED]: "cancelled",
});

function clone(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeToolCall(toolCall = {}) {
  const fn = toolCall?.function || toolCall || {};
  return {
    id: String(toolCall?.id || ""),
    name: String(fn?.name || toolCall?.name || ""),
    arguments: String(fn?.arguments ?? toolCall?.arguments ?? ""),
  };
}

function sanitizeEvent(event = {}) {
  const payload = clone(event?.payload, {}) || {};
  if (event?.eventType === AGENT_EVENT_TYPE.RUN_STARTED) {
    return {
      ...clone(event, {}),
      payload: {
        initialMessageCount: Array.isArray(payload.initialMessages)
          ? payload.initialMessages.length
          : 0,
        toolNames: Array.isArray(payload?.toolSnapshot?.names)
          ? payload.toolSnapshot.names.map(String)
          : [],
        runtimeSettings: clone(payload.runtimeSettings, {}),
        metadata: clone(payload.metadata, {}),
      },
    };
  }
  return { ...clone(event, {}), payload };
}

function addUsage(target = {}, usage = null) {
  if (!usage || typeof usage !== "object") return target;
  const next = { ...target };
  for (const [key, value] of Object.entries(usage)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      next[key] = Number(next[key] || 0) + numeric;
    }
  }
  return next;
}

function phaseForEvent(eventType = "") {
  switch (eventType) {
    case AGENT_EVENT_TYPE.RUN_STARTED:
      return "starting";
    case AGENT_EVENT_TYPE.MODEL_REQUESTED:
      return "model";
    case AGENT_EVENT_TYPE.ASSISTANT_MESSAGE:
      return "decision";
    case AGENT_EVENT_TYPE.TOOL_STARTED:
      return "tool";
    case AGENT_EVENT_TYPE.TOOL_FINISHED:
      return "tool-result";
    case AGENT_EVENT_TYPE.TOOL_INTERRUPTED:
      return "tool-interrupted";
    case AGENT_EVENT_TYPE.CONTEXT_SUMMARY_CREATED:
    case AGENT_EVENT_TYPE.CONTEXT_COMPACTED:
      return "compaction";
    default:
      return TERMINAL_STATUS_BY_EVENT[eventType] || "running";
  }
}

function createRun(event = {}, now = Date.now()) {
  return {
    runId: String(event?.runId || ""),
    chatId: String(event?.chatId || ""),
    taskId: String(event?.taskId || ""),
    agentKind: String(event?.agentKind || "memory-agent"),
    taskType: "",
    status: "running",
    phase: "starting",
    terminal: false,
    startedAt: normalizeTimestamp(event?.createdAt, now),
    updatedAt: normalizeTimestamp(event?.createdAt, now),
    finishedAt: 0,
    elapsedMs: 0,
    modelRequestCount: 0,
    toolCallCount: 0,
    usage: {},
    metadata: {},
    activeTool: null,
    substage: null,
    outcome: null,
    stream: null,
    events: [],
    eventIds: new Set(),
  };
}

function publicRun(run, cancellable) {
  const copy = clone(run, {}) || {};
  delete copy.eventIds;
  return {
    ...copy,
    cancellable: Boolean(cancellable && !run.terminal),
  };
}

function runReceipt(run, cancellable) {
  return run
    ? {
        runId: run.runId,
        status: run.status,
        phase: run.phase,
        terminal: run.terminal,
        cancellable: Boolean(cancellable && !run.terminal),
      }
    : null;
}

export class AgentRunMonitor {
  constructor({ now = () => Date.now() } = {}) {
    this.now = typeof now === "function" ? now : () => Date.now();
    this.runs = new Map();
    this.controls = new Map();
    this.listeners = new Set();
    this.revision = 0;
    this.updatedAt = 0;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerControl({ runId, cancel } = {}) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId || typeof cancel !== "function") return () => {};
    this.controls.set(normalizedRunId, cancel);
    this.#touch(normalizedRunId, "control-attached");
    return () => {
      if (this.controls.get(normalizedRunId) === cancel) {
        this.controls.delete(normalizedRunId);
        this.#touch(normalizedRunId, "control-detached");
      }
    };
  }

  cancel(runId, reason = "Cancelled by user") {
    const normalizedRunId = String(runId || "").trim();
    const control = this.controls.get(normalizedRunId);
    const run = this.runs.get(normalizedRunId);
    if (!control || run?.terminal) {
      return { ok: false, runId: normalizedRunId, reason: "run-not-active" };
    }
    try {
      if (run) {
        run.phase = "cancelling";
        run.updatedAt = this.now();
        this.#touch(normalizedRunId, "cancelling");
      }
      control(String(reason || "Cancelled by user"));
      return { ok: true, runId: normalizedRunId };
    } catch (error) {
      return {
        ok: false,
        runId: normalizedRunId,
        reason: error?.message || String(error),
      };
    }
  }

  recordEvent(event = {}) {
    const runId = String(event?.runId || "").trim();
    const eventId = String(event?.id || "").trim();
    if (!runId || !eventId) return null;
    let run = this.runs.get(runId);
    if (!run) {
      run = createRun(event, this.now());
      this.runs.set(runId, run);
    }
    if (run.eventIds.has(eventId)) return runReceipt(run, this.controls.has(runId));

    const safeEvent = sanitizeEvent(event);
    run.eventIds.add(eventId);
    run.events.push(safeEvent);
    run.chatId = String(event?.chatId || run.chatId);
    run.taskId = String(event?.taskId || run.taskId);
    run.agentKind = String(event?.agentKind || run.agentKind);
    run.updatedAt = normalizeTimestamp(event?.createdAt, this.now());
    run.phase = phaseForEvent(event?.eventType);
    const payload = safeEvent.payload || {};

    if (event?.eventType === AGENT_EVENT_TYPE.RUN_STARTED) {
      run.startedAt = normalizeTimestamp(event?.createdAt, run.startedAt);
      run.metadata = clone(payload.metadata, {}) || {};
      run.taskType = String(run.metadata?.taskType || "");
    } else if (event?.eventType === AGENT_EVENT_TYPE.MODEL_REQUESTED) {
      run.modelRequestCount = Math.max(
        run.modelRequestCount,
        Number(payload.requestNumber || 0),
      );
      run.stream = {
        requestNumber: Number(payload.requestNumber || run.modelRequestCount),
        purpose: String(payload.purpose || "agent-turn"),
        active: true,
        chunkCount: 0,
        receivedChars: 0,
        receivedReasoningChars: 0,
        content: "",
        reasoningContent: "",
        toolCalls: [],
        updatedAt: run.updatedAt,
      };
    } else if (event?.eventType === AGENT_EVENT_TYPE.ASSISTANT_MESSAGE) {
      run.usage = addUsage(run.usage, payload.usage);
      run.stream = {
        ...(run.stream || {}),
        active: false,
        content: String(payload?.message?.content || ""),
        reasoningContent: String(payload.reasoningContent || ""),
        toolCalls: Array.isArray(payload?.message?.tool_calls)
          ? payload.message.tool_calls.map(normalizeToolCall)
          : [],
        updatedAt: run.updatedAt,
      };
    } else if (event?.eventType === AGENT_EVENT_TYPE.CONTEXT_SUMMARY_CREATED) {
      run.stream = {
        ...(run.stream || {}),
        active: false,
        content: String(payload.summary || ""),
        updatedAt: run.updatedAt,
      };
    } else if (event?.eventType === AGENT_EVENT_TYPE.TOOL_STARTED) {
      run.toolCallCount = Math.max(
        run.toolCallCount,
        Number(payload.toolCallNumber || 0),
      );
      run.activeTool = {
        ...normalizeToolCall(payload.toolCall),
        toolCallNumber: Number(payload.toolCallNumber || 0),
        status: "running",
      };
    } else if (
      event?.eventType === AGENT_EVENT_TYPE.TOOL_FINISHED ||
      event?.eventType === AGENT_EVENT_TYPE.TOOL_INTERRUPTED
    ) {
      run.toolCallCount = Math.max(
        run.toolCallCount,
        Number(payload.toolCallNumber || 0),
      );
      run.activeTool = null;
      run.substage = null;
    }

    const terminalStatus = TERMINAL_STATUS_BY_EVENT[event?.eventType];
    if (terminalStatus) {
      run.status = terminalStatus;
      run.phase = terminalStatus;
      run.terminal = true;
      run.finishedAt = run.updatedAt;
      run.elapsedMs = Number(payload.elapsedMs || run.finishedAt - run.startedAt || 0);
      run.modelRequestCount = Math.max(
        run.modelRequestCount,
        Number(payload.modelRequestCount || 0),
      );
      run.toolCallCount = Math.max(
        run.toolCallCount,
        Number(payload.toolCallCount || 0),
      );
      if (run.stream) run.stream.active = false;
      run.activeTool = null;
      run.substage = null;
    }

    this.#touch(runId, "event");
    return runReceipt(run, this.controls.has(runId));
  }

  recordStreamDelta({ runId, requestNumber = 0, purpose = "", ...delta } = {}) {
    const normalizedRunId = String(runId || "").trim();
    const run = this.runs.get(normalizedRunId);
    if (!run || run.terminal) return null;
    if (!run.stream || Number(run.stream.requestNumber) !== Number(requestNumber)) {
      run.stream = {
        requestNumber: Number(requestNumber || run.modelRequestCount || 0),
        purpose: String(purpose || "agent-turn"),
        active: true,
        chunkCount: 0,
        receivedChars: 0,
        receivedReasoningChars: 0,
        content: "",
        reasoningContent: "",
        toolCalls: [],
        updatedAt: this.now(),
      };
    }
    run.stream.active = true;
    run.stream.chunkCount = Number(delta.chunkCount || run.stream.chunkCount || 0);
    run.stream.receivedChars = Number(
      delta.receivedChars ?? run.stream.receivedChars ?? 0,
    );
    run.stream.receivedReasoningChars = Number(
      delta.receivedReasoningChars ?? run.stream.receivedReasoningChars ?? 0,
    );
    run.stream.content += String(delta.contentDelta || "");
    run.stream.reasoningContent += String(delta.reasoningDelta || "");
    if (Array.isArray(delta.toolCalls)) {
      run.stream.toolCalls = delta.toolCalls.map(normalizeToolCall);
    }
    run.stream.updatedAt = this.now();
    run.updatedAt = run.stream.updatedAt;
    run.phase = purpose === "context-compaction" ? "compaction" : "streaming";
    this.#touch(normalizedRunId, "stream");
    return runReceipt(run, this.controls.has(normalizedRunId));
  }

  recordOutcome({ runId, outcome = null } = {}) {
    const normalizedRunId = String(runId || "").trim();
    const run = this.runs.get(normalizedRunId);
    if (!run) return null;
    run.outcome = clone(outcome, null);
    run.updatedAt = this.now();
    this.#touch(normalizedRunId, "outcome");
    return runReceipt(run, this.controls.has(normalizedRunId));
  }

  recordStageStatus({ runId, stage = "", text = "", meta = "", level = "info" } = {}) {
    const normalizedRunId = String(runId || "").trim();
    const run = this.runs.get(normalizedRunId);
    if (!run || run.terminal) return null;
    run.substage = {
      stage: String(stage || ""),
      text: String(text || ""),
      meta: String(meta || ""),
      level: String(level || "info"),
      updatedAt: this.now(),
    };
    run.updatedAt = run.substage.updatedAt;
    this.#touch(normalizedRunId, "stage");
    return runReceipt(run, this.controls.has(normalizedRunId));
  }

  getSnapshot({ chatId = "" } = {}) {
    const normalizedChatId = String(chatId || "").trim();
    const runs = [...this.runs.values()]
      .filter((run) => !normalizedChatId || run.chatId === normalizedChatId)
      .sort((left, right) => {
        if (left.terminal !== right.terminal) return left.terminal ? 1 : -1;
        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      })
      .map((run) => publicRun(run, this.controls.has(run.runId)));
    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      activeCount: runs.filter((run) => !run.terminal).length,
      runs,
    };
  }

  #touch(runId, type) {
    this.revision += 1;
    this.updatedAt = this.now();
    const update = Object.freeze({
      revision: this.revision,
      updatedAt: this.updatedAt,
      runId: String(runId || ""),
      type: String(type || "update"),
    });
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        // Observers never affect Agent execution.
      }
    }
  }
}

export function createAgentRunMonitor(options = {}) {
  return new AgentRunMonitor(options);
}
