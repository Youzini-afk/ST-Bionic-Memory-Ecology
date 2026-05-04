const DEFAULT_AUTHORITY_BASE_URL = "/api/plugins/authority";
const DEFAULT_AUTHORITY_PROBE_INTERVAL_MS = 60000;

const SQL_FEATURES = ["sql", "sql.query", "sql.querypage", "sql.page", "sql.pageall", "querysql"];
const SQL_MUTATION_FEATURES = ["sql", "sql.mutation", "sql.execute", "sql.exec", "sql.write", "sql.transaction"];
const TRIVIUM_FEATURES = ["trivium", "trivium.search", "trivium.query", "trivium.filterwhere", "trivium.bulkupsert", "trivium.upsert", "trivium.bulkmutations"];
const JOB_FEATURES = ["jobs", "jobs.background", "jobs.list", "jobs.wait", "diagnostics.jobspage", "events", "sse"];
const BLOB_FEATURES = ["blob", "blob.write", "storage.blob", "transfers.blob", "transfers.fs", "fs.private", "privatefiles", "private.files", "files.private"];

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
  };
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
  };
}

export function normalizeAuthorityBaseUrl(baseUrl = DEFAULT_AUTHORITY_BASE_URL) {
  const normalized = String(baseUrl || DEFAULT_AUTHORITY_BASE_URL).trim() || DEFAULT_AUTHORITY_BASE_URL;
  return normalized.replace(/\/+$/, "");
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
    features: [],
    missingFeatures: ["sql.query", "sql.mutation", "trivium.search", "jobs", "blob-or-private-files"],
    reason: "not-probed",
    lastError: "",
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
    features: Array.from(features).sort(),
    missingFeatures,
    reason: String(source.reason || (healthy ? "ok" : "not-ready")),
    lastError: String(source.lastError || ""),
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
  for (const endpoint of buildAuthorityProbeUrls(settings.baseUrl)) {
    const startedAt = readNowMs();
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers });
      const finishedAt = readNowMs();
      const status = Number(response?.status || 0);
      lastStatus = status;
      if (status === 404) continue;
      if (status === 401 || status === 403) {
        return normalizeAuthorityCapabilityState(
          {
            installed: true,
            healthy: false,
            sessionReady: false,
            permissionReady: false,
            reason: "permission-denied",
            lastError: `HTTP ${status}`,
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
            lastError: `HTTP ${status || "unknown"}`,
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
      if (healthy) {
        const verified = await verifyAuthorityDataPlane(settings.baseUrl, fetchImpl, headers, settings, readiness, options);
        sessionReady = verified.sessionReady;
        permissionReady = verified.permissionReady;
        dataPlaneStatus = Number(verified.status || status || 0);
        dataPlaneLastError = String(verified.lastError || "");
        if (verified.reason && verified.reason !== "ok") {
          reason = verified.reason;
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
          endpoint,
          status: dataPlaneStatus,
          latencyMs: normalizeLatencyMs(startedAt, finishedAt),
          lastProbeAt: nowMs,
          updatedAt: new Date(nowMs).toISOString(),
        },
        settings,
      );
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return normalizeAuthorityCapabilityState(
    {
      installed: false,
      healthy: false,
      reason: lastStatus === 404 ? "not-installed" : "probe-failed",
      lastError,
      status: lastStatus,
      lastProbeAt: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
    },
    settings,
  );
}
