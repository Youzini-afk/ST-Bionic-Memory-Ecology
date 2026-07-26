// ST-BME durable graph snapshot upgrade-on-read.
//
// This is the in-place, no-migration upgrade path. When a stored snapshot has an
// older layout schemaVersion than the current one, it is upgraded step-by-step in
// memory at read time. The storage namespace NEVER changes; the upgraded snapshot
// is simply written back on the next normal persist.
//
// How to add a future layout change WITHOUT forcing a v4 namespace migration:
//   1. Bump GRAPH_SNAPSHOT_SCHEMA_VERSION in graph-snapshot-schema.js.
//   2. Add ONE step function to GRAPH_SNAPSHOT_UPGRADE_STEPS below, keyed by the
//      version it upgrades FROM (e.g. step "1" upgrades v1 -> v2).
//   3. The step must be additive: add/rename fields inside meta/state/records,
//      never delete data, never throw on unknown fields.
//
// Invariant: upgrading is monotonic and idempotent. A current-version snapshot
// is returned unchanged (no step runs). An unknown FUTURE version is left as-is
// and flagged, so a newer writer's data is never silently downgraded/corrupted.

import {
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  normalizeGraphSnapshotShape,
  readGraphSnapshotSchemaVersion,
} from "./graph-snapshot-schema.js";

// Map of fromVersion -> pure step(snapshot) => snapshot.
// Currently empty: layout v1 is the first durable layout, so there is nothing to
// upgrade yet. The framework and invariants exist so future steps are a one-line
// addition, never another namespace cutover.
export const GRAPH_SNAPSHOT_UPGRADE_STEPS = Object.freeze({
  // Example (do not enable yet):
  // 1: (snapshot) => ({ ...snapshot, meta: { ...snapshot.meta, somethingNew: true } }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Upgrade a snapshot in place (functionally) to the current layout version.
// Returns { snapshot, fromVersion, toVersion, upgraded, ahead, steps }.
//   - upgraded: true if at least one step ran.
//   - ahead: true if the stored version is NEWER than this build supports; in
//     that case we DO NOT mutate it (forward data is preserved untouched).
export function upgradeGraphSnapshotOnRead(snapshot, options = {}) {
  const targetVersion = Number.isFinite(Number(options.targetVersion))
    ? Number(options.targetVersion)
    : GRAPH_SNAPSHOT_SCHEMA_VERSION;

  // Tolerant parse first so unknown nested fields survive and shape is valid.
  let current = normalizeGraphSnapshotShape(snapshot, {
    schemaVersion: readGraphSnapshotSchemaVersion(snapshot) || targetVersion,
  });

  const fromVersion = readGraphSnapshotSchemaVersion(current) || targetVersion;

  if (fromVersion > targetVersion) {
    // Newer-than-supported data: never downgrade, never drop. Leave as-is.
    return {
      snapshot: current,
      fromVersion,
      toVersion: fromVersion,
      upgraded: false,
      ahead: true,
      steps: [],
    };
  }

  const appliedSteps = [];
  let version = fromVersion;
  // Guard against accidental non-monotonic loops.
  let safety = 0;
  while (version < targetVersion && safety < 1000) {
    safety += 1;
    const step = GRAPH_SNAPSHOT_UPGRADE_STEPS[version];
    if (typeof step !== "function") {
      // No step registered for this version gap. Stop rather than throw so a
      // partially-known chain still loads; the snapshot stays at `version`.
      break;
    }
    const next = step(current);
    if (!isPlainObject(next)) {
      break;
    }
    current = normalizeGraphSnapshotShape(next, { schemaVersion: version + 1 });
    version += 1;
    current.schemaVersion = version;
    if (isPlainObject(current.meta)) {
      current.meta.schemaVersion = version;
    }
    appliedSteps.push(version);
  }

  return {
    snapshot: current,
    fromVersion,
    toVersion: version,
    upgraded: appliedSteps.length > 0,
    ahead: false,
    steps: appliedSteps,
  };
}
