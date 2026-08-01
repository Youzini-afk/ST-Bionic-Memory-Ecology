import assert from "node:assert/strict";

import {
  createPanelLiveRefreshScheduler,
  shouldRefreshPanelHeavyContent,
} from "../ui/panel-live-refresh-scheduler.js";

assert.equal(shouldRefreshPanelHeavyContent({ extractionRunning: true, tabId: "dashboard" }), false);
assert.equal(shouldRefreshPanelHeavyContent({ extractionRunning: true, tabId: "task", taskSectionId: "memory" }), false);
assert.equal(shouldRefreshPanelHeavyContent({ extractionRunning: true, tabId: "task", taskSectionId: "agent" }), true);
assert.equal(shouldRefreshPanelHeavyContent({ extractionRunning: false, tabId: "dashboard" }), true);

let now = 1_000;
let active = true;
let busy = true;
let refreshCount = 0;
let nextHandle = 0;
const frames = new Map();
const timers = new Map();
const scheduler = createPanelLiveRefreshScheduler({
  refresh: () => {
    refreshCount += 1;
  },
  isActive: () => active,
  isBusy: () => busy,
  now: () => now,
  requestFrame(callback) {
    const handle = ++nextHandle;
    frames.set(handle, callback);
    return handle;
  },
  cancelFrame: (handle) => frames.delete(handle),
  scheduleTimer(callback, delay) {
    const handle = ++nextHandle;
    timers.set(handle, { callback, delay });
    return handle;
  },
  cancelTimer: (handle) => timers.delete(handle),
  normalIntervalMs: 80,
  busyIntervalMs: 240,
});

assert.equal(scheduler.request({ deferInitial: true }), true);
for (let index = 1; index < 200; index += 1) scheduler.request();
assert.equal(refreshCount, 0, "producer updates must never render synchronously");
assert.equal(frames.size, 0, "opening work must not run before the panel can paint");
assert.equal(timers.size, 1, "one timer owns the initial busy burst");
let pending = timers.values().next().value;
assert.equal(pending.delay, 240);
now += pending.delay;
pending.callback();
timers.clear();
assert.equal(frames.size, 1);
frames.values().next().value();
frames.clear();
assert.equal(refreshCount, 1);

now += 16;
for (let index = 0; index < 200; index += 1) scheduler.request();
assert.equal(frames.size, 1);
frames.values().next().value();
frames.clear();
assert.equal(refreshCount, 1);
assert.equal(timers.size, 1);
pending = timers.values().next().value;
assert.equal(pending.delay, 224);
now += pending.delay;
pending.callback();
timers.clear();
frames.values().next().value();
frames.clear();
assert.equal(refreshCount, 2);

active = false;
assert.equal(scheduler.request(), false);
assert.equal(scheduler.getSnapshot().scheduled, false);

console.log("panel-live-refresh-scheduler tests passed");
