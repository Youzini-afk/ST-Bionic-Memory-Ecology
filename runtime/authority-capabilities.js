const DEFAULT_AUTHORITY_BASE_URL = "/api/plugins/authority";
const DEFAULT_AUTHORITY_PROBE_INTERVAL_MS = 60000;

const SQL_FEATURES = ["sql", "sql.query", "sql.querypage", "sql.page", "sql.pageall", "querysql"];
const SQL_MUTATION_FEATURES = ["sql", "sql.mutation", "sql.execute", "sql.exec", "sql.write", "sql.transaction"];
const TRIVIUM_FEATURES = ["trivium", "trivium.search", "trivium.query", "trivium.filterwhere", "trivium.bulkupsert", "trivium.upsert", "trivium.bulkmutations"];
const JOB_FEATURES = ["jobs", "jobs.background", "jobs.list", "jobs.wait", "diagnostics.jobspage", "events", "sse"];
const BLOB_FEATURES = ["blob", "blob.write", "storage.blob", "transfers.blob", "transfers.fs", "fs.private", "privatefiles", "private.files", "files.private"];
const BME_VECTOR_MANIFEST_FEATURES = ["bme.vectormanifest", "bme.vector.manifest", "bme.vector-manifest"];
const BME_VECTOR_APPLY_FEATURES = ["bme.vectorapply", "bme.vector.apply"];
const BME_VECTOR_APPLY_JOB_FEATURES = ["bme.vectorapplyjobs", "bme.vector.applyjobs", "bme.vector.apply.jobs"];
const BME_SERVER_EMBEDDING_FEATURES = ["bme.serverembeddingprobe", "bme.server.embedding.probe"];
const BME_CANDIDATE_SEARCH_FEATURES = ["bme.candidatesearch", "bme.candidate.search"];

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeMode(value, fallback, allowed) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeFeatureName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeJobType(value) {
  return String(value ?? "").trim().toLowerCase();
}

function addFeature(features, value) {
  const normalized = normalizeFeatureName(value);
  if (normalized) features.add(normalized);
}

function addFeatureObject(features, value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, enabled] of Object.entries(value)) {
    if (!enabled) continue;
    addFeature(features, key);
    if (prefix) addFeature(features, `${prefix}.${key}`);
    if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) {
      addFeatureObject(features, enabled, prefix ? `${prefix}.${key}` : key);
    }
  }
}

function hasAnyFeature(features, aliases) {
  return aliases.some((alias) => features.has(normalizeFeatureName(alias)));
}

function createFeatureReadiness(features) {
  return {
    sql: hasAnyFeature(features, SQL_FEATURES),
    sqlMutation: hasAnyFeature(features, SQL_MUTATION_FEATURES),
    trivium: hasAnyFeature(features, TRIVIUM_FEATURES),
    jobs: hasAnyFeature(features, JOB_FEATURES),
    blob: hasAnyFeature(features, BLOB_FEATURES),
    bmeVectorManifest: hasAnyFeature(features, BME_VECTOR_MANIFEST_FEATURES),
    bmeVectorApply: hasAnyFeature(features, BME_VECTOR_APPLY_FEATURES),
    bmeVectorApplyJobs: hasAnyFeature(features, BME_VECTOR_APPLY_JOB_FEATURES),
    bmeServerEmbeddingProbe: hasAnyFeature(features, BME_SERVER_EMBEDDING_FEATURES),
    bmeCandidateSearch: hasAnyFeature(features, BME_CANDIDATE_SEARCH_FEATURES),
  };
}

