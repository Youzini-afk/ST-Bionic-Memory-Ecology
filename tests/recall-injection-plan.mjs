import assert from "node:assert/strict";

import {
  compareNodesByRecallInjectionPlan,
  normalizeRecallInjectionPlan,
} from "../retrieval/recall-injection-plan.js";

const normalized = normalizeRecallInjectionPlan({
  strategy: "causal",
  items: [
    { memoryId: "memory:cause", role: "cause", priority: 5, reason: "解释前因" },
    { memoryId: "memory:anchor", role: "anchor", priority: 4, reason: "当前锚点" },
    { memoryId: "memory:bg", role: "background", priority: 5, reason: "必要背景" },
  ],
});
assert.equal(normalized.valid, true);
assert.equal(normalized.plan.version, 1);
assert.equal(
  compareNodesByRecallInjectionPlan(
    normalized.plan,
    { id: "memory:anchor" },
    { id: "memory:cause" },
  ) < 0,
  true,
  "role order should place the direct anchor before causal context",
);
assert.equal(
  compareNodesByRecallInjectionPlan(
    normalized.plan,
    { id: "memory:cause" },
    { id: "memory:bg" },
  ) < 0,
  true,
);

const duplicate = normalizeRecallInjectionPlan({
  strategy: "balanced",
  items: [
    { memoryId: "memory:1", role: "anchor", priority: 5, reason: "first" },
    { memoryId: "memory:1", role: "cause", priority: 4, reason: "duplicate" },
  ],
});
assert.equal(duplicate.valid, false);
assert.match(duplicate.issues.join("\n"), /duplicated/);

const empty = normalizeRecallInjectionPlan({ strategy: "focused", items: [] });
assert.equal(empty.valid, true);
assert.deepEqual(empty.plan.items, []);

console.log("recall injection plan tests passed");
