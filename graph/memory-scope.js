const MEMORY_SCOPE_LAYER = {
  OBJECTIVE: "objective",
  POV: "pov",
};

const MEMORY_SCOPE_OWNER_TYPE = {
  NONE: "",
  CHARACTER: "character",
  USER: "user",
};

export const DEFAULT_MEMORY_SCOPE = Object.freeze({
  layer: MEMORY_SCOPE_LAYER.OBJECTIVE,
  ownerType: MEMORY_SCOPE_OWNER_TYPE.NONE,
  ownerId: "",
  ownerName: "",
  regionPrimary: "",
  regionPath: [],
  regionSecondary: [],
});

export const MEMORY_SCOPE_BUCKETS = Object.freeze({
  CHARACTER_POV: "characterPov",
  USER_POV: "userPov",
  OBJECTIVE_CURRENT_REGION: "objectiveCurrentRegion",
  OBJECTIVE_ADJACENT_REGION: "objectiveAdjacentRegion",
  OBJECTIVE_GLOBAL: "objectiveGlobal",
  OTHER_POV: "otherPov",
});

export const DEFAULT_SCOPE_BUCKET_WEIGHTS = Object.freeze({
  [MEMORY_SCOPE_BUCKETS.CHARACTER_POV]: 1.25,
  [MEMORY_SCOPE_BUCKETS.USER_POV]: 1.05,
  [MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION]: 1.15,
  [MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION]: 0.9,
  [MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL]: 0.75,
  [MEMORY_SCOPE_BUCKETS.OTHER_POV]: 0.6,
});

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase();
}

const SCOPE_REGION_TEXT_KEYS = ["name", "title", "label", "value", "text"];

function isPlainScopeObject(scope = null) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(scope);
  return prototype === Object.prototype || prototype === null;
}

function hasScopeAccessor(scope = {}, key = "") {
  const descriptor = Object.getOwnPropertyDescriptor(scope, key);
  return Boolean(
    descriptor &&
      (typeof descriptor.get === "function" || typeof descriptor.set === "function"),
  );
}

function normalizeStringArray(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeString(value);
    const key = normalizeKey(normalized);
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function splitScopeRegionText(value = "", { allowSlash = true } = {}) {
  const normalized = normalizeString(value)
    .replace(/[＞>→]+/g, "/")
    .replace(/\r/g, "\n");
  if (!normalized) {
    return [];
  }
  const separatorPattern = allowSlash
    ? /[,\n，/\\、；;|]+/
    : /[,\n，、；;|]+/;
  return normalized
    .split(separatorPattern)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function extractScopeRegionText(value = null) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return normalizeString(value);
  }
  if (typeof value === "boolean" || typeof value === "symbol") {
    return "";
  }
  if (Array.isArray(value)) {
    return "";
  }
  if (typeof value === "object") {
    for (const key of SCOPE_REGION_TEXT_KEYS) {
      let candidate = "";
      try {
        candidate = value?.[key];
      } catch {
        candidate = "";
      }
      if (typeof candidate === "string" || typeof candidate === "number") {
        return normalizeString(candidate);
      }
    }
    return "";
  }
  return normalizeString(value);
}