function normalizeBmeProtocolVersion(features, source = {}) {
  const direct = Number(source?.bme?.protocolVersion ?? source?.features?.bme?.protocolVersion ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Math.trunc(direct);
  return features.has("bme.protocolversion") ? 1 : 0;
}

function collectMissingFeatures(readiness) {
  const missing = [];
  if (!readiness.sql) missing.push("sql.query");
  if (!readiness.sqlMutation) missing.push("sql.mutation");
  if (!readiness.trivium) missing.push("trivium.search");
  if (!readiness.jobs) missing.push("jobs");
  if (!readiness.blob) missing.push("blob-or-private-files");
  return missing;
}

function isRelativeAuthorityUrl(baseUrl) {
  return /^\//.test(String(baseUrl || ""));
}

function normalizeLatencyMs(startedAt, finishedAt) {
  return Math.max(0, Math.round((Number(finishedAt) - Number(startedAt)) * 10) / 10);
}

function readNowMs() {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function clonePlain(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeHeaderName(name = "") {
  return String(name || "").trim().toLowerCase();
}

const BME_AUTHORITY_MODULE_ID_LOCAL = "third-party.st-bme";

function buildDefaultSessionInitConfig(source = {}) {
  const config = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    extensionId: String(config.extensionId || "third-party/st-bme"),
    displayName: String(config.displayName || "ST-BME"),
    version: String(config.version || "0.0.0"),
    installType: String(config.installType || "local"),
    declaredPermissions: clonePlain(config.declaredPermissions, null) || {
      storage: { kv: true, blob: true },
      fs: { private: true },
      sql: { private: true },
      trivium: { private: true },
      jobs: { background: true },
      events: { channels: true },
      modules: {
        execute: [
          `${BME_AUTHORITY_MODULE_ID_LOCAL}:vector.manifest`,
          `${BME_AUTHORITY_MODULE_ID_LOCAL}:vector.apply`,
          `${BME_AUTHORITY_MODULE_ID_LOCAL}:recall.candidates`,
          `${BME_AUTHORITY_MODULE_ID_LOCAL}:graph.commitDelta`,
          `${BME_AUTHORITY_MODULE_ID_LOCAL}:extraction.commitBatch`,
        ],
      },
    },
    ...(config.uiLabel ? { uiLabel: String(config.uiLabel) } : {}),
  };
}

function withJsonHeaders(headers = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(headers || {}),
  };
}

async function readResponsePayload(response = null) {
  if (!response) return {};
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
    }
  }
  if (typeof response.text === "function") {
    try {
      return { error: await response.text() };
    } catch {
      return {};
    }
  }
  return {};
}

function readPayloadMessage(payload = {}, fallback = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  return String(payload.error || payload.message || payload.reason || fallback || "");
}

function classifyAuthorityProbeStatus(status = 0, payload = null) {
  const payloadCategory = String(payload?.category || "").trim();
  if (payloadCategory) return payloadCategory;
  const numericStatus = Number(status || 0);
  if (numericStatus === 408) return "timeout";
  if (numericStatus === 401 || numericStatus === 403) return "permission";
  if (numericStatus === 413) return "payload-too-large";
  if (numericStatus === 429) return "rate-limit";
  if (numericStatus >= 500) return "server";
  if (numericStatus >= 400) return "validation";
  return "";
}

function classifyAuthorityProbeError(error = null) {
  const category = String(error?.category || error?.errorCategory || "").trim();
  if (category) return category;
  if (String(error?.name || "") === "AbortError") return "timeout";
  return error ? "network" : "";
}

function buildAuthorityPermissionEvaluateRequests(settings = {}, readiness = {}, options = {}) {
  const requests = [];
  const sqlTarget = String(options.sqlTarget || settings.sqlTarget || "default");
  const triviumTarget = String(options.triviumTarget || settings.triviumTarget || "st_bme_vectors");
  const jobTarget = String(options.jobTarget || settings.jobTarget || "delay");
  if (readiness.sql || readiness.sqlMutation) {
    requests.push({ resource: "sql.private", target: sqlTarget, reason: `Probe SQL capability for ${sqlTarget}` });
  }
  if (readiness.trivium) {
    requests.push({ resource: "trivium.private", target: triviumTarget, reason: `Probe Trivium capability for ${triviumTarget}` });
  }
  if (readiness.blob) {
    requests.push({ resource: "fs.private", reason: "Probe private file capability for Authority Blob adapter" });
  }
  if (readiness.jobs) {
    requests.push({ resource: "jobs.background", target: jobTarget, reason: `Probe Jobs capability for ${jobTarget}` });
  }
  return requests;
}

