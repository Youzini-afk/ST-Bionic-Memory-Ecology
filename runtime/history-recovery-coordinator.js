function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

/**
 * Serializes history rollback attempts for one conversation workspace.
 *
 * A mutation request is never dropped while an older rollback is running:
 * the older attempt is asked to stop, then the drain continues with the
 * newest requested revision. Read-side callers join the same drain instead
 * of creating a competing rollback.
 */
export function createHistoryRecoveryCoordinator({
  getCurrentChatId = () => "",
  runAttempt,
  abortActive = () => false,
} = {}) {
  if (typeof runAttempt !== "function") {
    throw new TypeError("HistoryRecoveryCoordinator requires runAttempt");
  }

  let requestedRevision = 0;
  let completedRevision = 0;
  let pendingRequest = null;
  let activeRequest = null;
  let activePromise = null;
  let attemptActive = false;
  let disposed = false;
  let lastResult = true;

  const snapshot = () => ({
    requestedRevision,
    completedRevision,
    pendingRevision: pendingRequest?.revision || 0,
    activeRevision: activeRequest?.revision || 0,
    pendingTrigger: pendingRequest?.trigger || "",
    activeTrigger: activeRequest?.trigger || "",
    chatId:
      activeRequest?.chatId ||
      pendingRequest?.chatId ||
      normalizeText(getCurrentChatId()),
    busy: Boolean(activePromise || pendingRequest || attemptActive),
    running: Boolean(activePromise || attemptActive),
    disposed,
    lastResult,
  });

  const request = (trigger = "history-change", { supersede = true } = {}) => {
    if (disposed) return null;
    const next = {
      revision: ++requestedRevision,
      trigger: normalizeText(trigger, "history-change"),
      chatId: normalizeText(getCurrentChatId()),
      requestedAt: Date.now(),
    };
    pendingRequest = next;

    if (supersede && activePromise) {
      abortActive(
        `历史再次变化，切换到最新回滚事务（revision ${next.revision}）`,
        next,
        activeRequest,
      );
    }
    return { ...next };
  };

  const drain = async () => {
    let result = lastResult;
    while (!disposed && pendingRequest) {
      const next = pendingRequest;
      pendingRequest = null;
      activeRequest = next;
      let attemptError = null;

      if (
        next.chatId &&
        normalizeText(getCurrentChatId()) &&
        next.chatId !== normalizeText(getCurrentChatId())
      ) {
        result = false;
      } else {
        try {
          result = (await runAttempt(next)) === true;
        } catch (error) {
          result = false;
          attemptError = error;
        }
      }

      completedRevision = Math.max(completedRevision, next.revision);
      activeRequest = null;
      lastResult = result;
      if (attemptError && (!pendingRequest || disposed)) throw attemptError;
    }
    return result;
  };

  const start = (trigger = "history-recovery") => {
    if (disposed) return Promise.resolve(false);
    if (activePromise) return activePromise;
    if (!pendingRequest) request(trigger, { supersede: false });

    const task = drain();
    activePromise = task;
    const clear = () => {
      if (activePromise === task) activePromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  return {
    request,
    start,
    recover(trigger = "history-recovery") {
      if (disposed) return Promise.resolve(false);
      if (activePromise) return activePromise;
      return start(trigger);
    },
    waitForCurrent() {
      if (disposed) return Promise.resolve(false);
      if (activePromise) return activePromise;
      if (pendingRequest) return start(pendingRequest.trigger);
      return Promise.resolve(lastResult);
    },
    settlePending(requestRevision, result = true) {
      if (
        !pendingRequest ||
        Number(pendingRequest.revision) !== Number(requestRevision)
      ) {
        return false;
      }
      completedRevision = Math.max(completedRevision, pendingRequest.revision);
      pendingRequest = null;
      lastResult = result === true;
      return true;
    },
    setAttemptActive(value) {
      attemptActive = value === true;
    },
    isAttemptActive() {
      return attemptActive;
    },
    isBusy() {
      return Boolean(activePromise || pendingRequest || attemptActive);
    },
    getSnapshot: snapshot,
    clear(reason = "history-recovery-coordinator-cleared") {
      if (disposed) return false;
      disposed = true;
      pendingRequest = null;
      abortActive(normalizeText(reason, "history-recovery-coordinator-cleared"));
      return true;
    },
  };
}