function normalizeScopeRegionList(values = [], { allowSlash = true } = {}) {
  const result = [];
  const seen = new Set();
  const pushValue = (value) => {
    const normalized = normalizeString(value);
    const key = normalizeKey(normalized);
    if (!normalized || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(normalized);
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    const text = extractScopeRegionText(value);
    if (!text) {
      return;
    }
    const parts = splitScopeRegionText(text, { allowSlash });
    if (parts.length === 0) {
      pushValue(text);
      return;
    }
    for (const part of parts) {
      pushValue(part);
    }
  };
  visit(values);
  return result;
}

function appendUniqueTokenToPath(values = [], token = "") {
  const normalizedToken = normalizeString(token);
  if (!normalizedToken) {
    return normalizeScopeRegionList(values, { allowSlash: true });
  }
  const tokenKey = normalizeKey(normalizedToken);
  const filtered = normalizeScopeRegionList(values, { allowSlash: true });
  if (filtered.some((value) => normalizeKey(value) === tokenKey)) {
    return filtered;
  }
  return [...filtered, normalizedToken];
}

function isAlreadyNormalizedStringArray(values = []) {
  if (!Array.isArray(values)) return false;
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") return false;
    const normalized = normalizeString(value);
    const key = normalizeKey(normalized);
    if (!normalized || normalized !== value || seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function canReuseNormalizedMemoryScope(scope = {}, defaults = {}) {
  if (
    !isPlainScopeObject(scope) ||
    (defaults && typeof defaults === "object" && Object.keys(defaults).length > 0)
  ) {
    return false;
  }
  if (
    [
      "layer",
      "ownerType",
      "ownerId",
      "ownerName",
      "regionPrimary",
      "regionPath",
      "regionSecondary",
    ].some((key) => hasScopeAccessor(scope, key))
  ) {
    return false;
  }
  const layer = normalizeLayer(scope.layer);
  const ownerType = normalizeOwnerType(layer, normalizeString(scope.ownerType));
  const ownerId = ownerType
    ? normalizeString(scope.ownerId || scope.ownerName)
    : "";
  const ownerName = ownerType ? normalizeString(scope.ownerName) : "";
  const regionPrimary = normalizeString(scope.regionPrimary);
  return (
    scope.layer === layer &&
    normalizeString(scope.ownerType) === ownerType &&
    normalizeString(scope.ownerId || "") === ownerId &&
    normalizeString(scope.ownerName || "") === ownerName &&
    normalizeString(scope.regionPrimary || "") === regionPrimary &&
    isAlreadyNormalizedStringArray(scope.regionPath) &&
    isAlreadyNormalizedStringArray(scope.regionSecondary)
  );
}

function normalizeOwnerValueSet(values = []) {
  return new Set(
    normalizeStringArray(values).map((value) => normalizeKey(value)),
  );
}

function normalizeOwnerType(layer, ownerType) {
  if (layer !== MEMORY_SCOPE_LAYER.POV) {
    return MEMORY_SCOPE_OWNER_TYPE.NONE;
  }
  if (
    ownerType === MEMORY_SCOPE_OWNER_TYPE.CHARACTER ||
    ownerType === MEMORY_SCOPE_OWNER_TYPE.USER
  ) {
    return ownerType;
  }
  return MEMORY_SCOPE_OWNER_TYPE.NONE;
}

function normalizeLayer(layer) {
  return layer === MEMORY_SCOPE_LAYER.POV
    ? MEMORY_SCOPE_LAYER.POV
    : MEMORY_SCOPE_LAYER.OBJECTIVE;
}

export function createDefaultMemoryScope(overrides = {}) {
  return normalizeMemoryScope(overrides);
}

export function normalizeMemoryScope(scope = {}, defaults = {}) {
  if (canReuseNormalizedMemoryScope(scope, defaults)) {
    return scope;
  }
  const merged = {
    ...DEFAULT_MEMORY_SCOPE,
    ...(defaults || {}),
    ...(scope || {}),
  };
  const layer = normalizeLayer(merged.layer);
  const ownerType = normalizeOwnerType(layer, normalizeString(merged.ownerType));
  const ownerId = ownerType
    ? normalizeString(merged.ownerId || merged.ownerName)
    : "";
  const ownerName = ownerType ? normalizeString(merged.ownerName) : "";
  const regionPrimaryTokens = normalizeScopeRegionList(merged.regionPrimary, {
    allowSlash: true,
  });
  let regionPath = normalizeScopeRegionList(merged.regionPath, {
    allowSlash: true,
  });
  let regionSecondary = normalizeScopeRegionList(merged.regionSecondary, {
    allowSlash: true,
  });
  if (regionPath.length === 0 && regionPrimaryTokens.length > 1) {
    regionPath = [...regionPrimaryTokens];
  }
  let regionPrimary = regionPrimaryTokens[regionPrimaryTokens.length - 1] || "";
  if (!regionPrimary && regionPath.length > 0) {
    regionPrimary = regionPath[regionPath.length - 1] || "";
  }
  if (regionPrimary && regionPath.length > 0) {
    regionPath = appendUniqueTokenToPath(regionPath, regionPrimary);
  }
  if (regionPrimary) {
    const regionPrimaryKey = normalizeKey(regionPrimary);
    regionSecondary = regionSecondary.filter(
      (value) => normalizeKey(value) !== regionPrimaryKey,
    );
  }
  if (regionPath.length > 0) {
    const regionPathKeys = new Set(regionPath.map((value) => normalizeKey(value)));
    regionSecondary = regionSecondary.filter(
      (value) => !regionPathKeys.has(normalizeKey(value)),
    );
  }

  return {
    layer,
    ownerType,
    ownerId,
    ownerName,
    regionPrimary,
    regionPath,
    regionSecondary,
  };
}

export function normalizeNodeMemoryScope(node, defaults = {}) {
  const scope = normalizeMemoryScope(node?.scope, defaults);
  if (node && typeof node === "object") {
    node.scope = scope;
  }
  return scope;
}

export function normalizeEdgeMemoryScope(edge, defaults = {}) {
  const scope = normalizeMemoryScope(edge?.scope, defaults);
  if (edge && typeof edge === "object") {
    edge.scope = scope;
  }
  return scope;
}

export function isPovScope(scope) {
  return normalizeMemoryScope(scope).layer === MEMORY_SCOPE_LAYER.POV;
}

export function isObjectiveScope(scope) {
  return normalizeMemoryScope(scope).layer === MEMORY_SCOPE_LAYER.OBJECTIVE;
}

export function getScopeOwnerKey(scope) {
  const normalized = normalizeMemoryScope(scope);
  const ownerType = normalizeString(normalized.ownerType);
  const ownerId = normalizeKey(normalized.ownerId || normalized.ownerName);
  return ownerType && ownerId ? `${ownerType}:${ownerId}` : "";
}

export function getScopeRegionTokens(scope) {
  const normalized = normalizeMemoryScope(scope);
  const regionPath = normalizeStringArray(normalized.regionPath);
  const regionSecondary = normalizeStringArray(normalized.regionSecondary);
  return normalizeStringArray([
    normalized.regionPrimary,
    ...regionPath,
    ...regionSecondary,
  ]);
}

export function getScopeRegionKey(scope) {
  const normalized = normalizeMemoryScope(scope);
  return normalizeString(normalized.regionPrimary);
}

export function getScopeSummary(scope) {
  const normalized = normalizeMemoryScope(scope);
  const regionTokens = getScopeRegionTokens(normalized);
  return {
    layer: normalized.layer,
    ownerType: normalized.ownerType,
    ownerId: normalized.ownerId,
    ownerName: normalized.ownerName,
    ownerKey: getScopeOwnerKey(normalized),
    regionPrimary: normalized.regionPrimary,
    regionKey: getScopeRegionKey(normalized),
    regionTokens,
  };
}

export function hasMeaningfulMemoryScope(scope) {
  const normalized = normalizeMemoryScope(scope);
  return (
    normalized.layer === MEMORY_SCOPE_LAYER.POV ||
    Boolean(normalized.ownerType || normalized.ownerId || normalized.ownerName) ||
    Boolean(normalized.regionPrimary) ||
    (Array.isArray(normalized.regionPath) && normalized.regionPath.length > 0) ||
    (Array.isArray(normalized.regionSecondary) &&
      normalized.regionSecondary.length > 0)
  );
}

export function matchesScopeOwner(scope, ownerType, ownerValue = "") {
  const normalized = normalizeMemoryScope(scope);
  if (normalizeString(normalized.ownerType) !== normalizeString(ownerType)) {
    return false;
  }
  const target = normalizeKey(ownerValue);
  if (!target) {
    return Boolean(normalized.ownerType);
  }
  return [normalized.ownerId, normalized.ownerName]
    .map((value) => normalizeKey(value))
    .includes(target);
}

export function isSameLatestScopeBucket(node, options = {}) {
  const scope = normalizeMemoryScope(options.scope);
  const targetType = normalizeString(options.type);
  const primaryKeyField = normalizeString(options.primaryKeyField || "name") || "name";
  const primaryKeyValue = normalizeString(options.primaryKeyValue);
  if (!node || normalizeString(node.type) !== targetType) return false;
  if (normalizeString(node?.fields?.[primaryKeyField]) !== primaryKeyValue) {
    return false;
  }
  return hasSameScopeIdentity(node?.scope, scope);
}

export function hasSameScopeIdentity(a, b) {
  const scopeA = normalizeMemoryScope(a);
  const scopeB = normalizeMemoryScope(b);
  if (scopeA.layer !== scopeB.layer) return false;
  if (scopeA.layer === MEMORY_SCOPE_LAYER.POV) {
    return getScopeOwnerKey(scopeA) === getScopeOwnerKey(scopeB);
  }
  return normalizeKey(getScopeRegionKey(scopeA)) === normalizeKey(getScopeRegionKey(scopeB));
}

export function canMergeScopedMemories(a, b) {
  const scopeA = normalizeMemoryScope(a?.scope || a);
  const scopeB = normalizeMemoryScope(b?.scope || b);
  if (scopeA.layer !== scopeB.layer) return false;

  if (scopeA.layer === MEMORY_SCOPE_LAYER.POV) {
    const ownerKeyA = getScopeOwnerKey(scopeA);
    const ownerKeyB = getScopeOwnerKey(scopeB);
    return Boolean(ownerKeyA) && ownerKeyA === ownerKeyB;
  }

  const regionA = normalizeKey(getScopeRegionKey(scopeA));
  const regionB = normalizeKey(getScopeRegionKey(scopeB));
  return regionA === regionB;
}

export function classifyNodeScopeBucket(
  node,
  {
    activeCharacterPovOwner = "",
    activeCharacterPovOwners = [],
    activeUserPovOwner = "",
    activeUserPovOwners = [],
    activeRegion = "",
    adjacentRegions = [],
    enablePovMemory = true,
    enableRegionScopedObjective = true,
    allowImplicitCharacterPovFallback = true,
  } = {},
) {
  const scope = normalizeMemoryScope(node?.scope);
  const normalizedActiveRegion = normalizeKey(activeRegion);
  const normalizedAdjacentRegions = new Set(
    normalizeStringArray(adjacentRegions).map((value) => normalizeKey(value)),
  );
  const normalizedActiveCharacterOwners = normalizeOwnerValueSet([
    ...normalizeStringArray(activeCharacterPovOwners),
    activeCharacterPovOwner,
  ]);
  const normalizedActiveUserOwners = normalizeOwnerValueSet([
    ...normalizeStringArray(activeUserPovOwners),
    activeUserPovOwner,
  ]);
  const scopeOwnerValues = normalizeOwnerValueSet([
    scope.ownerId,
    scope.ownerName,
  ]);

  if (scope.layer === MEMORY_SCOPE_LAYER.POV) {
    if (!enablePovMemory) {
      return MEMORY_SCOPE_BUCKETS.OTHER_POV;
    }
    if (
      scope.ownerType === MEMORY_SCOPE_OWNER_TYPE.CHARACTER &&
      scopeOwnerValues.size > 0 &&
      [...scopeOwnerValues].some((value) =>
        normalizedActiveCharacterOwners.has(value),
      )
    ) {
      return MEMORY_SCOPE_BUCKETS.CHARACTER_POV;
    }
    if (
      scope.ownerType === MEMORY_SCOPE_OWNER_TYPE.USER &&
      scopeOwnerValues.size > 0 &&
      [...scopeOwnerValues].some((value) => normalizedActiveUserOwners.has(value))
    ) {
      return MEMORY_SCOPE_BUCKETS.USER_POV;
    }
    if (
      allowImplicitCharacterPovFallback &&
      normalizedActiveCharacterOwners.size === 0 &&
      scope.ownerType === MEMORY_SCOPE_OWNER_TYPE.CHARACTER
    ) {
      return MEMORY_SCOPE_BUCKETS.CHARACTER_POV;
    }
    if (
      normalizedActiveUserOwners.size === 0 &&
      scope.ownerType === MEMORY_SCOPE_OWNER_TYPE.USER
    ) {
      return MEMORY_SCOPE_BUCKETS.USER_POV;
    }
    return MEMORY_SCOPE_BUCKETS.OTHER_POV;
  }

  if (!enableRegionScopedObjective || !normalizedActiveRegion) {
    return MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
  }

  const regionPrimary = normalizeKey(scope.regionPrimary);
  if (regionPrimary && regionPrimary === normalizedActiveRegion) {
    return MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION;
  }
  if (regionPrimary && normalizedAdjacentRegions.has(regionPrimary)) {
    return MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION;
  }

  const tokens = getScopeRegionTokens(scope).map((value) => normalizeKey(value));
  if (
    tokens.includes(normalizedActiveRegion) ||
    tokens.some((token) => normalizedAdjacentRegions.has(token))
  ) {
    return MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION;
  }

  return MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
}

export function resolveScopeBucketWeight(bucket, overrides = {}) {
  return Number(
    overrides?.[bucket] ?? DEFAULT_SCOPE_BUCKET_WEIGHTS[bucket] ?? 1,
  ) || 1;
}

export function describeScopeBucket(bucket) {
  switch (bucket) {
    case MEMORY_SCOPE_BUCKETS.CHARACTER_POV:
      return "角色 POV";
    case MEMORY_SCOPE_BUCKETS.USER_POV:
      return "用户 POV";
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION:
      return "当前地区客观";
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION:
      return "邻近地区客观";
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL:
      return "全局客观";
    case MEMORY_SCOPE_BUCKETS.OTHER_POV:
      return "其他 POV";
    default:
      return normalizeString(bucket) || "未知作用域";
  }
}

export function describeMemoryScope(scope) {
  const normalized = normalizeMemoryScope(scope);
  const parts = [];
  parts.push(
    normalized.layer === MEMORY_SCOPE_LAYER.POV ? "POV" : "客观",
  );

  if (normalized.ownerType) {
    const ownerLabel = normalized.ownerName || normalized.ownerId;
    parts.push(`${normalized.ownerType}:${ownerLabel || "未命名"}`);
  }

  if (normalized.regionPrimary) {
    parts.push(`地区:${normalized.regionPrimary}`);
  }

  return parts.join(" | ");
}

export function buildScopeBadgeText(scope) {
  const normalized = normalizeMemoryScope(scope);
  if (normalized.layer === MEMORY_SCOPE_LAYER.POV) {
    const ownerLabel = normalized.ownerName || normalized.ownerId || "POV";
    return normalized.ownerType === MEMORY_SCOPE_OWNER_TYPE.USER
      ? `用户 POV · ${ownerLabel}`
      : `角色 POV · ${ownerLabel}`;
  }
  return normalized.regionPrimary ? `客观 · ${normalized.regionPrimary}` : "客观 · 全局";
}

export function buildRegionLine(scope) {
  const normalized = normalizeMemoryScope(scope);
  const regionPath = normalizeStringArray(normalized.regionPath);
  const regionSecondary = normalizeStringArray(normalized.regionSecondary);
  const parts = [];
  if (normalized.regionPrimary) {
    parts.push(`主地区: ${normalized.regionPrimary}`);
  }
  if (regionPath.length > 0) {
    parts.push(`地区路径: ${regionPath.join(" / ")}`);
  }
  if (regionSecondary.length > 0) {
    parts.push(`次级地区: ${regionSecondary.join(", ")}`);
  }
  return parts.join(" | ");
}
