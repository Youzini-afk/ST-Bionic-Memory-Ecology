import assert from "node:assert/strict";

import {
  buildAuthorityProbeUrls,
  collectAuthorityFeatures,
  createDefaultAuthorityCapabilityState,
  normalizeAuthorityCapabilityState,
  normalizeAuthorityProbeResponse,
  normalizeAuthoritySettings,
  probeAuthorityCapabilities,
} from "../runtime/authority-capabilities.js";
import { defaultSettings } from "../runtime/settings-defaults.js";

const normalizedSettings = normalizeAuthoritySettings(defaultSettings);
assert.equal(normalizedSettings.enabled, true);
assert.equal(normalizedSettings.enabledMode, "auto");
assert.equal(normalizedSettings.baseUrl, "/api/plugins/authority");
assert.equal(normalizedSettings.storageMode, "auto-server-primary");
assert.equal(normalizedSettings.vectorMode, "auto-primary");
assert.equal(normalizedSettings.primaryWhenAvailable, true);

assert.deepEqual(buildAuthorityProbeUrls("/api/plugins/authority/"), [
  "/api/plugins/authority/probe",
]);

const collected = collectAuthorityFeatures({
  features: {
    sql: { queryPage: true },
    trivium: { upsert: true },
    jobs: { background: true },
    transfers: { fs: true },
  },
});
assert.equal(collected.has("sql"), true);
assert.equal(collected.has("sql.querypage"), true);
assert.equal(collected.has("sql"), true);
assert.equal(collected.has("trivium"), true);
assert.equal(collected.has("jobs.background"), true);
assert.equal(collected.has("transfers.fs"), true);

const readyState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql", "trivium", "jobs", "transfers.fs"],
  },
  defaultSettings,
);
assert.equal(readyState.serverPrimaryReady, true);
assert.equal(readyState.storagePrimaryReady, true);
assert.equal(readyState.triviumPrimaryReady, true);
assert.equal(readyState.minimumFeatureSetReady, true);

const missingState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql"],
  },
  defaultSettings,
);
assert.equal(missingState.serverPrimaryReady, false);
assert.equal(missingState.triviumPrimaryReady, false);
assert.ok(missingState.missingFeatures.includes("trivium.search"));

const disabledState = await probeAuthorityCapabilities({
  settings: {
    ...defaultSettings,
    authorityEnabled: "off",
  },
  fetchImpl: async () => {
    throw new Error("should-not-fetch");
  },
  nowMs: 1000,
});
assert.equal(disabledState.reason, "disabled");
assert.equal(disabledState.serverPrimaryReady, false);
assert.equal(disabledState.lastProbeAt, 1000);

const requestedUrls = [];
const probedState = await probeAuthorityCapabilities({
  settings: defaultSettings,
  allowRelativeUrl: true,
  nowMs: 2000,
  fetchImpl: async (url, options = {}) => {
    requestedUrls.push([url, options.method || "GET", options.headers || {}]);
    if (url.endsWith("/probe")) {
      assert.equal(options.method, "POST");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            healthy: true,
            features: {
              sql: { queryPage: true },
              trivium: { upsert: true },
              jobs: { background: true },
              transfers: { fs: true },
            },
          };
        },
      };
    }
    if (url.endsWith("/session/init")) {
      assert.equal(options.method, "POST");
      return {
        ok: true,
        status: 200,
        async json() {
          return { sessionToken: "session-probe-token" };
        },
      };
    }
    if (url.endsWith("/session/current")) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers["x-authority-session-token"], "session-probe-token");
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    }
    if (url.endsWith("/permissions/evaluate-batch")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["x-authority-session-token"], "session-probe-token");
      const body = JSON.parse(String(options.body || "{}"));
      assert.equal(Array.isArray(body.requests), true);
      assert.equal(body.requests.some((request) => request.resource === "fs.private"), true);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: body.requests.map((request) => ({
              decision: "granted",
              resource: request.resource,
              target: request.target || "",
            })),
          };
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() {
        return {};
      },
    };
  },
});
assert.equal(requestedUrls[0]?.[0], "/api/plugins/authority/probe");
assert.deepEqual(
  requestedUrls.map(([url]) => url),
  [
    "/api/plugins/authority/probe",
    "/api/plugins/authority/session/init",
    "/api/plugins/authority/session/current",
    "/api/plugins/authority/permissions/evaluate-batch",
  ],
);
assert.equal(probedState.installed, true);
assert.equal(probedState.healthy, true);
assert.equal(probedState.serverPrimaryReady, true);
assert.equal(probedState.lastProbeAt, 2000);

