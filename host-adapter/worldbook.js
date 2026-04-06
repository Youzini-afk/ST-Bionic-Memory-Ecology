import { buildCapabilityStatus, mergeVersionHints } from "./capabilities.js";
import { createContextHostFacade } from "./context.js";
import { debugDebug } from "../debug-logging.js";

const WORLDBOOK_API_NAMES = [
  "getWorldbook",
  "getLorebookEntries",
  "getCharWorldbookNames",
];

function isObjectLike(value) {
  return (
    value != null && (typeof value === "object" || typeof value === "function")
  );
}

function bindHostFunction(container, name) {
  const fn = container?.[name];
  return typeof fn === "function" ? fn.bind(container) : null;
}

function buildApiMap(container = null) {
  return WORLDBOOK_API_NAMES.reduce((result, name) => {
    result[name] = bindHostFunction(container, name);
    return result;
  }, {});
}

function countResolvedApis(apiMap = {}) {
  return Object.values(apiMap).filter((api) => typeof api === "function")
    .length;
}

function resolveProviderCandidate(candidate, options = {}) {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === "function") {
    try {
      const resolved = candidate(options);
      return isObjectLike(resolved) ? resolved : null;
    } catch (error) {
      debugDebug("[ST-BME] host-adapter/worldbook provider 解析失败", error);
      return null;
    }
  }

  return isObjectLike(candidate) ? candidate : null;
}

function buildSourceRecord({
  label = "unknown",
  sourceKind = "unknown",
  container = null,
  fallback = false,
} = {}) {
  const apiMap = buildApiMap(container);

  return Object.freeze({
    label,
    sourceKind,
    fallback,
    apiMap,
    apiCount: countResolvedApis(apiMap),
  });
}

function collectExplicitWorldbookSourceRecords(options = {}) {
  const records = [];
  const providerCandidates = [
    ["worldbookProvider", options.worldbookProvider],
    ["providers.worldbook", options.providers?.worldbook],
    ["provider.worldbook", options.provider?.worldbook],
    ["host.worldbook", options.host?.worldbook],
    ["host.providers.worldbook", options.host?.providers?.worldbook],
  ];

  for (const [label, candidate] of providerCandidates) {
    const container = resolveProviderCandidate(candidate, options);
    if (!container) continue;

    records.push(
      buildSourceRecord({
        label,
        sourceKind: "provider",
        container,
      }),
    );
  }

  const apiCandidates = [
    ["worldbookApis", options.worldbookApis],
    ["apis", options.apis],
    ["host.apis", options.host?.apis],
    ["host", options.host],
  ];

  for (const [label, candidate] of apiCandidates) {
    if (!isObjectLike(candidate)) continue;

    records.push(
      buildSourceRecord({
        label,
        sourceKind: "api-map",
        container: candidate,
      }),
    );
  }

  return records;
}

function collectContextWorldbookSourceRecords(contextHost, options = {}) {
  const context = contextHost?.readContextSnapshot?.();
  if (!isObjectLike(context)) {
    return [];
  }

  const records = [];
  const contextCandidates = [
    ["context.worldbook", context.worldbook],
    ["context.worldInfo", context.worldInfo],
    ["context.host.worldbook", context.host?.worldbook],
    ["context.hostAdapter.worldbook", context.hostAdapter?.worldbook],
    ["context.providers.worldbook", context.providers?.worldbook],
    ["context.extensions.worldbook", context.extensions?.worldbook],
    ["context.TavernHelper", context.TavernHelper],
    ["context.sillyTavern.TavernHelper", context.sillyTavern?.TavernHelper],
    ["context", context],
  ];

  for (const [label, candidate] of contextCandidates) {
    const container = resolveProviderCandidate(candidate, {
      ...options,
      context,
      contextHost,
    });
    if (!container) continue;

    records.push(
      buildSourceRecord({
        label,
        sourceKind: "context",
        container,
      }),
    );
  }

  return records;
}

function collectGlobalFallbackRecords() {
  const records = [];
  const fallbackCandidates = [
    ["globalThis.TavernHelper", globalThis?.TavernHelper],
    [
      "globalThis.SillyTavern.TavernHelper",
      globalThis?.SillyTavern?.TavernHelper,
    ],
    ["globalThis", globalThis],
  ];

  for (const [label, candidate] of fallbackCandidates) {
    if (!isObjectLike(candidate)) continue;

    records.push(
      buildSourceRecord({
        label,
        sourceKind: "global-fallback",
        container: candidate,
        fallback: true,
      }),
    );
  }

  return records;
}

function resolveWorldbookSource(options = {}, contextHost = null) {
  const records = [
    ...collectExplicitWorldbookSourceRecords(options),
    ...collectContextWorldbookSourceRecords(contextHost, options),
    ...collectGlobalFallbackRecords(),
  ];

  return (
    records.find((record) => record.apiCount > 0) ||
    buildSourceRecord({
      label: "none",
      sourceKind: "unavailable",
      container: null,
    })
  );
}

function detectWorldbookMode(apiMap = {}) {
  const availableCount = countResolvedApis(apiMap);

  if (availableCount === 0) return "unavailable";
  if (availableCount === WORLDBOOK_API_NAMES.length) return "full";
  return "partial";
}

function buildFallbackReason(sourceRecord, available, mode) {
  if (!available) {
    return "未检测到世界书宿主接口";
  }

  if (sourceRecord?.fallback && mode === "partial") {
    return `当前通过 ${sourceRecord.label} fallback 提供部分世界书能力`;
  }

  if (sourceRecord?.fallback) {
    return `当前通过 ${sourceRecord.label} fallback 提供世界书能力`;
  }

  if (mode === "partial") {
    return `世界书桥接仅发现部分接口，来源: ${sourceRecord?.label || "unknown"}`;
  }

  return "";
}

export function createWorldbookHostFacade(options = {}) {
  const contextHost = options.contextHost || createContextHostFacade(options);
  const sourceRecord = resolveWorldbookSource(options, contextHost);
  const mode = detectWorldbookMode(sourceRecord.apiMap);
  const available = mode !== "unavailable";

  return Object.freeze({
    available,
    mode,
    fallbackReason: buildFallbackReason(sourceRecord, available, mode),
    versionHints: mergeVersionHints(
      {
        apiCount: String(sourceRecord.apiCount),
        apis: WORLDBOOK_API_NAMES.filter(
          (name) => typeof sourceRecord.apiMap[name] === "function",
        ),
        source: sourceRecord.sourceKind,
        sourceLabel: sourceRecord.label,
        fallback: sourceRecord.fallback ? "yes" : "no",
        contextMode: contextHost?.mode || "unknown",
      },
      options.versionHints,
    ),
    getWorldbook: sourceRecord.apiMap.getWorldbook,
    getLorebookEntries: sourceRecord.apiMap.getLorebookEntries,
    getCharWorldbookNames: sourceRecord.apiMap.getCharWorldbookNames,
    getApi(name) {
      return sourceRecord.apiMap[String(name || "")] || null;
    },
    readApiAvailability() {
      return Object.freeze(
        WORLDBOOK_API_NAMES.reduce((result, name) => {
          result[name] = typeof sourceRecord.apiMap[name] === "function";
          return result;
        }, {}),
      );
    },
    readCapabilitySupport() {
      return Object.freeze({
        available,
        mode,
        source: sourceRecord.sourceKind,
        sourceLabel: sourceRecord.label,
        fallback: sourceRecord.fallback,
      });
    },
  });
}

export function inspectWorldbookHostCapability(options = {}) {
  const facade = createWorldbookHostFacade(options);
  return buildCapabilityStatus(facade);
}
