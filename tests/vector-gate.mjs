// ST-BME restrained rebirth — Phase 4 vector readiness boundary tests.

import assert from "node:assert/strict";
import { planVectorReadyCheck } from "../vector/vector-gate.js";

assert.deepEqual(planVectorReadyCheck({ hasGraph: false }), {
  action: "skip",
  reason: "missing-graph",
});

assert.deepEqual(
  planVectorReadyCheck({
    hasGraph: true,
    metadataWriteAllowed: false,
    mutationContextAllowed: false,
    repairAttempted: false,
  }),
  { action: "repair-identity", reason: "missing-mutation-context" },
);

assert.deepEqual(
  planVectorReadyCheck({
    hasGraph: true,
    metadataWriteAllowed: false,
    mutationContextAllowed: false,
    repairAttempted: true,
  }),
  { action: "block", reason: "missing-mutation-context" },
);

assert.deepEqual(
  planVectorReadyCheck({
    hasGraph: true,
    metadataWriteAllowed: true,
    dirty: false,
  }),
  { action: "skip", reason: "vector-clean" },
);

assert.deepEqual(
  planVectorReadyCheck({
    hasGraph: true,
    metadataWriteAllowed: true,
    dirty: true,
    configValid: false,
  }),
  { action: "skip", reason: "invalid-vector-config" },
);

assert.deepEqual(
  planVectorReadyCheck({
    hasGraph: true,
    metadataWriteAllowed: true,
    dirty: true,
    configValid: true,
  }),
  { action: "sync", reason: "vector-dirty" },
);

console.log("vector-gate tests passed");
