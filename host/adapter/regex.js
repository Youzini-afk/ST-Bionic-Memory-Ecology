import {
  getRegexedString as coreGetRegexedString,
  regex_placement as coreRegexPlacement,
} from "../../../../regex/engine.js";
import { buildCapabilityStatus, mergeVersionHints } from "./capabilities.js";
import { createContextHostFacade } from "./context.js";
import { debugDebug } from "../../runtime/debug-logging.js";

const REGEX_API_NAMES = [
  "getTavernRegexes",
  "isCharacterTavernRegexesEnabled",
  "formatAsTavernRegexedString",
];
const CORE_REGEX_SOURCE_TO_PLACEMENT_KEY = Object.freeze({
  user_input: "USER_INPUT",
  ai_output: "AI_OUTPUT",
  slash_command: "SLASH_COMMAND",
  world_info: "WORLD_INFO",
  reasoning: "REASONING",
});
const REGEX_SOURCE_KIND_PRIORITY = Object.freeze({
  unknown: 0,
  unavailable: 0,
  "global-fallback": 1,
  context: 2,
  "core-bridge": 3,
  "api-map": 4,
  provider: 5,
});
const REGEX_BRIDGE_TIER_PRIORITY = Object.freeze({
  unavailable: 0,
  "helper-getter-only": 1,
  "helper-bridge": 2,
  "core-real": 3,
});

function isObjectLike(value) {
  return (
    value != null && (typeof value === "object" || typeof value === "function")
  );
}

function bindHostFunction(container, name) {
  const fn = container?.[name];
  return typeof fn === "function" ? fn.bind(container) : null;
}

function resolveCorePlacement(regexPlacement, source) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  const placementKey = CORE_REGEX_SOURCE_TO_PLACEMENT_KEY[normalizedSource];
  if (!placementKey || !isObjectLike(regexPlacement)) {
    return null;
  }
  const placement = regexPlacement?.[placementKey];
  return Number.isFinite(Number(placement)) ? Number(placement) : null;
}

function hasCoreRegexApi(container) {
  return (
    typeof container?.getRegexedString === "function" &&
    resolveCorePlacement(container?.regex_placement, "user_input") != null
  );
}

function normalizeCoreFormatterOptions(destination, options = {}) {
  const normalizedDestination =
    typeof destination === "string" ? String(destination || "").trim() : "";
  const normalizedOptions =
    destination &&
    typeof destination === "object" &&
    !Array.isArray(destination)
      ? { ...destination }
      : options && typeof options === "object" && !Array.isArray(options)
        ? { ...options }
        : {};

  if (normalizedDestination === "display" && normalizedOptions.isMarkdown == null) {
    normalizedOptions.isMarkdown = true;
  }
  if (normalizedDestination === "prompt" && normalizedOptions.isPrompt == null) {
    normalizedOptions.isPrompt = true;
  }
  if (
    normalizedOptions.character_name != null &&
    normalizedOptions.characterOverride == null
  ) {
    normalizedOptions.characterOverride = normalizedOptions.character_name;
  }
  delete normalizedOptions.character_name;
  return normalizedOptions;
}

function createCoreFormatterBridge(container) {
  if (!hasCoreRegexApi(container)) {
    return null;
  }
  const getRegexedString = bindHostFunction(container, "getRegexedString");
  const regexPlacement = container?.regex_placement;
  if (typeof getRegexedString !== "function") {
    return null;
  }

  return function formatAsTavernRegexedString(
    text,
    source,
    destination,
    options = {}
  ) {
    const placement = resolveCorePlacement(regexPlacement, source);
    if (placement == null) {
      return String(text ?? "");
    }
    return getRegexedString(
      String(text ?? ""),
      placement,
      normalizeCoreFormatterOptions(destination, options)
    );
  };
}

function buildApiMap(container = null) {
  const apiMap = REGEX_API_NAMES.reduce((result, name) => {
    result[name] = bindHostFunction(container, name);
    return result;
  }, {});

  if (typeof apiMap.formatAsTavernRegexedString !== "function") {
    apiMap.formatAsTavernRegexedString = createCoreFormatterBridge(container);
  }

  return apiMap;
}

function countResolvedApis(apiMap = {}) {
  return Object.values(apiMap).filter((api) => typeof api === "function")
    .length;
}

