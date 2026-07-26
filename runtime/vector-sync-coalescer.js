export function normalizeVectorSyncRange(range = null) {
  if (
    range &&
    Number.isFinite(Number(range.start)) &&
    Number.isFinite(Number(range.end))
  ) {
    const start = Math.floor(Number(range.start));
    const end = Math.floor(Number(range.end));
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }
  return null;
}

export function mergeVectorSyncRange(current = null, next = null) {
  const currentRange = normalizeVectorSyncRange(current);
  const nextRange = normalizeVectorSyncRange(next);
  if (!currentRange || !nextRange) return null;
  return {
    start: Math.min(currentRange.start, nextRange.start),
    end: Math.max(currentRange.end, nextRange.end),
  };
}

function createTaskRecord(task = {}) {
  const id = String(task.id || `vector-sync:${Date.now()}`);
  return {
    id,
    chatId: String(task.chatId || "").trim(),
    modelScope: String(task.modelScope || "").trim(),
    range: normalizeVectorSyncRange(task.range),
    reason:
      String(task.reason || "background-vector-sync").trim() ||
      "background-vector-sync",
    mode: String(task.mode || "balanced").trim() || "balanced",
    stale: false,
    requestedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function canMergeTask(left = null, right = null) {
  return Boolean(
    left &&
      right &&
      !left.stale &&
      left.chatId === right.chatId &&
      left.modelScope === right.modelScope,
  );
}

function mergeTaskInto(target, incoming) {
  target.range = mergeVectorSyncRange(target.range, incoming.range);
  target.reason =
    target.reason === incoming.reason
      ? target.reason
      : `${target.reason}+${incoming.reason}`;
  target.mode = incoming.mode || target.mode;
  target.updatedAt = Date.now();
  return target;
}

function markStale(task = null, reason = "stale") {
  if (!task) return;
  task.stale = true;
  task.clearReason = String(reason || "stale");
}

export function createVectorSyncCoalescer() {
  let active = null;
  let pending = null;

  return {
    clear(reason = "clear") {
      markStale(active, reason);
      markStale(pending, reason);
      active = null;
      pending = null;
    },
    getActive() {
      return active;
    },
    getPending() {
      return pending;
    },
    enqueue(task = {}) {
      const incoming = createTaskRecord(task);
      if (canMergeTask(active, incoming)) {
        if (canMergeTask(pending, incoming)) {
          mergeTaskInto(pending, incoming);
          return { scheduled: false, coalesced: true, task: pending };
        }
        markStale(pending, "replaced");
        pending = incoming;
        return { scheduled: true, coalesced: false, task: pending };
      }
      if (canMergeTask(pending, incoming)) {
        mergeTaskInto(pending, incoming);
        return { scheduled: false, coalesced: true, task: pending };
      }
      markStale(pending, "replaced");
      pending = incoming;
      return { scheduled: true, coalesced: false, task: pending };
    },
    start(task = null) {
      if (!task || task.stale) return false;
      if (pending === task) pending = null;
      active = task;
      return true;
    },
    complete(task = null) {
      if (task && active !== task) return false;
      active = null;
      return true;
    },
    drop(task = null, reason = "dropped") {
      if (!task) return false;
      const target = pending === task ? pending : active === task ? active : null;
      if (!target) return false;
      markStale(target, reason);
      if (pending === task) pending = null;
      if (active === task) active = null;
      return true;
    },
    isStale(task = null, chatId = "") {
      if (!task || task.stale) return true;
      const currentChatId = String(chatId || "").trim();
      return Boolean(currentChatId && task.chatId && currentChatId !== task.chatId);
    },
  };
}