async function verifyAuthorityDataPlane(baseUrl, fetchImpl, headers, settings = {}, readiness = {}, options = {}) {
  const initHeaders = withJsonHeaders(headers);
  const initResponse = await fetchImpl(`${baseUrl}/session/init`, {
    method: "POST",
    headers: initHeaders,
    body: JSON.stringify(buildDefaultSessionInitConfig(options.sessionInitConfig || settings)),
  });
  const initStatus = Number(initResponse?.status || 0);
  const initPayload = await readResponsePayload(initResponse);
  if (!initResponse?.ok) {
    return {
      sessionReady: false,
      permissionReady: false,
      reason: initStatus === 401 || initStatus === 403 ? "session-init-denied" : "session-init-failed",
      lastError: readPayloadMessage(initPayload, `HTTP ${initStatus || "unknown"}`),
      status: initStatus,
      errorCategory: classifyAuthorityProbeStatus(initStatus, initPayload),
      errorDomain: "authority",
    };
  }

  const sessionToken = String(initPayload?.sessionToken || initPayload?.token || "");
  if (!sessionToken) {
    return {
      sessionReady: false,
      permissionReady: false,
      reason: "session-token-missing",
      lastError: "session token missing",
      status: initStatus,
    };
  }

  const sessionHeaders = {
    ...withJsonHeaders(headers),
    ...(Object.keys(headers || {}).some((name) => normalizeHeaderName(name) === "x-authority-session-token")
      ? {}
      : { "x-authority-session-token": sessionToken }),
  };
  const currentResponse = await fetchImpl(`${baseUrl}/session/current`, {
    method: "GET",
    headers: sessionHeaders,
  });
  const currentStatus = Number(currentResponse?.status || 0);
  const currentPayload = await readResponsePayload(currentResponse);
  if (!currentResponse?.ok) {
    return {
      sessionReady: false,
      permissionReady: false,
      reason: currentStatus === 401 || currentStatus === 403 ? "session-invalid" : "session-current-failed",
      lastError: readPayloadMessage(currentPayload, `HTTP ${currentStatus || "unknown"}`),
      status: currentStatus,
      errorCategory: classifyAuthorityProbeStatus(currentStatus, currentPayload),
      errorDomain: "authority",
    };
  }

  const requests = buildAuthorityPermissionEvaluateRequests(settings, readiness, options);
  if (!requests.length) {
    return {
      sessionReady: true,
      permissionReady: true,
      reason: "ok",
      lastError: "",
      status: currentStatus,
      // Internal: authenticated headers for downstream /modules fetch.
      // Not exposed on the public capability state.
      _sessionHeaders: sessionHeaders,
    };
  }

  const permissionResponse = await fetchImpl(`${baseUrl}/permissions/evaluate-batch`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ requests }),
  });
  const permissionStatus = Number(permissionResponse?.status || 0);
  const permissionPayload = await readResponsePayload(permissionResponse);
  if (!permissionResponse?.ok) {
    return {
      sessionReady: true,
      permissionReady: false,
      reason: permissionStatus === 401 || permissionStatus === 403 ? "permission-denied" : "permission-evaluate-failed",
      lastError: readPayloadMessage(permissionPayload, `HTTP ${permissionStatus || "unknown"}`),
      status: permissionStatus,
      errorCategory: classifyAuthorityProbeStatus(permissionStatus, permissionPayload),
      errorDomain: "authority",
    };
  }

  const results = Array.isArray(permissionPayload?.results) ? permissionPayload.results : [];
  const permissionReady = results.length === requests.length && results.every((result) => {
    const decision = String(result?.decision || result?.grant?.status || "").trim().toLowerCase();
    return decision === "granted";
  });
  return {
    sessionReady: true,
    permissionReady,
    reason: permissionReady ? "ok" : "permission-not-ready",
    lastError: permissionReady ? "" : "required Authority permissions are not granted",
    status: permissionStatus || currentStatus,
    // Internal: authenticated headers for downstream /modules fetch.
    // Not exposed on the public capability state.
    _sessionHeaders: sessionHeaders,
  };
}

/**
 * Phase C: fetch the generic `/modules` list to derive companion module
 * readiness. Uses the authenticated session headers from data-plane
 * verification so the call carries `x-authority-session-token`. Non-fatal:
 * callers catch failures and fall back to legacy feature-based readiness.
 *
 * Returns a `moduleReadiness` object suitable for
 * `normalizeAuthorityCapabilityState({ moduleReadiness })`, or `null` if
 * the fetch fails or the response is not ok.
 */
async function fetchModuleReadiness(baseUrl, fetchImpl, sessionHeaders = {}) {
  const response = await fetchImpl(`${baseUrl}/modules`, {
    method: "GET",
    headers: withJsonHeaders(sessionHeaders),
  });
  if (!response?.ok) {
    return null;
  }
  const payload = await readResponsePayload(response);
  return deriveModuleReadiness(payload);
}

