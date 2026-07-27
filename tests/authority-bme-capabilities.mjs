import assert from "node:assert/strict";

import {
  normalizeAuthorityProbeResponse,
  normalizeAuthorityCapabilityState,
  deriveModuleReadiness,
  probeAuthorityCapabilities,
  BME_AUTHORITY_MODULE_ID,
} from "../runtime/authority-capabilities.js";

const capability = normalizeAuthorityProbeResponse({
  healthy: true,
  features: {
    sql: { queryPage: true, stat: true },
    trivium: { bulkMutations: true, searchContext: true },
    jobs: { background: true, builtinTypes: ["delay", "trivium.flush"] },
    transfers: { blob: true, fs: true },
    bme: {
      protocolVersion: 1,
      vectorManifest: true,
      vectorApply: true,
      vectorApplyJobs: false,
      serverEmbeddingProbe: false,
      candidateSearch: false,
    },
  },
});

assert.equal(capability.bmeProtocolVersion, 1);
assert.equal(capability.bmeVectorManifestReady, true);
assert.equal(capability.bmeVectorApplyReady, true);
assert.equal(capability.bmeServerEmbeddingProbeReady, false);
assert.ok(capability.features.includes("bme.vectormanifest"));
assert.ok(capability.features.includes("bme.protocolversion"));

const legacy = normalizeAuthorityCapabilityState({
  installed: true,
  healthy: true,
  sessionReady: true,
  permissionReady: true,
  features: ["sql.query", "sql.mutation", "trivium.search"],
});
assert.equal(legacy.bmeVectorManifestReady, false);
assert.equal(legacy.bmeProtocolVersion, 0);

// Phase C: module readiness from /modules records sets bmeVectorApplyReady
// without needing features.bme.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: true,
      bmeVectorManifestReady: true,
      bmeVectorApplyReady: true,
      bmeCandidateSearchReady: true,
    },
  });
  assert.equal(state.modulesReady, true);
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorManifestReady, true);
  assert.equal(state.bmeVectorApplyReady, true);
  assert.equal(state.bmeCandidateSearchReady, true);
}

// Phase 3 frontend wiring: extraction.commitBatch readiness is module-manifest gated.
{
  const readiness = deriveModuleReadiness({
    modules: [{
      id: BME_AUTHORITY_MODULE_ID,
      transactions: {
        "graph.commitDelta": { name: "graph.commitDelta" },
        "extraction.commitBatch": { name: "extraction.commitBatch" },
      },
    }],
    records: [],
  });
  assert.equal(readiness.bmeExtractionCommitBatchReady, true);
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: readiness,
  });
  assert.equal(state.bmeExtractionCommitBatchReady, true);
}

// Phase C: load_error record does not set bmeVectorApplyReady.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // load_error
      bmeVectorManifestReady: false,
      bmeVectorApplyReady: false,
      bmeCandidateSearchReady: false,
    },
  });
  assert.equal(state.bmeModuleReady, false);
  assert.equal(state.bmeVectorApplyReady, false);
  assert.equal(state.bmeVectorManifestReady, false);
  assert.equal(state.bmeCandidateSearchReady, false);
}

// Phase C: missing transaction in manifest does not set readiness.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: true,
      bmeVectorManifestReady: false, // manifest missing vector.manifest
      bmeVectorApplyReady: true,
    },
  });
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorApplyReady, true);
  assert.equal(state.bmeVectorManifestReady, false);
}

// Phase C: deriveModuleReadiness from /modules payload.
{
  const readiness = deriveModuleReadiness({
    modules: [
      {
        id: BME_AUTHORITY_MODULE_ID,
        transactions: {
          "vector.manifest": { name: "vector.manifest" },
          "vector.apply": { name: "vector.apply" },
          "recall.candidates": { name: "recall.candidates" },
        },
      },
    ],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "loaded",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "vector.manifest": { name: "vector.manifest" },
            "vector.apply": { name: "vector.apply" },
            "recall.candidates": { name: "recall.candidates" },
          },
        },
      },
    ],
  });
  assert.equal(readiness.modulesReady, true);
  assert.equal(readiness.bmeModuleReady, true);
  assert.equal(readiness.bmeVectorManifestReady, true);
  assert.equal(readiness.bmeVectorApplyReady, true);
  assert.equal(readiness.bmeCandidateSearchReady, true, "deriveModuleReadiness must set bmeCandidateSearchReady when recall.candidates is declared and module is loaded");
}