const relativeUnavailable = await probeAuthorityCapabilities({
  settings: defaultSettings,
  allowRelativeUrl: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  nowMs: 3000,
});
assert.equal(relativeUnavailable.reason, "relative-url-unavailable");
assert.equal(relativeUnavailable.serverPrimaryReady, false);

// Regression: Authority capability normalization records explicit supported job types from probe payloads.
// When a probe payload provides jobs.supportedTypes, normalizeAuthorityCapabilityState should surface
// them as supportedJobTypes and set supportedJobTypesKnown = true.
const explicitJobTypesState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql", "trivium", "jobs", "transfers.fs"],
    jobs: { supportedTypes: ["authority.vector.rebuild", "authority.cache.invalidate"] },
  },
  defaultSettings,
);
assert.equal(explicitJobTypesState.supportedJobTypesKnown, true);
assert.deepEqual(explicitJobTypesState.supportedJobTypes, [
  "authority.cache.invalidate",
  "authority.vector.rebuild",
]);

// Regression: Current Authority builtin job list is known and excludes authority.vector.rebuild.
// When the probe payload reports a restricted job type list that omits authority.vector.rebuild,
// supportedJobTypes should NOT contain it and supportedJobTypesKnown should be true.
const restrictedJobTypesState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql", "trivium", "jobs", "transfers.fs"],
    jobs: {
      builtinTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
      registry: {
        jobTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
        entries: [{ type: "delay" }],
      },
    },
  },
  defaultSettings,
);
assert.equal(restrictedJobTypesState.supportedJobTypesKnown, true);
assert.equal(
  restrictedJobTypesState.supportedJobTypes.includes("authority.vector.rebuild"),
  false,
);

const authorityProbeJobTypesState = normalizeAuthorityProbeResponse(
  {
    healthy: true,
    features: {
      sql: { queryPage: true },
      trivium: { upsert: true },
      jobs: {
        background: true,
        builtinTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
      },
      transfers: { fs: true },
    },
    jobs: {
      builtinTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
      registry: {
        jobTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
        entries: [{ type: "fs.import-jsonl" }],
      },
    },
    core: {
      health: {
        jobRegistrySummary: {
          jobTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
          entries: [{ type: "trivium.flush" }],
        },
      },
    },
  },
  { settings: defaultSettings, nowMs: 4000 },
);
assert.equal(authorityProbeJobTypesState.supportedJobTypesKnown, true);
assert.deepEqual(authorityProbeJobTypesState.supportedJobTypes, [
  "delay",
  "fs.import-jsonl",
  "sql.backup",
  "trivium.flush",
]);
assert.equal(
  authorityProbeJobTypesState.supportedJobTypes.includes("authority.vector.rebuild"),
  false,
);

const renormalizedJobTypesState = normalizeAuthorityCapabilityState(
  authorityProbeJobTypesState,
  defaultSettings,
);
assert.equal(renormalizedJobTypesState.supportedJobTypesKnown, true);
assert.deepEqual(renormalizedJobTypesState.supportedJobTypes, authorityProbeJobTypesState.supportedJobTypes);

const emptySupportedJobTypesProbeState = normalizeAuthorityProbeResponse(
  {
    healthy: true,
    features: {
      sql: { queryPage: true },
      trivium: { upsert: true },
      jobs: { background: true },
      transfers: { fs: true },
    },
    supportedJobTypes: [],
  },
  { settings: defaultSettings, nowMs: 5000 },
);
assert.equal(emptySupportedJobTypesProbeState.supportedJobTypesKnown, true);
assert.deepEqual(emptySupportedJobTypesProbeState.supportedJobTypes, []);

// Regression: Legacy probes with generic jobs.background but no explicit job type list keep
// jobsReady === true and mark job type support as unknown (supportedJobTypesKnown === false).
const legacyProbeState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql", "trivium", "jobs", "transfers.fs"],
  },
  defaultSettings,
);
assert.equal(legacyProbeState.jobsReady, true);
assert.equal(legacyProbeState.supportedJobTypesKnown, false);
assert.deepEqual(legacyProbeState.supportedJobTypes, []);

const defaultCapabilityState = normalizeAuthorityCapabilityState(
  createDefaultAuthorityCapabilityState(),
  defaultSettings,
);
assert.equal(defaultCapabilityState.supportedJobTypesKnown, false);
assert.deepEqual(defaultCapabilityState.supportedJobTypes, []);

console.log("authority-capabilities tests passed");