export function normalizeAuthorityBaseUrl(baseUrl = DEFAULT_AUTHORITY_BASE_URL) {
  const normalized = String(baseUrl || DEFAULT_AUTHORITY_BASE_URL).trim() || DEFAULT_AUTHORITY_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

/**
 * BME companion module id as shipped in `.authority/module.json`.
 * Used to look up the module record in the generic `/modules` list.
 */
export const BME_AUTHORITY_MODULE_ID = "third-party.st-bme";
const BME_VECTOR_MANIFEST_TRANSACTION = "vector.manifest";
const BME_VECTOR_APPLY_TRANSACTION = "vector.apply";
const BME_RECALL_CANDIDATES_TRANSACTION = "recall.candidates";
const BME_GRAPH_COMMIT_DELTA_TRANSACTION = "graph.commitDelta";
export const BME_EXTRACTION_COMMIT_BATCH_TRANSACTION = "extraction.commitBatch";

/**
 * Derive module readiness from a generic DOA `/modules` response.
 *
 * The `/modules` response shape is:
 *   { modules: AuthorityModuleManifest[], count, records?: AuthorityModuleRecord[], recordCount? }
 *
 * A record is "loaded" when `record.status === 'loaded'`. The `/modules`
 * list also carries executable manifests in `modules[]`; if a manifest is
 * present there, the module is executable regardless of record status
 * (built-in compiled modules don't always have a discovery record).
 *
 * For the BME module specifically, we additionally check that the manifest
 * declares `vector.manifest` and `vector.apply` transactions.
 *
 * Returns a readiness object with `modulesReady`, `bmeModuleReady`,
 * `bmeVectorManifestReady`, `bmeVectorApplyReady`.
 */
export function deriveModuleReadiness(modulesPayload = {}) {
  const source = modulesPayload && typeof modulesPayload === "object" && !Array.isArray(modulesPayload) ? modulesPayload : {};
  const records = Array.isArray(source.records) ? source.records : [];
  const manifests = Array.isArray(source.modules) ? source.modules : [];

  const modulesReady = records.length > 0 || manifests.length > 0;

  // Find the BME module record (by moduleId). Prefer `loaded` status;
  // if no record exists but the manifest is in `modules[]`, treat as
  // executable (built-in compiled module).
  const bmeRecord = records.find((record) => record?.moduleId === BME_AUTHORITY_MODULE_ID);
  const bmeManifest = manifests.find((manifest) => manifest?.id === BME_AUTHORITY_MODULE_ID);

  const bmeModuleReady = bmeRecord
    ? bmeRecord.status === "loaded"
    : Boolean(bmeManifest);

  // Check transaction declarations on the manifest (from record or modules list).
  const manifestForTxCheck = bmeRecord?.manifest || bmeManifest;
  const transactions = manifestForTxCheck?.transactions || {};
  const hasVectorManifest = Boolean(transactions[BME_VECTOR_MANIFEST_TRANSACTION]);
  const hasVectorApply = Boolean(transactions[BME_VECTOR_APPLY_TRANSACTION]);
  const hasRecallCandidates = Boolean(transactions[BME_RECALL_CANDIDATES_TRANSACTION]);
  const hasGraphCommitDelta = Boolean(transactions[BME_GRAPH_COMMIT_DELTA_TRANSACTION]);
  const hasExtractionCommitBatch = Boolean(transactions[BME_EXTRACTION_COMMIT_BATCH_TRANSACTION]);

  return {
    modulesReady,
    bmeModuleReady,
    bmeVectorManifestReady: bmeModuleReady && hasVectorManifest,
    bmeVectorApplyReady: bmeModuleReady && hasVectorApply,
    bmeCandidateSearchReady: bmeModuleReady && hasRecallCandidates,
    bmeGraphCommitReady: bmeModuleReady && hasGraphCommitDelta,
    bmeExtractionCommitBatchReady: bmeModuleReady && hasExtractionCommitBatch,
  };
}

export function normalizeAuthoritySettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const enabledMode = normalizeMode(source.authorityEnabled ?? source.enabledMode, "auto", ["auto", "on", "off", "true", "false"]);
  return {
    enabledMode: enabledMode === "true" ? "on" : enabledMode === "false" ? "off" : enabledMode,
    enabled: enabledMode !== "off" && enabledMode !== "false",
    baseUrl: normalizeAuthorityBaseUrl(source.authorityBaseUrl ?? source.baseUrl),
    primaryWhenAvailable: toBoolean(source.authorityPrimaryWhenAvailable ?? source.primaryWhenAvailable, true),
    storageMode: normalizeMode(source.authorityStorageMode ?? source.storageMode, "auto-server-primary", ["auto-server-primary", "server-primary", "local-primary", "off"]),
    vectorMode: normalizeMode(source.authorityVectorMode ?? source.vectorMode, "auto-primary", ["auto-primary", "primary", "local-fallback", "off"]),
    sqlPrimary: toBoolean(source.authoritySqlPrimary ?? source.sqlPrimary, true),
    triviumPrimary: toBoolean(source.authorityTriviumPrimary ?? source.triviumPrimary, true),
    jobsEnabled: toBoolean(source.authorityJobsEnabled ?? source.jobsEnabled, true),
    blobCheckpointEnabled: toBoolean(source.authorityBlobCheckpointEnabled ?? source.blobCheckpointEnabled, true),
    diagnosticsEnabled: toBoolean(source.authorityDiagnosticsEnabled ?? source.diagnosticsEnabled, true),
    failOpen: toBoolean(source.authorityFailOpen ?? source.failOpen, true),
    probeIntervalMs: clampInteger(source.authorityProbeIntervalMs ?? source.probeIntervalMs, DEFAULT_AUTHORITY_PROBE_INTERVAL_MS, 1000, 3600000),
  };
}

