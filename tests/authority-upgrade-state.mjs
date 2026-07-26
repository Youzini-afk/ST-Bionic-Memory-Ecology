import assert from "node:assert/strict";

import {
  createAuthorityUpgradeState,
  deriveAuthorityUpgradeState,
  formatAuthorityUpgradeMeta,
} from "../runtime/authority-upgrade-state.js";
import { createGraphPersistenceState } from "../ui/ui-status.js";
import { t, formatUiStatusText, formatUiStatusMeta } from "../i18n/index.js";

// ── Original tests (unchanged expectations) ──

const initial = createAuthorityUpgradeState();
assert.equal(initial.mode, "standalone");
assert.equal(initial.ready, false);

const graphState = createGraphPersistenceState();
assert.equal(graphState.authorityUpgradeMode, "standalone");
assert.equal(graphState.authorityUpgradeReady, false);
assert.equal(graphState.authorityUpgradeState.text, "纯前端模式");

const absent = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto" },
  capability: { installed: false, reason: "not-installed" },
  browserState: { mode: "minimal" },
});
assert.equal(absent.mode, "standalone");
assert.equal(absent.text, "纯前端模式");
assert.equal(absent.ready, false);

const degraded = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto" },
  capability: {
    installed: true,
    healthy: false,
    sessionReady: false,
    permissionReady: false,
    reason: "probe-failed",
  },
});
assert.equal(degraded.mode, "authority-degraded");
assert.equal(degraded.level, "warning");
assert.match(degraded.meta, /probe-failed/);

const enhanced = deriveAuthorityUpgradeState({
  settings: {
    authorityEnabled: "auto",
    authorityPrimaryWhenAvailable: true,
  },
  capability: {
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    serverPrimaryReady: true,
    storagePrimaryReady: true,
    triviumPrimaryReady: true,
    jobsReady: true,
    bmeVectorManifestReady: true,
    bmeProtocolVersion: 1,
  },
  browserState: { mode: "off" },
});
assert.equal(enhanced.mode, "authority-enhanced");
assert.equal(enhanced.ready, true);
assert.equal(enhanced.text, "服务端增强已启用");
assert.equal(enhanced.bmeVectorManifestReady, true);
assert.equal(enhanced.bmeProtocolVersion, 1);

assert.equal(
  formatAuthorityUpgradeMeta("准备就绪", enhanced),
  "准备就绪 · 服务端增强已启用",
);

// ── Phase 7: textKey / metaKey presence and defaults ──

// createAuthorityUpgradeState defaults
const defaults = createAuthorityUpgradeState();
assert.equal(defaults.textKey, "authority.mode.standalone", "default textKey");
assert.equal(defaults.metaKey, "authority.mode.standalone.meta", "default metaKey");
assert.deepEqual(defaults.textParams, {}, "default textParams is empty object");
assert.deepEqual(defaults.metaParams, {}, "default metaParams is empty object");

// deriveAuthorityUpgradeState: each branch has correct keys
const disabledState = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "off" },
  capability: {},
  browserState: { mode: "minimal" },
});
assert.equal(disabledState.textKey, "authority.mode.standalone");
assert.equal(disabledState.metaKey, "authority.mode.standalone.disabled.meta");

assert.equal(absent.textKey, "authority.mode.standalone");
assert.equal(absent.metaKey, "authority.mode.standalone.noAuthority.meta");

assert.equal(degraded.textKey, "authority.mode.degraded");
assert.equal(degraded.metaKey, "authority.mode.degraded.unhealthy.meta");
assert.equal(degraded.metaParams.reason, "probe-failed");

assert.equal(enhanced.textKey, "authority.mode.enhanced");
assert.equal(enhanced.metaKey, "authority.mode.enhanced.meta.manifestReady");

const shadow = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: false },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
  },
  browserState: { mode: "minimal" },
});
assert.equal(shadow.textKey, "authority.mode.shadow");
assert.equal(shadow.metaKey, "authority.mode.shadow.meta");

