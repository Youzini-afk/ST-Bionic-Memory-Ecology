import assert from "node:assert/strict";

import { createNoticeUpdateScheduler } from "../ui/notice-update-scheduler.js";

const timers = new Map();
const applied = [];
let nextHandle = 0;
const scheduler = createNoticeUpdateScheduler({
  apply: (value) => applied.push(value),
  delayMs: 100,
  scheduleTimer(callback, delay) {
    const handle = ++nextHandle;
    timers.set(handle, { callback, delay });
    return handle;
  },
  cancelTimer: (handle) => timers.delete(handle),
});

for (let index = 0; index < 200; index += 1) scheduler.request(`chunk-${index}`);
assert.equal(timers.size, 1);
assert.deepEqual(applied, []);
const pending = timers.values().next().value;
assert.equal(pending.delay, 100);
pending.callback();
timers.clear();
assert.deepEqual(applied, ["chunk-199"]);

scheduler.request("busy-tail");
scheduler.request("completed", { immediate: true });
assert.deepEqual(applied, ["chunk-199", "completed"]);
assert.equal(timers.size, 0);

scheduler.request("cancelled-update");
scheduler.cancel();
assert.equal(scheduler.getSnapshot().scheduled, false);
assert.equal(scheduler.flush(), false);

console.log("notice update scheduler tests passed");
