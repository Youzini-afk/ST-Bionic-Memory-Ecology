const DEFAULT_UNAVAILABLE_REASON = "宿主能力不可用";

export const HOST_ADAPTER_VERSION = "phase1-bridge-skeleton";

export function normalizeVersionHints(versionHints = {}) {
  const normalized = {};

  for (const [key, rawValue] of Object.entries(versionHints || {})) {
    if (rawValue == null || rawValue === "") continue;

    if (Array.isArray(rawValue)) {
      const values = rawValue
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
      if (values.length > 0) {
        normalized[key] = values;
      }
      continue;
    }

    if (typeof rawValue === "object") {
      const nested = normalizeVersionHints(rawValue);
      if (Object.keys(nested).length > 0) {
        normalized[key] = nested;
      }
      continue;
    }

    normalized[key] = String(rawValue).trim();
  }

  return Object.freeze(normalized);
}

export function mergeVersionHints(...sources) {
  const merged = {};

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (value == null || value === "") continue;
      merged[key] = Array.isArray(value) ? [...value] : value;
    }
  }

  return normalizeVersionHints(merged);
}

export function buildCapabilityStatus({
  available = false,
  mode = "",
  fallbackReason = "",
  versionHints = {},
} = {}) {
  const normalizedAvailable = Boolean(available);
  const normalizedMode =
    String(mode || "").trim() ||
    (normalizedAvailable ? "available" : "unavailable");

  return Object.freeze({
    available: normalizedAvailable,
    mode: normalizedMode,
    fallbackReason: normalizedAvailable
      ? String(fallbackReason || "").trim()
      : String(fallbackReason || DEFAULT_UNAVAILABLE_REASON).trim(),
    versionHints: normalizeVersionHints(versionHints),
  });
}

export function buildCapabilityCollectionSnapshot(
  capabilities = {},
  options = {},
) {
  const normalizedCapabilities = {};
  const capabilityNames = Object.keys(capabilities || {});
  let availableCount = 0;

  for (const name of capabilityNames) {
    const capability = buildCapabilityStatus(capabilities[name]);
    normalizedCapabilities[name] = capability;
    if (capability.available) {
      availableCount += 1;
    }
  }

  const totalCount = capabilityNames.length;
  const available = availableCount > 0;
  const mode =
    totalCount === 0
      ? "empty"
      : availableCount === totalCount
        ? "full"
        : available
          ? "partial"
          : "fallback";

  return Object.freeze({
    available,
    mode,
    fallbackReason:
      available || totalCount === 0 ? "" : "未检测到可用宿主桥接能力",
    versionHints: mergeVersionHints(
      {
        adapter: HOST_ADAPTER_VERSION,
        availableCount: String(availableCount),
        totalCount: String(totalCount),
      },
      options.versionHints,
    ),
    ...normalizedCapabilities,
  });
}
