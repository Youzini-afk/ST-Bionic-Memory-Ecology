import assert from "node:assert/strict";
import {
  createVectorSyncCoalescer,
  mergeVectorSyncRange,
  normalizeVectorSyncRange,
} from "../runtime/vector-sync-coalescer.js";

assert.deepEqual(normalizeVectorSyncRange({ start: 9, end: 3 }), { start: 3, end: 9 });
assert.equal(normalizeVectorSyncRange({ start: "x", end: 3 }), null);
assert.deepEqual(mergeVectorSyncRange({ start: 2, end: 4 }, { start: 9, end: 6 }), { start: 2, end: 9 });
assert.equal(mergeVectorSyncRange(null, { start: 1, end: 2 }), null);

const coalescer = createVectorSyncCoalescer();
const first = coalescer.enqueue({ id: "first", chatId: "chat-a", modelScope: "direct:model", range: { start: 4, end: 8 }, mode: "balanced", reason: "after-extraction" });
assert.equal(first.scheduled, true);
const second = coalescer.enqueue({ id: "second", chatId: "chat-a", modelScope: "direct:model", range: { start: 1, end: 2 }, mode: "fast", reason: "after-edit" });
assert.equal(second.scheduled, false);
assert.equal(second.coalesced, true);
assert.equal(second.task.id, "first");
assert.deepEqual(second.task.range, { start: 1, end: 8 });
assert.equal(second.task.mode, "fast");

assert.equal(coalescer.start(first.task), true);
const third = coalescer.enqueue({ id: "third", chatId: "chat-a", modelScope: "direct:model", range: { start: 10, end: 12 } });
assert.equal(third.scheduled, true);
assert.equal(third.task.id, "third");
const fourth = coalescer.enqueue({ id: "fourth", chatId: "chat-a", modelScope: "direct:model", range: { start: 20, end: 21 } });
assert.equal(fourth.scheduled, false);
assert.deepEqual(third.task.range, { start: 10, end: 21 });

coalescer.clear("chat-changed");
assert.equal(coalescer.isStale(first.task, "chat-a"), true);
assert.equal(coalescer.isStale(third.task, "chat-a"), true);

const rejected = createVectorSyncCoalescer();
const rejectedFirst = rejected.enqueue({ id: "rejected-first", chatId: "chat-a", modelScope: "direct:model" });
assert.equal(rejected.drop(rejectedFirst.task, "queue-full"), true);
assert.equal(rejected.getPending(), null, "drop returns pending state to empty after queue rejection");
assert.equal(rejected.isStale(rejectedFirst.task, "chat-a"), true);
const rejectedSecond = rejected.enqueue({ id: "rejected-second", chatId: "chat-a", modelScope: "direct:model" });
assert.equal(rejectedSecond.scheduled, true, "new task should schedule after rejected pending is dropped");
assert.equal(rejectedSecond.task.id, "rejected-second");

console.log("vector-sync-coalescer tests passed");