export function buildAuthorityProbeUrls(baseUrl = DEFAULT_AUTHORITY_BASE_URL) {
  const normalizedBaseUrl = normalizeAuthorityBaseUrl(baseUrl);
  return [`${normalizedBaseUrl}/probe`];
}

export function collectAuthorityFeatures(payload = {}) {
  const features = new Set();
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  for (const value of Array.isArray(source.features) ? source.features : []) {
    addFeature(features, value);
  }
  for (const value of Array.isArray(source.capabilities) ? source.capabilities : []) {
    addFeature(features, value);
  }
  addFeatureObject(features, source.features);
  addFeatureObject(features, source.capabilities);
  addFeatureObject(features, source.services);
  addFeatureObject(features, source.featureFlags);
  addFeatureObject(features, source.flags);
  return features;
}

function collectJobTypesFromArray(jobTypes, value) {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    const normalized = normalizeJobType(item);
    if (normalized) jobTypes.add(normalized);
  }
  return true;
}

function collectJobTypesFromEntries(jobTypes, value) {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    const normalized = normalizeJobType(entry?.type);
    if (normalized) jobTypes.add(normalized);
  }
  return true;
}

function collectSupportedJobTypes(payload = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const jobTypes = new Set();
  let known = source.supportedJobTypesKnown === true;

  const topLevelSupportedJobTypes = source.supportedJobTypes;
  if (Array.isArray(topLevelSupportedJobTypes)) {
    collectJobTypesFromArray(jobTypes, topLevelSupportedJobTypes);
    known =
      known ||
      topLevelSupportedJobTypes.length > 0 ||
      source.reason === "ok" ||
      Number(source.lastProbeAt || 0) > 0 ||
      source.installed === true ||
      source.healthy === true;
  }

  for (const value of [
    source.jobs?.supportedTypes,
    source.jobs?.builtinTypes,
    source.jobs?.registry?.jobTypes,
    source.features?.jobs?.supportedTypes,
    source.features?.jobs?.builtinTypes,
    source.features?.jobs?.registry?.jobTypes,
    source.featureDetails?.jobs?.supportedTypes,
    source.featureDetails?.jobs?.builtinTypes,
    source.featureDetails?.jobs?.registry?.jobTypes,
    source.core?.health?.jobRegistrySummary?.jobTypes,
  ]) {
    known = collectJobTypesFromArray(jobTypes, value) || known;
  }

  for (const value of [
    source.jobs?.registry?.entries,
    source.features?.jobs?.registry?.entries,
    source.featureDetails?.jobs?.registry?.entries,
    source.core?.health?.jobRegistrySummary?.entries,
  ]) {
    known = collectJobTypesFromEntries(jobTypes, value) || known;
  }

  return {
    supportedJobTypes: Array.from(jobTypes).sort(),
    supportedJobTypesKnown: known,
  };
}

export function createDefaultAuthorityCapabilityState(overrides = {}) {
  return {
    enabledMode: "auto",
    baseUrl: DEFAULT_AUTHORITY_BASE_URL,
    installed: false,
    healthy: false,
    sessionReady: false,
    permissionReady: false,
    minimumFeatureSetReady: false,
    serverPrimaryReady: false,
    storagePrimaryReady: false,
    triviumPrimaryReady: false,
    jobsReady: false,
    supportedJobTypes: [],
    supportedJobTypesKnown: false,
    blobReady: false,
    modulesReady: false,
    bmeModuleReady: false,
    bmeVectorManifestReady: false,
    bmeVectorApplyReady: false,
    bmeVectorApplyJobsReady: false,
    bmeServerEmbeddingProbeReady: false,
    bmeCandidateSearchReady: false,
    bmeGraphCommitReady: false,
    bmeExtractionCommitBatchReady: false,
    bmeProtocolVersion: 0,
    features: [],
    missingFeatures: ["sql.query", "sql.mutation", "trivium.search", "jobs", "blob-or-private-files"],
    reason: "not-probed",
    lastError: "",
    errorCategory: "",
    errorDomain: "",
    endpoint: "",
    status: 0,
    latencyMs: 0,
    lastProbeAt: 0,
    updatedAt: "",
    ...overrides,
  };
}

