export const GRAPH_COLLECTIONS = Object.freeze(["nodes", "edges", "graphState"]);

const collectionNames = new Set(GRAPH_COLLECTIONS);

export class ChangeConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChangeConflictError";
    this.details = details;
  }
}

function assertJsonValue(value, path = "value", stack = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON-compatible`);
  if (stack.has(value)) throw new TypeError(`${path} must not contain cycles`);

  stack.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, stack));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain plain objects`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, stack);
    }
  }
  stack.delete(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function recordsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeRecord(record, id, path) {
  if (record === null || record === undefined) return null;
  if (Array.isArray(record)) throw new TypeError(`${path} must be an object record`);
  assertJsonValue(record, path);
  if (Object.hasOwn(record, "id") && String(record.id) !== id) {
    throw new TypeError(`${path}.id must match change id`);
  }
  return structuredClone(record);
}

export function normalizeChangeSet(input = {}) {
  const source = Array.isArray(input) ? input : input?.changes;
  if (!Array.isArray(source)) throw new TypeError("ChangeSet.changes must be an array");

  const seen = new Set();
  const changes = source.map((change, index) => {
    if (!change || typeof change !== "object") {
      throw new TypeError(`change ${index} must be an object`);
    }
    const collection = String(change.collection || "").trim();
    const id = String(change.id || "").trim();
    if (!collectionNames.has(collection)) {
      throw new TypeError(`change ${index} has invalid collection`);
    }
    if (!id) throw new TypeError(`change ${index} requires an id`);
    const key = `${collection}\0${id}`;
    if (seen.has(key)) throw new TypeError(`duplicate change for ${collection}/${id}`);
    seen.add(key);

    const before = normalizeRecord(change.before, id, `change ${index}.before`);
    const after = normalizeRecord(change.after, id, `change ${index}.after`);
    if (before === null && after === null) {
      throw new TypeError(`change ${index} cannot delete a missing record`);
    }
    if (recordsEqual(before, after)) {
      throw new TypeError(`change ${index} does not change the record`);
    }
    return { collection, id, before, after };
  });

  changes.sort((left, right) => {
    const leftKey = `${left.collection}\0${left.id}`;
    const rightKey = `${right.collection}\0${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { changes };
}

export function createGraphCollections() {
  return Object.fromEntries(GRAPH_COLLECTIONS.map((name) => [name, new Map()]));
}

export function applyChangeSet(collections, input, direction = "forward") {
  if (!collections || typeof collections !== "object") {
    throw new TypeError("graph collections are required");
  }
  if (direction !== "forward" && direction !== "rollback") {
    throw new TypeError("direction must be forward or rollback");
  }

  const { changes } = normalizeChangeSet(input);
  for (const change of changes) {
    const collection = collections[change.collection];
    if (!(collection instanceof Map)) {
      throw new TypeError(`collection ${change.collection} must be a Map`);
    }
    const expected = direction === "forward" ? change.before : change.after;
    const next = direction === "forward" ? change.after : change.before;
    const current = collection.has(change.id) ? collection.get(change.id) : null;
    if (!recordsEqual(current, expected)) {
      throw new ChangeConflictError(
        `${direction} conflict for ${change.collection}/${change.id}`,
        { collection: change.collection, id: change.id, direction },
      );
    }
    if (next === null) collection.delete(change.id);
    else collection.set(change.id, structuredClone(next));
  }
  return collections;
}