// Phase C: deriveModuleReadiness with load_error record.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "load_error",
        manifest: null,
      },
    ],
  });
  assert.equal(readiness.modulesReady, true);
  assert.equal(readiness.bmeModuleReady, false);
  assert.equal(readiness.bmeVectorApplyReady, false);
}

// Phase C: deriveModuleReadiness with available (not loaded) record.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "available",
        manifest: { id: BME_AUTHORITY_MODULE_ID, transactions: { "vector.apply": { name: "vector.apply" } } },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, false); // available is not loaded
  assert.equal(readiness.bmeVectorApplyReady, false);
}

// Phase C: deriveModuleReadiness with no records at all.
{
  const readiness = deriveModuleReadiness({ modules: [], records: [] });
  assert.equal(readiness.modulesReady, false);
  assert.equal(readiness.bmeModuleReady, false);
  assert.equal(readiness.bmeCandidateSearchReady, false, "bmeCandidateSearchReady must be false when no records");
}

// Phase 3: deriveModuleReadiness missing recall.candidates transaction does NOT set bmeCandidateSearchReady.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "loaded",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "vector.manifest": { name: "vector.manifest" },
            "vector.apply": { name: "vector.apply" },
            // recall.candidates deliberately MISSING
          },
        },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, true, "module should be loaded");
  assert.equal(readiness.bmeVectorApplyReady, true, "vector.apply should be ready");
  assert.equal(readiness.bmeCandidateSearchReady, false, "bmeCandidateSearchReady must be false when recall.candidates transaction is missing");
}

// Phase 3: deriveModuleReadiness with load_error record does NOT set bmeCandidateSearchReady.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "load_error",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "recall.candidates": { name: "recall.candidates" },
          },
        },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, false, "load_error record does not mark module ready");
  assert.equal(readiness.bmeCandidateSearchReady, false, "bmeCandidateSearchReady must be false on load_error");
}

// Phase 3: module readiness takes priority over legacy features for bmeCandidateSearchReady.
// features.bme.candidateSearch is present but the module record is NOT loaded;
// the result should be false because module readiness takes priority.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["bme.candidate.search", "bme.vectormanifest", "sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // module not loaded
      bmeVectorManifestReady: false,
      bmeVectorApplyReady: false,
      bmeCandidateSearchReady: false,
    },
  });
  assert.equal(state.bmeCandidateSearchReady, false, "module readiness should take priority over legacy features for bmeCandidateSearchReady");
}

// Phase 3: legacy features set bmeCandidateSearchReady when module readiness is unavailable.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["bme.candidate.search", "sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    // No moduleReadiness: legacy features.bme.candidate.search should apply.
  });
  assert.equal(state.bmeCandidateSearchReady, true, "legacy features.bme.candidate.search should set bmeCandidateSearchReady when module readiness is unavailable");
}

// Phase 3: session init body includes recall.candidates in modules.execute declarations.
{
  let sessionInitBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/session/init")) {
      sessionInitBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-cap" }; },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { ok: true }; },
    };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl,
    allowRelativeUrl: true,
  });

  assert.ok(sessionInitBody, "session init body should have been sent");
  const perms = sessionInitBody.declaredPermissions;
  assert.ok(perms, "declaredPermissions must be present");
  assert.ok(perms.modules, "modules permission must be declared");
  assert.ok(Array.isArray(perms.modules.execute), "modules.execute must be an array");
  assert.ok(
    perms.modules.execute.includes("third-party.st-bme:recall.candidates"),
    "session init must declare recall.candidates execute",
  );
  // Sanity: state itself is normalized (not asserting probe details here).
  assert.ok(typeof state === "object");
}

