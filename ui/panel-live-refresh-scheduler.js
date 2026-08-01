export function shouldRefreshPanelHeavyContent({
  extractionRunning = false,
  tabId = "",
  taskSectionId = "",
} = {}) {
  return extractionRunning !== true ||
    (tabId === "task" && ["agent", "pipeline"].includes(taskSectionId));
}

export function createPanelLiveRefreshScheduler({
  refresh,
  isActive = () => true,
  isBusy = () => false,
  now = () => Date.now(),
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  cancelTimer = (handle) => clearTimeout(handle),
  normalIntervalMs = 80,
  busyIntervalMs = 240,
} = {}) {
  if (typeof refresh !== "function") {
    throw new TypeError("PanelLiveRefreshScheduler requires refresh");
  }

  let timerHandle = null;
  let frameHandle = null;
  let dirty = false;
  let disposed = false;
  let lastRefreshAt = 0;

  const interval = () =>
    Math.max(
      0,
      Number(isBusy() ? busyIntervalMs : normalIntervalMs) || 0,
    );
  const scheduleFrame = () => {
    if (disposed || frameHandle !== null) return;
    frameHandle = requestFrame(() => {
      frameHandle = null;
      if (disposed || !dirty || !isActive()) {
        dirty = false;
        return;
      }
      const remaining = Math.max(0, interval() - (now() - lastRefreshAt));
      if (remaining > 0) {
        if (timerHandle === null) {
          timerHandle = scheduleTimer(() => {
            timerHandle = null;
            scheduleFrame();
          }, remaining);
        }
        return;
      }
      dirty = false;
      lastRefreshAt = now();
      refresh();
      if (dirty) scheduleFrame();
    });
  };

  return Object.freeze({
    request({ deferInitial = false } = {}) {
      if (disposed || !isActive()) return false;
      dirty = true;
      if (timerHandle === null && frameHandle === null && deferInitial) {
        timerHandle = scheduleTimer(() => {
          timerHandle = null;
          scheduleFrame();
        }, interval());
      } else if (timerHandle === null) {
        scheduleFrame();
      }
      return true;
    },
    cancel() {
      dirty = false;
      if (timerHandle !== null) cancelTimer(timerHandle);
      if (frameHandle !== null) cancelFrame(frameHandle);
      timerHandle = null;
      frameHandle = null;
    },
    dispose() {
      this.cancel();
      disposed = true;
    },
    getSnapshot() {
      return {
        dirty,
        scheduled: timerHandle !== null || frameHandle !== null,
        lastRefreshAt,
        disposed,
      };
    },
  });
}