export function normalizeAuthorityCapabilityState(input = {}, settings = {}) {
  const normalizedSettings = normalizeAuthoritySettings(settings);
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const features = new Set((Array.isArray(source.features) ? source.features : []).map(normalizeFeatureName).filter(Boolean));
  const readiness = createFeatureReadiness(features);
  const supportedJobs = collectSupportedJobTypes(source);
  const missingFeatures = Array.isArray(source.missingFeatures) && source.missingFeatures.length
    ? source.missingFeatures.map(String)
    : collectMissingFeatures(readiness);
  const healthy = Boolean(source.healthy);
  const sessionReady = source.sessionReady == null ? healthy : Boolean(source.sessionReady);
  const permissionReady = source.permissionReady == null ? sessionReady : Boolean(source.permissionReady);
  const storagePrimaryReady = healthy && sessionReady && permissionReady && readiness.sql && readiness.sqlMutation;
  const triviumPrimaryReady = healthy && sessionReady && permissionReady && readiness.trivium;
  const jobsReady = healthy && readiness.jobs;
  const blobReady = healthy && readiness.blob;
  const bmeProtocolVersion = normalizeBmeProtocolVersion(features, source);

  // Phase C: derive module readiness from the generic DOA `/modules` list.
  // `moduleReadiness` is computed by `deriveModuleReadiness()` (or passed in
  // from `probeAuthorityCapabilities` after fetching `/modules`). If
  // moduleReadiness is not provided, fall back to legacy `features.bme.*`
  // signals so existing probes that don't fetch `/modules` still work.
  const moduleReadiness = source.moduleReadiness || {};
  const modulesReady = Boolean(moduleReadiness.modulesReady);
  const bmeModuleReady = Boolean(moduleReadiness.bmeModuleReady);
  const bmeModuleVectorManifestReady = Boolean(moduleReadiness.bmeVectorManifestReady);
  const bmeModuleVectorApplyReady = Boolean(moduleReadiness.bmeVectorApplyReady);
  const bmeModuleCandidateSearchReady = Boolean(moduleReadiness.bmeCandidateSearchReady);
  const bmeModuleGraphCommitReady = Boolean(moduleReadiness.bmeGraphCommitReady);
  const bmeModuleExtractionCommitBatchReady = Boolean(moduleReadiness.bmeExtractionCommitBatchReady);

  // Legacy: if module readiness is not available, fall back to features.
  const legacyBmeVectorManifestReady = healthy && sessionReady && permissionReady && readiness.bmeVectorManifest;
  const legacyBmeVectorApplyReady = healthy && sessionReady && permissionReady && readiness.bmeVectorApply;
  const legacyBmeCandidateSearchReady = healthy && sessionReady && permissionReady && readiness.bmeCandidateSearch;

  // Primary readiness: module-based if available, otherwise legacy.
  const bmeVectorManifestReady = moduleReadiness.modulesReady
    ? (bmeModuleReady && bmeModuleVectorManifestReady)
    : legacyBmeVectorManifestReady;
  const bmeVectorApplyReady = moduleReadiness.modulesReady
    ? (bmeModuleReady && bmeModuleVectorApplyReady)
    : legacyBmeVectorApplyReady;
  const bmeCandidateSearchReady = moduleReadiness.modulesReady
    ? (bmeModuleReady && bmeModuleCandidateSearchReady)
    : legacyBmeCandidateSearchReady;
  // graph.commitDelta has no legacy feature flag — only the companion module
  // path supplies it. When module readiness is unavailable or the module is
  // not loaded, bmeGraphCommitReady stays false and the frontend keeps using
  // the existing local chunked AuthorityGraphStore.commitDelta path.
  const bmeGraphCommitReady = moduleReadiness.modulesReady
    ? (bmeModuleReady && bmeModuleGraphCommitReady)
    : false;
  const bmeExtractionCommitBatchReady = moduleReadiness.modulesReady
    ? (bmeModuleReady && bmeModuleExtractionCommitBatchReady)
    : false;

  const bmeVectorApplyJobsReady = healthy && sessionReady && permissionReady && readiness.bmeVectorApplyJobs;
  const bmeServerEmbeddingProbeReady = healthy && sessionReady && permissionReady && readiness.bmeServerEmbeddingProbe;
  const minimumFeatureSetReady = storagePrimaryReady && triviumPrimaryReady && jobsReady && blobReady;
  const serverPrimaryRequested =
    normalizedSettings.enabled &&
    normalizedSettings.primaryWhenAvailable &&
    normalizedSettings.storageMode !== "local-primary" &&
    normalizedSettings.storageMode !== "off";
  return createDefaultAuthorityCapabilityState({
    ...source,
    enabledMode: normalizedSettings.enabledMode,
    baseUrl: normalizedSettings.baseUrl,
    installed: Boolean(source.installed),
    healthy,
    sessionReady,
    permissionReady,
    minimumFeatureSetReady,
    serverPrimaryReady: serverPrimaryRequested && minimumFeatureSetReady,
    storagePrimaryReady,
    triviumPrimaryReady,
    jobsReady,
    supportedJobTypes: supportedJobs.supportedJobTypes,
    supportedJobTypesKnown: supportedJobs.supportedJobTypesKnown,
    blobReady,
    modulesReady,
    bmeModuleReady,
    bmeVectorManifestReady,
    bmeVectorApplyReady,
    bmeVectorApplyJobsReady,
    bmeServerEmbeddingProbeReady,
    bmeCandidateSearchReady,
    bmeGraphCommitReady,
    bmeExtractionCommitBatchReady,
    bmeProtocolVersion,
    features: Array.from(features).sort(),
    missingFeatures,
    reason: String(source.reason || (healthy ? "ok" : "not-ready")),
    lastError: String(source.lastError || ""),
    errorCategory: String(source.errorCategory || ""),
    errorDomain: String(source.errorDomain || ""),
    endpoint: String(source.endpoint || ""),
    status: clampInteger(source.status, 0, 0, 999),
    latencyMs: Math.max(0, Number(source.latencyMs) || 0),
    lastProbeAt: Math.max(0, Number(source.lastProbeAt) || 0),
    updatedAt: String(source.updatedAt || ""),
  });
}

