import assert from "node:assert/strict";

import { createRestoreLockController } from "../runtime/restore-lock-controller.js";

let lock = null;
const controller = createRestoreLockController({
  getLock: () => lock,
  setLock: (next) => {
    lock = next;
  },
  now: () => 100,
});

const first = controller.enter("first", "first operation");
const second = controller.enter("second", "second operation");
assert.equal(controller.isActive(), true);
assert.equal(lock.depth, 2);

controller.leave(first);
assert.equal(lock.depth, 1);
assert.deepEqual(lock.owners, [second.id]);

controller.leave(first);
assert.equal(lock.depth, 1, "a stale owner must not release another operation");

lock = null;
const replacement = controller.enter("replacement", "new workspace operation");
controller.leave(second);
assert.equal(lock.depth, 1, "an old workspace token must not release the new lock");
controller.leave(replacement);
assert.equal(controller.isActive(), false);

await assert.rejects(
  controller.runWith("throwing", "test", async () => {
    throw new Error("expected");
  }),
  /expected/,
);
assert.equal(controller.isActive(), false);

console.log("restore-lock-controller tests passed");