// Phase C: module readiness takes priority over legacy features when present.
// When moduleReadiness is provided (modulesReady=true), legacy features.bme
// is NOT used for bmeVectorApplyReady. This test confirms a state where
// features.bme.vectorApply is true but the module record is NOT loaded;
// the result should be false because module readiness takes priority.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["bme.vector.apply", "bme.vectormanifest", "sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // module not loaded
      bmeVectorManifestReady: false,
      bmeVectorApplyReady: false,
    },
  });
  assert.equal(state.bmeVectorApplyReady, false, "module readiness should take priority over legacy features");
}

// Phase C blocker fix: probeAuthorityCapabilities calls /modules with the
// x-authority-session-token header obtained from session/init, and the
// module readiness from /modules takes priority over legacy features.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), headers: options.headers || {} });
    if (url.endsWith("/probe")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            healthy: true,
            features: {
              sql: { queryPage: true, stat: true },
              trivium: { bulkMutations: true, searchContext: true },
              jobs: { background: true, builtinTypes: ["delay"] },
              transfers: { blob: true, fs: true },
              modules: { enabled: true, count: 1 },
            },
            // Deliberately do NOT set features.bme.* so legacy readiness
            // would be false. Module readiness from /modules must set it.
          };
        },
      };
    }
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "probe-sess-token" }; },
      };
    }
    if (url.endsWith("/session/current")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { ok: true }; },
      };
    }
    if (url.endsWith("/permissions/evaluate-batch")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            results: [
              { decision: "granted" },
              { decision: "granted" },
              { decision: "granted" },
              { decision: "granted" },
            ],
          };
        },
      };
    }
    if (url.endsWith("/modules")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            modules: [],
            count: 0,
            records: [
              {
                moduleId: BME_AUTHORITY_MODULE_ID,
                status: "loaded",
                manifest: {
                  id: BME_AUTHORITY_MODULE_ID,
                  transactions: {
                    "vector.manifest": { name: "vector.manifest" },
                    "vector.apply": { name: "vector.apply" },
                    "recall.candidates": { name: "recall.candidates" },
                  },
                },
              },
            ],
            recordCount: 1,
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl: mockFetch,
    allowRelativeUrl: true,
  });

  // /modules must have been called.
  const modulesCall = fetchCalls.find((c) => c.url.endsWith("/modules"));
  assert.ok(modulesCall, "probe should have called /modules");

  // /modules must carry the session token header.
  assert.equal(
    modulesCall.headers["x-authority-session-token"],
    "probe-sess-token",
    "/modules must be called with x-authority-session-token from session/init",
  );

  // Module readiness should be derived from /modules, not legacy features.
  assert.equal(state.modulesReady, true);
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorManifestReady, true);
  assert.equal(state.bmeVectorApplyReady, true);
  assert.equal(state.bmeCandidateSearchReady, true, "state should derive bmeCandidateSearchReady from /modules when recall.candidates is declared");

  // The session token must NOT leak into the public capability state.
  const stateJson = JSON.stringify(state);
  assert.ok(!stateJson.includes("probe-sess-token"), "session token must not leak into public capability state");
}

// Phase C blocker fix: /modules failure is non-fatal; legacy features still apply.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/probe")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            healthy: true,
            features: {
              sql: { queryPage: true, stat: true },
              trivium: { bulkMutations: true, searchContext: true },
              jobs: { background: true, builtinTypes: ["delay"] },
              transfers: { blob: true, fs: true },
              modules: { enabled: true, count: 0 },
              bme: { protocolVersion: 1, vectorManifest: true, vectorApply: true },
            },
          };
        },
      };
    }
    if (url.endsWith("/session/init")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { sessionToken: "fail-sess" }; } };
    }
    if (url.endsWith("/session/current")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { ok: true }; } };
    }
    if (url.endsWith("/permissions/evaluate-batch")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { results: [{ decision: "granted" }, { decision: "granted" }, { decision: "granted" }, { decision: "granted" }] }; } };
    }
    if (url.endsWith("/modules")) {
      return { ok: false, status: 500, headers: { get: () => "application/json" }, async json() { return { error: "server error" }; } };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl: mockFetch,
    allowRelativeUrl: true,
  });

  // /modules failed, so module readiness is false, but legacy features
  // should still set bmeVectorApplyReady from features.bme.vectorApply.
  assert.equal(state.modulesReady, false);
  assert.equal(state.bmeModuleReady, false);
  // Legacy fallback: features.bme.vectorApply is present, so readiness
  // should be true via the legacy path.
  assert.equal(state.bmeVectorApplyReady, true);
}

