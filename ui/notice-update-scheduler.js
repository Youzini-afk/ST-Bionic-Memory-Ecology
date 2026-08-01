export function createNoticeUpdateScheduler({
  apply,
  delayMs = 100,
  scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  cancelTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof apply !== "function") {
    throw new TypeError("Notice update scheduler requires apply");
  }
  let timerHandle = null;
  let pendingValue = null;
  const flush = () => {
    if (timerHandle !== null) cancelTimer(timerHandle);
    timerHandle = null;
    if (pendingValue === null) return false;
    const value = pendingValue;
    pendingValue = null;
    apply(value);
    return true;
  };
  return Object.freeze({
    request(value, { immediate = false } = {}) {
      pendingValue = value;
      if (immediate) return flush();
      if (timerHandle === null) {
        timerHandle = scheduleTimer(() => {
          timerHandle = null;
          flush();
        }, Math.max(0, Number(delayMs) || 0));
      }
      return true;
    },
    flush,
    cancel() {
      if (timerHandle !== null) cancelTimer(timerHandle);
      timerHandle = null;
      pendingValue = null;
    },
    getSnapshot: () => ({ scheduled: timerHandle !== null, pending: pendingValue !== null }),
  });
}
