// ST-BME durable graph snapshot schema contract.
//
// This module is the single source of truth for the forward-compatible durable
// snapshot shape used across IndexedDB / OPFS / Authority SQL / Luker chat-state.
//
// The forward-compatibility mechanism is intentionally minimal — NOT an envelope:
//   1. A frozen top-level key set + an explicit schemaVersion.
//   2. Tolerant parsing: unknown fields inside meta / nodes / edges / tombstones /
//      state are preserved on round-trip, never dropped, never cause a throw.
//   3. Upgrade-on-read (see graph-snapshot-upgrade.js): old schemaVersion is
//      upgraded in place; the namespace never changes.
//
// Rule for all future evolution: add fields additively inside meta or record
// objects. NEVER add new top-level snapshot keys, NEVER remove an existing
// top-level key, NEVER change the meaning of an existing field. Following this
// rule means a future v4 full-namespace migration is never required.

// Current durable snapshot layout version. Bump ONLY when an in-place
// upgrade-on-read step is added to graph-snapshot-upgrade.js. Bumping this must
// never require a new storage namespace.
export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 1;

// Frozen forever. The durable snapshot has exactly these top-level keys.
// `schemaVersion` is the layout authority; everything that evolves lives inside
// `meta`, `state`, or the record objects (all of which preserve unknown fields).
export const GRAPH_SNAPSHOT_TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "meta",
  "nodes",
  "edges",
  "tombstones",
  "state",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

// Preserve every own field of a record (node/edge/tombstone/meta entry).
// This is what keeps unknown future fields alive across a round-trip.
function preserveRecord(record) {
  if (!isPlainObject(record)) return null;
  return { ...record };
}

function preserveRecordArray(records) {
  return toArray(records)
    .map((record) => preserveRecord(record))
    .filter(Boolean);
}

// Read the layout version from either the explicit top-level field (new) or the
// historical meta.schemaVersion (already stamped by buildSnapshotFromGraph).
export function readGraphSnapshotSchemaVersion(snapshot) {
  if (!isPlainObject(snapshot)) return 0;
  const topLevel = Number(snapshot.schemaVersion);
  if (Number.isFinite(topLevel) && topLevel > 0) return topLevel;
  const metaVersion = isPlainObject(snapshot.meta)
    ? Number(snapshot.meta.schemaVersion)
    : NaN;
  if (Number.isFinite(metaVersion) && metaVersion > 0) return metaVersion;
  return 0;
}

// Normalize any snapshot-shaped input into the frozen top-level shape WITHOUT
// dropping unknown nested fields. This is the tolerant-parse contract:
//   - keeps unknown fields inside meta / state / records,
//   - drops only unknown TOP-LEVEL keys (which are contractually disallowed),
//   - never throws on malformed input (returns an empty valid snapshot instead),
//   - stamps schemaVersion at top level and mirrors it into meta for back-compat.
export function normalizeGraphSnapshotShape(snapshot, options = {}) {
  const fallbackVersion = Number.isFinite(Number(options.schemaVersion))
    ? Number(options.schemaVersion)
    : GRAPH_SNAPSHOT_SCHEMA_VERSION;

  if (!isPlainObject(snapshot)) {
    return {
      schemaVersion: fallbackVersion,
      meta: { schemaVersion: fallbackVersion },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {},
    };
  }

  const detectedVersion = readGraphSnapshotSchemaVersion(snapshot) || fallbackVersion;
  const meta = isPlainObject(snapshot.meta) ? { ...snapshot.meta } : {};
  const state = isPlainObject(snapshot.state) ? { ...snapshot.state } : {};

  // Keep top-level schemaVersion and meta.schemaVersion in agreement. We do not
  // downgrade here — upgrade-on-read owns version transitions.
  meta.schemaVersion = Number.isFinite(Number(meta.schemaVersion))
    ? Number(meta.schemaVersion)
    : detectedVersion;

  return {
    schemaVersion: detectedVersion,
    meta,
    nodes: preserveRecordArray(snapshot.nodes),
    edges: preserveRecordArray(snapshot.edges),
    tombstones: preserveRecordArray(snapshot.tombstones),
    state,
  };
}

// List top-level keys that violate the frozen contract. Used by tests and by the
// upgrade layer to assert nothing is silently smuggled outside meta/records.
export function findUnknownTopLevelSnapshotKeys(snapshot) {
  if (!isPlainObject(snapshot)) return [];
  return Object.keys(snapshot).filter(
    (key) => !GRAPH_SNAPSHOT_TOP_LEVEL_KEYS.includes(key),
  );
}

// Structural inspection — never throws. Reports whether the snapshot matches the
// frozen contract and what its layout version is.
export function inspectGraphSnapshotContract(snapshot) {
  const valid =
    isPlainObject(snapshot) &&
    isPlainObject(snapshot.meta) &&
    Array.isArray(snapshot.nodes) &&
    Array.isArray(snapshot.edges) &&
    Array.isArray(snapshot.tombstones) &&
    isPlainObject(snapshot.state);
  return {
    schemaContractVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
    valid,
    schemaVersion: readGraphSnapshotSchemaVersion(snapshot),
    unknownTopLevelKeys: findUnknownTopLevelSnapshotKeys(snapshot),
  };
}