// Phase F: the atomic graph path requires commit and conflict-recovery head reads.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "loaded",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "graph.commitDelta": { name: "graph.commitDelta" },
            "graph.getHead": { name: "graph.getHead" },
            "graph.loadSnapshot": { name: "graph.loadSnapshot" },
          },
        },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, true, "module should be loaded");
  assert.equal(readiness.bmeGraphCommitReady, true, "bmeGraphCommitReady requires commitDelta and getHead");
}

{
  const readiness = deriveModuleReadiness({
    modules: [{
      id: BME_AUTHORITY_MODULE_ID,
      transactions: {
        "graph.commitDelta": { name: "graph.commitDelta" },
        "graph.loadSnapshot": { name: "graph.loadSnapshot" },
      },
    }],
  });
  assert.equal(readiness.bmeGraphCommitReady, false, "getHead is required for conflict recovery");
}

{
  const readiness = deriveModuleReadiness({
    modules: [{
      id: BME_AUTHORITY_MODULE_ID,
      transactions: {
        "graph.commitDelta": { name: "graph.commitDelta" },
        "graph.getHead": { name: "graph.getHead" },
      },
    }],
  });
  assert.equal(readiness.bmeGraphCommitReady, true, "unused loadSnapshot must not block graph commits");
}

// Phase F: deriveModuleReadiness with load_error record does NOT set bmeGraphCommitReady.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "load_error",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "graph.commitDelta": { name: "graph.commitDelta" },
          },
        },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, false);
  assert.equal(readiness.bmeGraphCommitReady, false, "bmeGraphCommitReady must be false on load_error");
}

// Phase F: deriveModuleReadiness with module loaded but graph.commitDelta MISSING does NOT set bmeGraphCommitReady.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "loaded",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "vector.manifest": { name: "vector.manifest" },
            "vector.apply": { name: "vector.apply" },
            // graph.commitDelta deliberately MISSING
          },
        },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, true);
  assert.equal(readiness.bmeGraphCommitReady, false, "bmeGraphCommitReady must be false when graph.commitDelta transaction is missing");
}

// Phase F: normalizeAuthorityCapabilityState surfaces bmeGraphCommitReady from moduleReadiness.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: true,
      bmeGraphCommitReady: true,
    },
  });
  assert.equal(state.bmeGraphCommitReady, true, "state.bmeGraphCommitReady must reflect moduleReadiness.bmeGraphCommitReady");
}

// Phase F: normalizeAuthorityCapabilityState does not set bmeGraphCommitReady when module not loaded.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // not loaded
      bmeGraphCommitReady: false,
    },
  });
  assert.equal(state.bmeGraphCommitReady, false);
}

// Phase F: createDefaultAuthorityCapabilityState seeds bmeGraphCommitReady = false.
{
  const state = normalizeAuthorityCapabilityState({});
  assert.equal(state.bmeGraphCommitReady, false, "default state must seed bmeGraphCommitReady = false");
}

// Phase F: session init body includes the complete atomic graph transaction set.
{
  let sessionInitBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/session/init")) {
      sessionInitBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-cap-graph" }; },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { ok: true }; },
    };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl,
    allowRelativeUrl: true,
  });

  assert.ok(sessionInitBody, "session init body should have been sent");
  const perms = sessionInitBody.declaredPermissions;
  assert.ok(perms.modules.execute.includes("third-party.st-bme:graph.commitDelta"), "session init must declare graph.commitDelta execute");
  assert.ok(perms.modules.execute.includes("third-party.st-bme:graph.getHead"), "session init must declare graph.getHead execute");
  assert.ok(perms.modules.execute.includes("third-party.st-bme:graph.loadSnapshot"), "session init must declare graph.loadSnapshot execute");
  assert.ok(typeof state === "object");
}

console.log("authority-bme-capabilities tests passed");
