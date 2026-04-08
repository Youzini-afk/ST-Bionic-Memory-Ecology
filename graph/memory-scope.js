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
  const regionPrimary = normalizeString(merged.regionPrimary);
  const regionPath = normalizeStringArray(merged.regionPath);
  const regionSecondary = normalizeStringArray(merged.regionSecondary);

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
  return normalizeStringArray([
    normalized.regionPrimary,
    ...normalized.regionPath,
    ...normalized.regionSecondary,
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
  const parts = [];
  if (normalized.regionPrimary) {
    parts.push(`主地区: ${normalized.regionPrimary}`);
  }
  if (normalized.regionPath.length > 0) {
    parts.push(`地区路径: ${normalized.regionPath.join(" / ")}`);
  }
  if (normalized.regionSecondary.length > 0) {
    parts.push(`次级地区: ${normalized.regionSecondary.join(", ")}`);
  }
  return parts.join(" | ");
}
