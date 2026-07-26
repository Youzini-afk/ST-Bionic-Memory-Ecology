// ST-BME vector readiness boundary helpers.
//
// Pure planning helpers only. They decide whether vector preparation should
// attempt identity repair, skip, block, or run sync; vector indexing/search
// algorithms stay in vector-index.js.

export function planVectorReadyCheck({
  hasGraph = false,
  metadataWriteAllowed = false,
  mutationContextAllowed = false,
  repairAttempted = false,
  dirty = false,
  configValid = false,
} = {}) {
  if (!hasGraph) return { action: "skip", reason: "missing-graph" };

  if (!metadataWriteAllowed && !mutationContextAllowed) {
    if (!repairAttempted) {
      return { action: "repair-identity", reason: "missing-mutation-context" };
    }
    return { action: "block", reason: "missing-mutation-context" };
  }

  if (!dirty) return { action: "skip", reason: "vector-clean" };
  if (!configValid) return { action: "skip", reason: "invalid-vector-config" };

  return { action: "sync", reason: "vector-dirty" };
}
