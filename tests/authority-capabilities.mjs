import assert from "node:assert/strict";

import {
  buildAuthorityProbeUrls,
  collectAuthorityFeatures,
  normalizeAuthorityCapabilityState,
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
  "/api/plugins/authority/v1/diagnostics/probe",
  "/api/plugins/authority/v1/probe",
  "/api/plugins/authority/probe",
  "/api/plugins/authority",
]);

const collected = collectAuthorityFeatures({
  features: ["sql.query", "trivium.search"],
  services: {
    sql: true,
    jobs: true,
    blob: true,
  },
});
assert.equal(collected.has("sql.query"), true);
assert.equal(collected.has("trivium.search"), true);
assert.equal(collected.has("sql"), true);
assert.equal(collected.has("jobs"), true);
assert.equal(collected.has("blob"), true);

const readyState = normalizeAuthorityCapabilityState(
  {
    installed: true,
    healthy: true,
    features: ["sql", "trivium", "jobs", "blob"],
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

let requestedUrl = "";
const probedState = await probeAuthorityCapabilities({
  settings: defaultSettings,
  allowRelativeUrl: true,
  nowMs: 2000,
  fetchImpl: async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          healthy: true,
          sessionReady: true,
          permissionReady: true,
          features: ["sql", "trivium", "jobs", "blob"],
        };
      },
    };
  },
});
assert.equal(requestedUrl, "/api/plugins/authority/v1/diagnostics/probe");
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

console.log("authority-capabilities tests passed");