function detectBridgeTier({ hasCoreApi = false, apiMap = {} } = {}) {
  const hasGetter = typeof apiMap.getTavernRegexes === "function";
  const hasFormatter =
    typeof apiMap.formatAsTavernRegexedString === "function";

  if (hasCoreApi && hasFormatter) {
    return "core-real";
  }
  if (hasFormatter) {
    return "helper-bridge";
  }
  if (hasGetter) {
    return "helper-getter-only";
  }
  return "unavailable";
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
      debugDebug("[ST-BME] host-adapter/regex provider 解析失败", error);
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
  const hasCoreApi = hasCoreRegexApi(container);
  const bridgeTier = detectBridgeTier({ hasCoreApi, apiMap });

  return Object.freeze({
    label,
    sourceKind,
    fallback,
    apiMap,
    apiCount: countResolvedApis(apiMap),
    hasCoreApi,
    bridgeTier,
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

function collectCoreBridgeSourceRecords(options = {}) {
  if (options?.disableCoreRegexBridge === true) {
    return [];
  }
  const coreBridge = {
    getRegexedString: coreGetRegexedString,
    regex_placement: coreRegexPlacement,
  };
  if (!hasCoreRegexApi(coreBridge)) {
    return [];
  }

  return [
    buildSourceRecord({
      label: "sillytavern.core.regex",
      sourceKind: "core-bridge",
      container: coreBridge,
    }),
  ];
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

function scoreSourceRecord(record = {}) {
  const sourceScore =
    REGEX_SOURCE_KIND_PRIORITY[String(record?.sourceKind || "unknown")] || 0;
  const tierScore =
    REGEX_BRIDGE_TIER_PRIORITY[String(record?.bridgeTier || "unavailable")] || 0;
  if (tierScore <= 0) {
    return 0;
  }
  return sourceScore * 100 + tierScore * 10 + Number(record?.apiCount || 0);
}

function selectBestRegexSource(records = []) {
  let bestRecord = null;
  let bestScore = -1;

  for (const record of Array.isArray(records) ? records : []) {
    const score = scoreSourceRecord(record);
    if (!bestRecord || score > bestScore) {
      bestRecord = record;
      bestScore = score;
    }
  }

  return (
    bestRecord ||
    buildSourceRecord({
      label: "none",
      sourceKind: "unavailable",
      container: null,
    })
  );
}

function resolveRegexSource(options = {}, contextHost = null) {
  const records = [
    ...collectExplicitRegexSourceRecords(options),
    ...collectCoreBridgeSourceRecords(options),
    ...collectContextRegexSourceRecords(contextHost, options),
    ...collectGlobalFallbackRecords(),
  ];

  return selectBestRegexSource(records);
}

function detectRegexMode(sourceRecord = {}) {
  return String(sourceRecord?.bridgeTier || "").trim() || "unavailable";
}

function buildFallbackReason(sourceRecord, available, mode) {
  if (!available) {
    return "未检测到 Tavern Regex 宿主接口";
  }

  if (mode === "core-real") {
    return "";
  }

  if (mode === "helper-bridge") {
    return `当前通过 ${sourceRecord?.label || "unknown"} helper bridge 提供 Tavern Regex formatter`;
  }

  if (mode === "helper-getter-only") {
    return `Tavern Regex 桥接仅发现规则读取接口，来源: ${sourceRecord?.label || "unknown"}`;
  }

  return "";
}

export function createRegexHostFacade(options = {}) {
  const contextHost = options.contextHost || createContextHostFacade(options);
  const sourceRecord = resolveRegexSource(options, contextHost);
  const mode = detectRegexMode(sourceRecord);
  const available = mode !== "unavailable";
  const formatterAvailable =
    typeof sourceRecord.apiMap.formatAsTavernRegexedString === "function";
  const rulesAvailable =
    typeof sourceRecord.apiMap.getTavernRegexes === "function";
  const fallbackReason = buildFallbackReason(sourceRecord, available, mode);
  const versionHints = mergeVersionHints(
    {
      apis: REGEX_API_NAMES.filter(
        (name) => typeof sourceRecord.apiMap[name] === "function",
      ),
      apiCount: String(sourceRecord.apiCount),
      supportsCharacterToggle:
        typeof sourceRecord.apiMap.isCharacterTavernRegexesEnabled === "function"
          ? "yes"
          : "no",
      source: sourceRecord.sourceKind,
      sourceLabel: sourceRecord.label,
      fallback: sourceRecord.fallback ? "yes" : "no",
      contextMode: contextHost?.mode || "unknown",
      bridgeTier: sourceRecord.bridgeTier,
      hasCoreApi: sourceRecord.hasCoreApi ? "yes" : "no",
    },
    options.versionHints,
  );
  const capabilityStatus = buildCapabilityStatus({
    available,
    mode,
    fallbackReason,
    versionHints,
  });

  return Object.freeze({
    available,
    mode,
    fallbackReason,
    versionHints,
    capabilityStatus,
    getTavernRegexes: sourceRecord.apiMap.getTavernRegexes,
    isCharacterTavernRegexesEnabled:
      sourceRecord.apiMap.isCharacterTavernRegexesEnabled,
    formatAsTavernRegexedString:
      sourceRecord.apiMap.formatAsTavernRegexedString,
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
        formatterAvailable,
        rulesAvailable,
        bridgeTier: sourceRecord.bridgeTier,
        hasCoreApi: sourceRecord.hasCoreApi,
      });
    },
  });
}

export function inspectRegexHostCapability(options = {}) {
  const facade = createRegexHostFacade(options);
  return buildCapabilityStatus(facade);
}
