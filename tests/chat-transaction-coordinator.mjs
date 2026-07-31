import assert from "node:assert/strict";
import { ChatTransactionCoordinator } from "../application/chat-transaction-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const coordinator = new ChatTransactionCoordinator();
const firstGate = deferred();
const order = [];
const first = coordinator.run("chat:a", async () => {
  order.push("first-start");
  await firstGate.promise;
  order.push("first-end");
});
const second = coordinator.run("chat:a", async () => {
  order.push("second");
});
await Promise.resolve();
assert.deepEqual(order, ["first-start"]);
assert.equal(coordinator.getStatus("chat:a").pending, 2);
firstGate.resolve();
await Promise.all([first, second]);
assert.deepEqual(order, ["first-start", "first-end", "second"]);
assert.equal(coordinator.getStatus("chat:a").busy, false);

const gateA = deferred();
const gateB = deferred();
const parallel = [];
const taskA = coordinator.run("chat:a", async () => {
  parallel.push("a");
  await gateA.promise;
});
const taskB = coordinator.run("chat:b", async () => {
  parallel.push("b");
  await gateB.promise;
});
await Promise.resolve();
assert.deepEqual(new Set(parallel), new Set(["a", "b"]));
gateA.resolve();
gateB.resolve();
await Promise.all([taskA, taskB]);

await assert.rejects(
  coordinator.run("chat:failure", async () => {
    throw new Error("expected");
  }),
  /expected/,
);
await coordinator.run("chat:failure", async () => order.push("after-failure"));
assert.equal(order.at(-1), "after-failure");

console.log("chat transaction coordinator tests passed");