export function normalizeAuthorityProbeResponse(payload = {}, context = {}) {
  const settings = normalizeAuthoritySettings(context.settings || {});
  const features = collectAuthorityFeatures(payload);
  const supportedJobs = collectSupportedJobTypes(payload);
  const readiness = createFeatureReadiness(features);
  const missingFeatures = collectMissingFeatures(readiness);
  const sessionReady = payload?.sessionReady ?? payload?.session?.ready ?? payload?.session?.active ?? true;
  const permissionReady = payload?.permissionReady ?? payload?.permissions?.ready ?? payload?.authorized ?? sessionReady;
  const healthy = payload?.healthy ?? payload?.ok ?? true;
  return normalizeAuthorityCapabilityState(
    {
      installed: true,
      healthy: Boolean(healthy),
      sessionReady: Boolean(sessionReady),
      permissionReady: Boolean(permissionReady),
      features: Array.from(features),
      supportedJobTypes: supportedJobs.supportedJobTypes,
      supportedJobTypesKnown: supportedJobs.supportedJobTypesKnown,
      missingFeatures,
      reason: missingFeatures.length ? "missing-required-features" : "ok",
      endpoint: context.endpoint || "",
      status: context.status || 200,
      latencyMs: context.latencyMs || 0,
      lastProbeAt: context.nowMs || Date.now(),
      updatedAt: new Date(context.nowMs || Date.now()).toISOString(),
    },
    settings,
  );
}