const candidateStorage = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: true },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
    storagePrimaryReady: true, triviumPrimaryReady: false,
  },
  browserState: { mode: "minimal" },
});
assert.equal(candidateStorage.textKey, "authority.mode.candidate");
assert.equal(candidateStorage.metaKey, "authority.mode.candidate.meta.storageReady");

const candidateVector = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: true },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
    storagePrimaryReady: false, triviumPrimaryReady: true,
  },
  browserState: { mode: "minimal" },
});
assert.equal(candidateVector.textKey, "authority.mode.candidate");
assert.equal(candidateVector.metaKey, "authority.mode.candidate.meta.vectorReady");

const degradedCapability = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: true },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
    reason: "time-out",
  },
  browserState: { mode: "minimal" },
});
assert.equal(degradedCapability.textKey, "authority.mode.degraded");
assert.equal(degradedCapability.metaKey, "authority.mode.degraded.capabilityNotReady.meta");
assert.equal(degradedCapability.metaParams.reason, "time-out");

// Enhanced with no jobs
const enhancedNoJobs = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: true },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
    storagePrimaryReady: true, triviumPrimaryReady: true, jobsReady: false,
  },
  browserState: { mode: "minimal" },
});
assert.equal(enhancedNoJobs.textKey, "authority.mode.enhanced");
assert.equal(enhancedNoJobs.metaKey, "authority.mode.enhanced.meta.noJobs");

// Enhanced with jobs but no manifest
const enhancedNoManifest = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto", authorityPrimaryWhenAvailable: true },
  capability: {
    installed: true, healthy: true, sessionReady: true, permissionReady: true,
    storagePrimaryReady: true, triviumPrimaryReady: true,
    jobsReady: true, bmeVectorManifestReady: false,
  },
  browserState: { mode: "minimal" },
});
assert.equal(enhancedNoManifest.textKey, "authority.mode.enhanced");
assert.equal(enhancedNoManifest.metaKey, "authority.mode.enhanced.meta.noManifest");

// ── Phase 7: formatUiStatusText / formatUiStatusMeta with i18n ──

// When textKey resolves to a catalog entry, t() should produce the localized string
const standaloneText = formatUiStatusText(disabledState);
assert.ok(typeof standaloneText === "string", "formatUiStatusText returns string");
assert.ok(standaloneText.length > 0, "formatUiStatusText is non-empty");

const standaloneMeta = formatUiStatusMeta(disabledState);
assert.ok(typeof standaloneMeta === "string", "formatUiStatusMeta returns string");
assert.ok(standaloneMeta.length > 0, "formatUiStatusMeta is non-empty");

// Verify that zh-CN (default locale) catalog keys match the Chinese fallbacks
assert.equal(t("authority.mode.standalone"), "纯前端模式");
assert.equal(t("authority.mode.shadow"), "服务端影子同步");
assert.equal(t("authority.mode.enhanced"), "服务端增强已启用");
assert.equal(t("authority.mode.candidate"), "服务端增强准备中");
assert.equal(t("authority.mode.degraded"), "已自动回退");

// Verify meta keys resolve
assert.equal(
  t("authority.mode.enhanced.meta.manifestReady"),
  "图谱与向量存储已增强，服务端向量清单可用",
);
assert.equal(
  t("authority.mode.candidate.meta.storageReady"),
  "图谱服务端存储可用，向量增强仍在等待能力确认",
);

// Verify degraded meta with params
assert.equal(
  t("authority.mode.degraded.unhealthy.meta", { reason: "probe-failed" }),
  "服务端增强暂不可用：probe-failed",
);

// Verify formatUiStatusText falls back to .text when no textKey
const noKeyState = { text: "fallback", meta: "metaFallback" };
assert.equal(formatUiStatusText(noKeyState), "fallback");
assert.equal(formatUiStatusMeta(noKeyState), "metaFallback");

// Verify string passthrough
assert.equal(formatUiStatusText("just a string"), "just a string");
assert.equal(formatUiStatusMeta("just a meta string"), "just a meta string");

console.log("authority-upgrade-state tests passed");