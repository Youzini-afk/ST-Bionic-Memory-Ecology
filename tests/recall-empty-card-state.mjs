import assert from "node:assert/strict";
import { resolveRecallRecordState } from "../ui/recall-record-state.js";

assert.deepEqual(resolveRecallRecordState(null), {
  present: false,
  completed: false,
  empty: false,
  ready: false,
});
assert.deepEqual(
  resolveRecallRecordState({ completed: true, empty: true, injectionText: "" }),
  { present: true, completed: true, empty: true, ready: false },
);
assert.deepEqual(
  resolveRecallRecordState({ completed: true, empty: false, injectionText: "memory" }),
  { present: true, completed: true, empty: false, ready: true },
);
assert.deepEqual(
  resolveRecallRecordState({ completed: true, empty: false, injectionText: "" }),
  { present: false, completed: true, empty: false, ready: false },
);
assert.equal(resolveRecallRecordState({ injectionText: "legacy memory" }).present, true);

console.log("empty recall card state tests passed");