export async function probeAuthorityCapabilities(options = {}) {
  const settings = normalizeAuthoritySettings(options.settings || {});
  const nowMs = Number(options.nowMs) || Date.now();
  if (!settings.enabled || settings.storageMode === "off") {
    return normalizeAuthorityCapabilityState(
      {
        reason: "disabled",
        lastProbeAt: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      settings,
    );
  }

  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchImpl !== "function") {
    return normalizeAuthorityCapabilityState(
      {
        reason: "fetch-unavailable",
        lastError: "fetch unavailable",
        lastProbeAt: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      settings,
    );
  }

  if (options.allowRelativeUrl === false && isRelativeAuthorityUrl(settings.baseUrl)) {
    return normalizeAuthorityCapabilityState(
      {
        reason: "relative-url-unavailable",
        lastError: "relative Authority URL cannot be probed in this runtime",
        lastProbeAt: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      settings,
    );
  }

  let headers = { Accept: "application/json" };
  if (typeof options.headerProvider === "function") {
    try {
      headers = { ...headers, ...(options.headerProvider() || {}) };
    } catch {
      headers = { ...headers };
    }
  }

  let lastError = "";
  let lastStatus = 0;
  let lastErrorCategory = "";
  for (const endpoint of buildAuthorityProbeUrls(settings.baseUrl)) {
    const startedAt = readNowMs();
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers });
      const finishedAt = readNowMs();
      const status = Number(response?.status || 0);
      lastStatus = status;
      if (status === 404) continue;
      const errorPayload = response?.ok ? null : await readResponsePayload(response);
      if (status === 401 || status === 403) {
        return normalizeAuthorityCapabilityState(
          {
            installed: true,
            healthy: false,
            sessionReady: false,
            permissionReady: false,
            reason: "permission-denied",
            lastError: readPayloadMessage(errorPayload, `HTTP ${status}`),
            errorCategory: classifyAuthorityProbeStatus(status, errorPayload),
            errorDomain: "authority",
            endpoint,
            status,
            latencyMs: normalizeLatencyMs(startedAt, finishedAt),
            lastProbeAt: nowMs,
            updatedAt: new Date(nowMs).toISOString(),
          },
          settings,
        );
      }
      if (!response?.ok) {
        return normalizeAuthorityCapabilityState(
          {
            installed: status > 0,
            healthy: false,
            reason: "http-error",
            lastError: readPayloadMessage(errorPayload, `HTTP ${status || "unknown"}`),
            errorCategory: classifyAuthorityProbeStatus(status, errorPayload),
            errorDomain: "authority",
            endpoint,
            status,
            latencyMs: normalizeLatencyMs(startedAt, finishedAt),
            lastProbeAt: nowMs,
            updatedAt: new Date(nowMs).toISOString(),
          },
          settings,
        );
      }
      let payload = {};
      try {
        payload = typeof response.json === "function" ? await response.json() : {};
      } catch {
        payload = {};
      }
      const features = collectAuthorityFeatures(payload);
      const supportedJobs = collectSupportedJobTypes(payload);
      const readiness = createFeatureReadiness(features);
      const missingFeatures = collectMissingFeatures(readiness);
      const healthy = payload?.healthy ?? payload?.ok ?? true;
      let sessionReady = payload?.sessionReady ?? payload?.session?.ready ?? payload?.session?.active;
      let permissionReady = payload?.permissionReady ?? payload?.permissions?.ready ?? payload?.authorized;
      let reason = missingFeatures.length ? "missing-required-features" : "ok";
      let dataPlaneLastError = "";
      let dataPlaneStatus = status;
      let dataPlaneErrorCategory = "";
      let dataPlaneErrorDomain = "";
      let verifiedSessionHeaders = null;
      if (healthy) {
        const verified = await verifyAuthorityDataPlane(settings.baseUrl, fetchImpl, headers, settings, readiness, options);
        sessionReady = verified.sessionReady;
        permissionReady = verified.permissionReady;
        dataPlaneStatus = Number(verified.status || status || 0);
        dataPlaneLastError = String(verified.lastError || "");
        dataPlaneErrorCategory = String(verified.errorCategory || "");
        dataPlaneErrorDomain = String(verified.errorDomain || "");
        if (verified.reason && verified.reason !== "ok") {
          reason = verified.reason;
        }
        // Internal: capture authenticated session headers for /modules fetch.
        verifiedSessionHeaders = verified._sessionHeaders || null;
      }
      // Phase C: fetch the generic /modules list to derive BME companion
      // module readiness. This is non-fatal — if the fetch fails, we fall
      // back to legacy features.bme.* readiness. Only attempt when the
      // data-plane session is healthy so we have valid session headers.
      let moduleReadiness = null;
      if (healthy && sessionReady && permissionReady && verifiedSessionHeaders) {
        try {
          moduleReadiness = await fetchModuleReadiness(settings.baseUrl, fetchImpl, verifiedSessionHeaders);
        } catch {
          // Non-fatal: legacy readiness from features still applies.
        }
      }
      return normalizeAuthorityCapabilityState(
        {
          installed: true,
          healthy: Boolean(healthy),
          sessionReady: Boolean(sessionReady),
          permissionReady: Boolean(permissionReady),
          features: Array.from(features),
          supportedJobTypes: supportedJobs.supportedJobTypes,
          supportedJobTypesKnown: supportedJobs.supportedJobTypesKnown,
          missingFeatures,
          reason,
          lastError: dataPlaneLastError,
          errorCategory: dataPlaneErrorCategory,
          errorDomain: dataPlaneErrorDomain,
          endpoint,
          status: dataPlaneStatus,
          latencyMs: normalizeLatencyMs(startedAt, finishedAt),
          lastProbeAt: nowMs,
          updatedAt: new Date(nowMs).toISOString(),
          ...(moduleReadiness ? { moduleReadiness } : {}),
        },
        settings,
      );
    } catch (error) {
      lastError = error?.message || String(error);
      lastStatus = Number(error?.status || lastStatus || 0);
      lastErrorCategory = classifyAuthorityProbeError(error);
    }
  }

  return normalizeAuthorityCapabilityState(
    {
      installed: false,
      healthy: false,
      reason: lastStatus === 404 ? "not-installed" : "probe-failed",
      lastError,
      errorCategory: lastErrorCategory || classifyAuthorityProbeStatus(lastStatus),
      errorDomain: lastErrorCategory || lastStatus ? "authority" : "",
      status: lastStatus,
      lastProbeAt: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
    },
    settings,
  );
}
