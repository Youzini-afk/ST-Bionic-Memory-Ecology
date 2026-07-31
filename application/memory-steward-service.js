import { createBmeAgentRunId } from "../agent/journal.js";
import { buildMemoryStewardMessages } from "../agent/memory-steward-prompt.js";
import {
  MEMORY_INBOX_STATUS,
  MEMORY_RECORD_KIND,
} from "../domain/memory-contract.js";
import { cloneDomainValue, createDomainId } from "../domain/memory-id.js";
import {
  listRunnableInboxItems,
  planInboxBatchTransition,
} from "../domain/memory-inbox.js";
import {
  buildMemoryLedgerIndex,
  createMemoryLedgerReplayTransaction,
} from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";

const MEMORY_STEWARD_AGENT_KIND = "memory-steward";

function parseToolResult(event) {
  const content = String(event?.payload?.message?.content || "");
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function toolName(event) {
  return String(
    event?.payload?.toolCall?.name ||
      event?.payload?.toolCall?.function?.name ||
      "",
  );
}

function inferDurableOutcome(ledger, run) {
  if (!run) return { kind: "pending" };
  for (const event of [...(run.events || [])].reverse()) {
    if (
      event.eventType !== "tool_finished" ||
      !["memory_commit_changes", "memory_complete_without_changes"].includes(
        toolName(event),
      )
    ) {
      continue;
    }
    const result = parseToolResult(event);
    if (toolName(event) === "memory_commit_changes" && result?.committed === true) {
      return { kind: "committed", ...result };
    }
    if (
      toolName(event) === "memory_complete_without_changes" &&
      result?.kind === "no_change"
    ) {
      return { kind: "no_change", ...result };
    }
  }
  const committedRecords = ledger.records.filter(
    (record) =>
      (record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION ||
        record.kind === MEMORY_RECORD_KIND.RELATION_REVISION) &&
      record.agentTaskId === run.taskId,
  );
  if (committedRecords.length > 0) {
    return {
      kind: "committed",
      committed: true,
      recoveredFromLedger: true,
      memoryRevisionIds: committedRecords
        .filter((record) => record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION)
        .map((record) => record.id),
      relationRevisionIds: committedRecords
        .filter((record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION)
        .map((record) => record.id),
    };
  }
  return { kind: "pending" };
}

function retryAvailableAt(now, attempt) {
  const exponent = Math.max(0, Math.min(8, Number(attempt || 1) - 1));
  return Number(now) + Math.min(5 * 60 * 1000, 1000 * 2 ** exponent);
}

export class MemoryStewardService {
  constructor({
    repository,
    agentRuntime,
    toolset,
    workerId = "memory-steward",
    instructions = "",
    now = () => Date.now(),
    onStatus = null,
  } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("MemoryStewardService requires a memory ledger repository");
    }
    if (!agentRuntime || typeof agentRuntime.run !== "function") {
      throw new TypeError("MemoryStewardService requires a BME Agent runtime");
    }
    if (!toolset || typeof toolset.openTask !== "function") {
      throw new TypeError("MemoryStewardService requires a Memory Steward toolset");
    }
    this.repository = repository;
    this.agentRuntime = agentRuntime;
    this.toolset = toolset;
    this.workerId = String(workerId || "memory-steward");
    this.instructions = String(instructions || "");
    this.now = typeof now === "function" ? now : () => Date.now();
    this.onStatus = typeof onStatus === "function" ? onStatus : null;
    this._workers = new Map();
  }

  _emit(chatId, status, details = {}) {
    try {
      this.onStatus?.({ chatId, status, ...cloneDomainValue(details, {}) });
    } catch {
      // Status reporting must never change durable task semantics.
    }
  }

  async _transactPlanned(chatId, idempotencyKey, planner) {
    let latestPlan = null;
    const persisted = await this.repository.transact(chatId, (ledger) => {
      const existing = buildMemoryLedgerIndex(ledger).commitsByIdempotencyKey.get(
        idempotencyKey,
      );
      if (existing) {
        return createMemoryLedgerReplayTransaction(ledger, existing);
      }
      latestPlan = planner(ledger);
      return latestPlan?.transaction || null;
    });
    return { persisted, plan: latestPlan };
  }

  async _claimRunnableBatch(chatId, items) {
    const inboxIds = items.map((item) => item.inboxId);
    const sourceEvidenceIds = [
      ...new Set(items.flatMap((item) => item.sourceRecordIds || [])),
    ];
    const startedAt = this.now();
    const taskId = createDomainId("memory-steward-task", {
      chatId,
      inboxRevisionIds: items.map((item) => item.id),
    });
    const runId = createBmeAgentRunId({ chatId, taskId, now: startedAt });
    const idempotencyKey = `memory-steward-claim:${runId}`;
    const { persisted, plan } = await this._transactPlanned(
      chatId,
      idempotencyKey,
      (ledger) =>
        planInboxBatchTransition(ledger, {
          inboxIds,
          expectedRevisionIds: items.map((item) => item.id),
          status: MEMORY_INBOX_STATUS.CLAIMED,
          claimId: runId,
          claimOwner: this.workerId,
          payloadPatch: { agentRunId: runId, agentTaskId: taskId },
          idempotencyKey,
          now: startedAt,
        }),
    );
    const claimedItems = (persisted.appendedRecords || []).filter(
      (record) => record.kind === MEMORY_RECORD_KIND.INBOX_ITEM,
    );
    return {
      taskId,
      runId,
      inboxIds,
      sourceEvidenceIds,
      claimedItems: claimedItems.length > 0 ? claimedItems : plan?.inboxItems || [],
    };
  }

  async _settleBatch(chatId, assignment, outcome, { error = null } = {}) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const view = materializeMemoryLedger(ledger);
    const claimed = assignment.inboxIds
      .map((inboxId) => view.inbox.latestByInboxId.get(inboxId))
      .filter((item) => item?.status === MEMORY_INBOX_STATUS.CLAIMED);
    if (claimed.length === 0) return { settled: false, reason: "already-settled" };
    const completed = outcome.kind === "committed" || outcome.kind === "no_change";
    const status = completed
      ? MEMORY_INBOX_STATUS.COMPLETED
      : MEMORY_INBOX_STATUS.DEFERRED;
    const now = this.now();
    const highestAttempt = Math.max(...claimed.map((item) => Number(item.attempt || 1)));
    const idempotencyKey = `memory-steward-settle:${assignment.runId}:${status}`;
    const note = completed
      ? outcome.kind
      : String(error?.message || "Agent run ended without a durable task disposition");
    const settled = await this._transactPlanned(
      chatId,
      idempotencyKey,
      (latestLedger) =>
        planInboxBatchTransition(latestLedger, {
          inboxIds: claimed.map((item) => item.inboxId),
          status,
          expectedStatus: MEMORY_INBOX_STATUS.CLAIMED,
          availableAt: completed ? undefined : retryAvailableAt(now, highestAttempt),
          note,
          payloadPatch: {
            memoryStewardOutcome: outcome.kind,
            memoryStewardCommitId: outcome.commitId || "",
            memoryStewardError: completed ? "" : note,
          },
          idempotencyKey,
          now,
        }),
    );
    return {
      settled: true,
      completed,
      status,
      outcome,
      ledgerRevision: settled.persisted.ledger?.revision || 0,
    };
  }

  async _processBatch(chatId, items, signal) {
    const assignment = await this._claimRunnableBatch(chatId, items);
    this.toolset.openTask({
      runId: assignment.runId,
      chatId,
      taskId: assignment.taskId,
      inboxIds: assignment.inboxIds,
      sourceEvidenceIds: assignment.sourceEvidenceIds,
    });
    this._emit(chatId, "running", {
      runId: assignment.runId,
      inboxCount: assignment.inboxIds.length,
    });
    let runResult = null;
    let runError = null;
    try {
      runResult = await this.agentRuntime.run({
        chatId,
        taskId: assignment.taskId,
        runId: assignment.runId,
        agentKind: MEMORY_STEWARD_AGENT_KIND,
        taskType: "memory_steward",
        sourceRecordIds: assignment.sourceEvidenceIds,
        messages: buildMemoryStewardMessages({
          taskId: assignment.taskId,
          inboxIds: assignment.inboxIds,
          sourceEvidenceIds: assignment.sourceEvidenceIds,
          instructions: this.instructions,
        }),
        metadata: {
          inboxIds: assignment.inboxIds,
          sourceEvidenceIds: assignment.sourceEvidenceIds,
        },
        signal,
      });
    } catch (error) {
      runError = error;
    }
    const outcome = this.toolset.getOutcome(assignment.runId);
    let settled;
    try {
      settled = await this._settleBatch(chatId, assignment, outcome, {
        error: runError,
      });
    } finally {
      this.toolset.closeTask(assignment.runId);
    }
    this._emit(chatId, settled.completed ? "completed" : "deferred", {
      runId: assignment.runId,
      outcome: outcome.kind,
      error: runError?.message || "",
    });
    return { assignment, runResult, runError, outcome, settled };
  }

  async recover(chatId) {
    await this.agentRuntime.recoverInterruptedRuns(chatId, {
      agentKind: MEMORY_STEWARD_AGENT_KIND,
    });
    const ledger = await this.repository.load(chatId, { fresh: true });
    const view = materializeMemoryLedger(ledger);
    const groups = new Map();
    for (const item of view.inbox.claimed) {
      const runId = String(item.payload?.agentRunId || item.claimId || "");
      const bucket = groups.get(runId) || [];
      bucket.push(item);
      groups.set(runId, bucket);
    }
    const recovered = [];
    for (const [runId, items] of groups) {
      const freshLedger = await this.repository.load(chatId, { fresh: true });
      const run = materializeMemoryLedger(freshLedger).agent.runs.get(runId) || null;
      const outcome = inferDurableOutcome(freshLedger, run);
      const assignment = {
        runId,
        taskId: run?.taskId || items[0]?.payload?.agentTaskId || "",
        inboxIds: items.map((item) => item.inboxId),
      };
      recovered.push(
        await this._settleBatch(chatId, assignment, outcome, {
          error:
            outcome.kind === "pending"
              ? new Error("Recovered interrupted Memory Steward task")
              : null,
        }),
      );
    }
    return recovered;
  }

  async _drain(chatId, signal) {
    const completed = [];
    while (!signal?.aborted) {
      const ledger = await this.repository.load(chatId, { fresh: true });
      const runnable = listRunnableInboxItems(ledger, { now: this.now() });
      if (runnable.length === 0) break;
      try {
        completed.push(await this._processBatch(chatId, runnable, signal));
      } catch (error) {
        if (
          /inbox (?:status|revision) changed|invalid inbox transition|inbox item is not available/.test(
            String(error?.message || ""),
          )
        ) {
          continue;
        }
        throw error;
      }
    }
    return completed;
  }

  wake(chatId, { signal = null } = {}) {
    const key = String(chatId || "").trim();
    if (!key) throw new TypeError("Memory Steward wake requires chatId");
    const existing = this._workers.get(key);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const worker = { rerun: false, promise: null };
    worker.promise = (async () => {
      const results = [];
      await this.recover(key);
      do {
        worker.rerun = false;
        results.push(...(await this._drain(key, signal)));
      } while (worker.rerun && !signal?.aborted);
      return results;
    })().finally(() => {
      if (this._workers.get(key) === worker) this._workers.delete(key);
    });
    this._workers.set(key, worker);
    return worker.promise;
  }

  inspect(chatId) {
    const worker = this._workers.get(String(chatId || "").trim());
    return {
      chatId: String(chatId || "").trim(),
      running: Boolean(worker),
      rerunRequested: worker?.rerun === true,
    };
  }
}

export { MEMORY_STEWARD_AGENT_KIND, inferDurableOutcome };
