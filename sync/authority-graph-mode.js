export const GRAPH_OPERATIONAL_MODE_LOCAL_ONLY = "local-only";
export const GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY = "authority-primary";
export const GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED = "authority-degraded";

export const GRAPH_OPERATIONAL_MODES = Object.freeze({
  LOCAL_ONLY: GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
  AUTHORITY_PRIMARY: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  AUTHORITY_DEGRADED: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
});

const VALID_GRAPH_OPERATIONAL_MODES = new Set([
  GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
  GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
]);

export function normalizeGraphOperationalMode(value, fallback = GRAPH_OPERATIONAL_MODE_LOCAL_ONLY) {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_GRAPH_OPERATIONAL_MODES.has(normalized)) return normalized;
  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  return VALID_GRAPH_OPERATIONAL_MODES.has(normalizedFallback)
    ? normalizedFallback
    : GRAPH_OPERATIONAL_MODE_LOCAL_ONLY;
}

export function isAuthorityGraphOperationalMode(mode) {
  const normalized = normalizeGraphOperationalMode(mode);
  return (
    normalized === GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY ||
    normalized === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED
  );
}

export function isAuthorityOwnedGraphMeta(meta = null) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.authorityOwned === true) return true;
  return isAuthorityGraphOperationalMode(meta.graphOperationalMode);
}

export function resolveGraphOperationalMode(meta = null, fallback = GRAPH_OPERATIONAL_MODE_LOCAL_ONLY) {
  const source = meta && typeof meta === "object" ? meta : {};
  const mode = normalizeGraphOperationalMode(source.graphOperationalMode, fallback);
  if (mode !== GRAPH_OPERATIONAL_MODE_LOCAL_ONLY) return mode;
  return source.authorityOwned === true
    ? GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED
    : GRAPH_OPERATIONAL_MODE_LOCAL_ONLY;
}

export function normalizeGraphAuthorityMeta(meta = null) {
  const source = meta && typeof meta === "object" ? meta : {};
  const graphOperationalMode = resolveGraphOperationalMode(source);
  const authorityOwned = source.authorityOwned === true || isAuthorityGraphOperationalMode(graphOperationalMode);
  return {
    authorityOwned,
    graphOperationalMode: authorityOwned ? graphOperationalMode : GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
  };
}
