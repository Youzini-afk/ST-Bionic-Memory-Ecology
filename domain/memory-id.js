let fallbackSequence = 0;

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(String(value));
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashDomainValue(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function createDomainId(prefix = "record", seed = undefined) {
  const normalizedPrefix = String(prefix || "record")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-") || "record";
  if (seed !== undefined) {
    return `${normalizedPrefix}_${hashDomainValue(seed)}`;
  }
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${normalizedPrefix}_${uuid}`;
  fallbackSequence += 1;
  return `${normalizedPrefix}_${Date.now().toString(36)}_${fallbackSequence.toString(36)}`;
}

export function cloneDomainValue(value, fallback = null) {
  if (value === undefined) return fallback;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function freezeDomainValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDomainValue(nested);
  return Object.freeze(value);
}

export function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}
