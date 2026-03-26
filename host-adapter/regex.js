import { buildCapabilityStatus, mergeVersionHints } from "./capabilities.js";
import { createContextHostFacade } from "./context.js";

const REGEX_API_NAMES = ["getTavernRegexes", "isCharacterTavernRegexesEnabled"];

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
  return REGEX_API_NAMES.reduce((result, name) => {
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
      console.debug("[ST-BME] host-adapter/regex provider 解析失败", error);
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

function collectExplicitRegexSourceRecords(options = {}) {
  const records = [];
  const providerCandidates = [
    ["regexProvider", options.regexProvider],
    ["providers.regex", options.providers?.regex],
    ["provider.regex", options.provider?.regex],
    ["host.regex", options.host?.regex],
    ["host.providers.regex", options.host?.providers?.regex],
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
    ["regexApis", options.regexApis],
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

function collectContextRegexSourceRecords(contextHost, options = {}) {
  const context = contextHost?.readContextSnapshot?.();
  if (!isObjectLike(context)) {
    return [];
  }

  const records = [];
  const contextCandidates = [
    ["context.regex", context.regex],
    ["context.tavernRegex", context.tavernRegex],
    ["context.host.regex", context.host?.regex],
    ["context.hostAdapter.regex", context.hostAdapter?.regex],
    ["context.providers.regex", context.providers?.regex],
    ["context.extensions.regex", context.extensions?.regex],
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

function resolveRegexSource(options = {}, contextHost = null) {
  const records = [
    ...collectExplicitRegexSourceRecords(options),
    ...collectContextRegexSourceRecords(contextHost, options),
    ...collectGlobalFallbackRecords(),
  ];

  return (
    records.find(
      (record) => typeof record.apiMap.getTavernRegexes === "function",
    ) ||
    buildSourceRecord({
      label: "none",
      sourceKind: "unavailable",
      container: null,
    })
  );
}

function detectRegexMode(apiMap = {}) {
  if (typeof apiMap.getTavernRegexes !== "function") {
    return "unavailable";
  }

  return typeof apiMap.isCharacterTavernRegexesEnabled === "function"
    ? "full"
    : "partial";
}

function buildFallbackReason(sourceRecord, available, mode) {
  if (!available) {
    return "未检测到 Tavern Regex 宿主接口";
  }

  if (sourceRecord?.fallback && mode === "partial") {
    return `当前通过 ${sourceRecord.label} fallback 提供部分 Tavern Regex 能力`;
  }

  if (sourceRecord?.fallback) {
    return `当前通过 ${sourceRecord.label} fallback 提供 Tavern Regex 能力`;
  }

  if (mode === "partial") {
    return `Tavern Regex 桥接仅发现部分接口，来源: ${sourceRecord?.label || "unknown"}`;
  }

  return "";
}

export function createRegexHostFacade(options = {}) {
  const contextHost = options.contextHost || createContextHostFacade(options);
  const sourceRecord = resolveRegexSource(options, contextHost);
  const mode = detectRegexMode(sourceRecord.apiMap);
  const available = mode !== "unavailable";

  return Object.freeze({
    available,
    mode,
    fallbackReason: buildFallbackReason(sourceRecord, available, mode),
    versionHints: mergeVersionHints(
      {
        apis: REGEX_API_NAMES.filter(
          (name) => typeof sourceRecord.apiMap[name] === "function",
        ),
        apiCount: String(sourceRecord.apiCount),
        supportsCharacterToggle:
          typeof sourceRecord.apiMap.isCharacterTavernRegexesEnabled ===
          "function"
            ? "yes"
            : "no",
        source: sourceRecord.sourceKind,
        sourceLabel: sourceRecord.label,
        fallback: sourceRecord.fallback ? "yes" : "no",
        contextMode: contextHost?.mode || "unknown",
      },
      options.versionHints,
    ),
    getTavernRegexes: sourceRecord.apiMap.getTavernRegexes,
    isCharacterTavernRegexesEnabled:
      sourceRecord.apiMap.isCharacterTavernRegexesEnabled,
    getApi(name) {
      return sourceRecord.apiMap[String(name || "")] || null;
    },
    readApiAvailability() {
      return Object.freeze(
        REGEX_API_NAMES.reduce((result, name) => {
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

export function inspectRegexHostCapability(options = {}) {
  const facade = createRegexHostFacade(options);
  return buildCapabilityStatus(facade);
}
