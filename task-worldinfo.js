// ST-BME: 任务级世界书激活引擎
// 对标 SillyTavern 原生世界书扫描逻辑，并在私有 prompt 组装阶段
// 提供最小 EJS 配合能力，用于 getwi / activewi。

import {
  createTaskEjsRenderContext,
  evalTaskEjsTemplate,
  inspectTaskEjsRuntimeBackend,
  substituteTaskEjsParams,
} from "./task-ejs.js";
import {
  getLatestMessageVarTable,
  prepareStNativeEjsEnv,
  renderTemplateWithStSupport,
} from "./st-native-render.js";
import {
  isLikelyMvuWorldInfoContent,
  isMvuTaggedWorldInfoNameOrComment,
  sanitizeMvuContent,
} from "./mvu-compat.js";
import { debugDebug } from "./debug-logging.js";

const WI_POSITION = {
  before: 0,
  after: 1,
  EMTop: 2,
  EMBottom: 3,
  ANTop: 4,
  ANBottom: 5,
  atDepth: 6,
};

const WI_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
};

const DEPTH_MAPPING = {
  [WI_POSITION.before]: 4,
  [WI_POSITION.after]: 3,
  [WI_POSITION.EMTop]: 2,
  [WI_POSITION.EMBottom]: 1,
  [WI_POSITION.ANTop]: 1,
  [WI_POSITION.ANBottom]: -1,
};

const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_RESOLVE_PASSES = 10;
const WORLDINFO_CACHE_TTL_MS = 3000;
const KNOWN_DECORATORS = ["@@activate", "@@dont_activate"];

let worldbookEntriesCache = {
  key: "",
  createdAt: 0,
  expiresAt: 0,
  entries: [],
  blockedContents: [],
  ignoredEntries: [],
  ignoredLookup: new Map(),
  debug: null,
};

function buildIgnoredEntryLookupKey(worldbookName, identifier) {
  return `${normalizeKey(worldbookName)}::${normalizeKey(identifier)}`;
}

function createMvuCollector() {
  return {
    blockedContents: [],
    filteredEntries: [],
    lazyFilteredEntries: [],
    ignoredLookup: new Map(),
    seenEntries: new Set(),
  };
}

function createCustomFilterCollector() {
  return {
    filteredEntries: [],
    lazyFilteredEntries: [],
    seenEntries: new Set(),
  };
}

function safeCloneValue(value, fallback = {}) {
  if (value == null) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
    // ignore and fall back to JSON clone
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function bridgeCustomTaskEjsStatData(renderCtx, latestMessageVars) {
  if (!renderCtx || !latestMessageVars || typeof latestMessageVars !== "object") {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(latestMessageVars, "stat_data")) {
    return false;
  }

  const statData = safeCloneValue(latestMessageVars.stat_data, {});
  const messageVars = safeCloneValue(latestMessageVars, {});
  const previousState = renderCtx.variableState || {};

  renderCtx.variableState = {
    globalVars: {
      ...(previousState.globalVars || {}),
      stat_data: statData,
    },
    localVars: {
      ...(previousState.localVars || {}),
      stat_data: statData,
    },
    messageVars: {
      ...(previousState.messageVars || {}),
      ...messageVars,
    },
    cacheVars: {
      ...(previousState.cacheVars || {}),
      ...messageVars,
      stat_data: statData,
    },
  };

  renderCtx.templateContext = {
    ...(renderCtx.templateContext || {}),
    stat_data: statData,
  };

  return true;
}

function registerIgnoredEntryLookup(collector, worldbookName, identifier, meta) {
  const normalizedIdentifier = normalizeKey(identifier);
  if (!collector || !normalizedIdentifier) return;
  collector.ignoredLookup.set(
    buildIgnoredEntryLookupKey(worldbookName, normalizedIdentifier),
    meta,
  );
}

function registerCustomFilteredEntry(
  collector,
  entry = {},
  matchedKeyword = "",
  { lazy = false } = {},
) {
  if (!collector || !entry) return;

  const worldbook = normalizeKey(entry.worldbook);
  const name = normalizeKey(entry.name);
  const identity = `${worldbook}:${entry.uid || 0}:${name}:${String(matchedKeyword || "")}`;
  if (collector.seenEntries.has(identity)) {
    return;
  }
  collector.seenEntries.add(identity);

  const meta = {
    worldbook,
    name,
    matchedKeyword: String(matchedKeyword || ""),
    reason: "custom_keyword",
  };

  if (lazy) {
    collector.lazyFilteredEntries.push(meta);
  } else {
    collector.filteredEntries.push(meta);
  }
}

function registerIgnoredWorldInfoEntry(
  collector,
  entry = {},
  reason = "",
  { lazy = false } = {},
) {
  if (!collector || !entry) return;

  const worldbook = normalizeKey(entry.worldbook);
  const name = normalizeKey(entry.name);
  const comment = normalizeKey(entry.comment);
  const content = String(entry.cleanContent || entry.content || "").trim();
  const identity = `${worldbook}:${entry.uid || 0}:${name}:${reason}`;
  const meta = {
    worldbook,
    name: comment || name,
    sourceName: name,
    reason: String(reason || ""),
  };

  registerIgnoredEntryLookup(collector, worldbook, name, meta);
  registerIgnoredEntryLookup(collector, worldbook, comment, meta);

  if (collector.seenEntries.has(identity)) {
    return;
  }
  collector.seenEntries.add(identity);

  if (content) {
    collector.blockedContents.push(content);
  }

  if (lazy) {
    collector.lazyFilteredEntries.push(meta);
  } else {
    collector.filteredEntries.push(meta);
  }
}

function findIgnoredWorldInfoEntry(collector, worldbookName, identifier) {
  if (!collector || !normalizeKey(identifier)) {
    return null;
  }

  const normalizedWorldbook = normalizeKey(worldbookName);
  const normalizedIdentifier = normalizeKey(identifier);
  const exact = collector.ignoredLookup.get(
    buildIgnoredEntryLookupKey(normalizedWorldbook, normalizedIdentifier),
  );
  if (exact) {
    return exact;
  }

  if (normalizedWorldbook) {
    return null;
  }

  for (const [lookupKey, value] of collector.ignoredLookup.entries()) {
    if (lookupKey.endsWith(`::${normalizedIdentifier}`)) {
      return value;
    }
  }

  return null;
}

function getMvuIgnoreReason(entry = {}) {
  if (isMvuTaggedWorldInfoNameOrComment(entry.name, entry.comment)) {
    return "mvu_tagged";
  }
  if (isLikelyMvuWorldInfoContent(entry.cleanContent || entry.content)) {
    return "mvu_content";
  }
  return "";
}

function buildMvuDebugSummary(collector) {
  const filteredEntries = Array.isArray(collector?.filteredEntries)
    ? collector.filteredEntries
    : [];
  const lazyFilteredEntries = Array.isArray(collector?.lazyFilteredEntries)
    ? collector.lazyFilteredEntries
    : [];
  const blockedContents = Array.isArray(collector?.blockedContents)
    ? collector.blockedContents
    : [];

  return {
    filteredEntryCount: filteredEntries.length,
    filteredEntries: [...filteredEntries, ...lazyFilteredEntries],
    blockedContentsCount: uniq(blockedContents.map((item) => String(item || "").trim()).filter(Boolean)).length,
    lazyFilteredEntryCount: lazyFilteredEntries.length,
  };
}

function buildCustomFilterDebugSummary(
  collector,
  { filterMode = "default", customFilterKeywords = [] } = {},
) {
  const filteredEntries = Array.isArray(collector?.filteredEntries)
    ? collector.filteredEntries
    : [];
  const lazyFilteredEntries = Array.isArray(collector?.lazyFilteredEntries)
    ? collector.lazyFilteredEntries
    : [];

  return {
    mode: String(filterMode || "default"),
    keywords: [...(Array.isArray(customFilterKeywords) ? customFilterKeywords : [])],
    filteredEntryCount: filteredEntries.length + lazyFilteredEntries.length,
    filteredEntries: [...filteredEntries, ...lazyFilteredEntries],
    lazyFilteredEntryCount: lazyFilteredEntries.length,
  };
}

function getStContext() {
  try {
    return globalThis.SillyTavern?.getContext?.() || {};
  } catch {
    return {};
  }
}

function getLegacyWorldbookApi(name) {
  const fn = globalThis[name];
  return typeof fn === "function" ? fn : null;
}

async function getWorldbookHost() {
  const legacyGetWorldbook = getLegacyWorldbookApi("getWorldbook");
  const legacyGetLorebookEntries = getLegacyWorldbookApi("getLorebookEntries");
  const legacyGetCharWorldbookNames = getLegacyWorldbookApi(
    "getCharWorldbookNames",
  );

  try {
    const { getHostAdapter } = await import("./host-adapter/index.js");
    const adapter = getHostAdapter?.() || null;
    const adapterSnapshot = adapter?.getSnapshot?.() || null;
    const worldbookHost = adapter?.worldbook || null;
    if (typeof worldbookHost?.getWorldbook === "function") {
      const capabilitySupport = worldbookHost.readCapabilitySupport?.() || {};
      const bridgeGetLorebookEntries =
        typeof worldbookHost.getLorebookEntries === "function"
          ? worldbookHost.getLorebookEntries
          : null;
      const bridgeGetCharWorldbookNames =
        typeof worldbookHost.getCharWorldbookNames === "function"
          ? worldbookHost.getCharWorldbookNames
          : null;
      const supplementedCapabilities = [];
      const missingCapabilities = [];

      const resolvedGetLorebookEntries =
        bridgeGetLorebookEntries || legacyGetLorebookEntries;
      if (!bridgeGetLorebookEntries) {
        if (resolvedGetLorebookEntries) {
          supplementedCapabilities.push("getLorebookEntries");
        } else {
          missingCapabilities.push("getLorebookEntries");
        }
      }

      const resolvedGetCharWorldbookNames =
        bridgeGetCharWorldbookNames || legacyGetCharWorldbookNames;
      if (!bridgeGetCharWorldbookNames) {
        if (resolvedGetCharWorldbookNames) {
          supplementedCapabilities.push("getCharWorldbookNames");
        } else {
          missingCapabilities.push("getCharWorldbookNames");
        }
      }

      return {
        getWorldbook: worldbookHost.getWorldbook,
        getLorebookEntries: resolvedGetLorebookEntries,
        getCharWorldbookNames: resolvedGetCharWorldbookNames,
        sourceLabel: capabilitySupport.sourceLabel || "host-adapter.worldbook",
        fallback:
          Boolean(capabilitySupport.fallback) ||
          supplementedCapabilities.length > 0,
        capabilityStatus: Object.freeze({
          mode: capabilitySupport.mode || "unknown",
          supplementedCapabilities: Object.freeze(supplementedCapabilities),
          missingCapabilities: Object.freeze(missingCapabilities),
        }),
        snapshotRevision: Number(adapterSnapshot?.snapshotRevision || 0),
      };
    }
  } catch (error) {
    debugDebug(
      "[ST-BME] task-worldinfo 读取 worldbook bridge 失败，回退到 legacy 宿主接口",
      error,
    );
  }

  const missingCapabilities = [];
  if (typeof legacyGetLorebookEntries !== "function") {
    missingCapabilities.push("getLorebookEntries");
  }
  if (typeof legacyGetCharWorldbookNames !== "function") {
    missingCapabilities.push("getCharWorldbookNames");
  }

  return {
    getWorldbook: legacyGetWorldbook,
    getLorebookEntries: legacyGetLorebookEntries,
    getCharWorldbookNames: legacyGetCharWorldbookNames,
    sourceLabel: "legacy.globalThis",
    fallback: true,
    capabilityStatus: Object.freeze({
      mode: "legacy",
      supplementedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze(missingCapabilities),
    }),
    snapshotRevision: 0,
  };
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniq(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function groupBy(items = [], getKey) {
  const grouped = {};
  for (const item of items) {
    const key = String(getKey(item) ?? "");
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(item);
  }
  return grouped;
}

function sum(values = []) {
  return (Array.isArray(values) ? values : []).reduce(
    (total, value) => total + (Number(value) || 0),
    0,
  );
}

function simpleHash(input = "") {
  let hash = 2166136261;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parseDecorators(content = "") {
  const rawContent = String(content || "");
  if (!rawContent.startsWith("@@")) {
    return {
      decorators: [],
      cleanContent: rawContent,
    };
  }

  const lines = rawContent.split("\n");
  const decorators = [];
  let index = 0;

  while (index < lines.length) {
    const line = String(lines[index] || "");
    if (!line.startsWith("@@")) {
      break;
    }
    if (line.startsWith("@@@")) {
      break;
    }
    const matched = KNOWN_DECORATORS.find((decorator) =>
      line.startsWith(decorator),
    );
    if (!matched) {
      break;
    }
    decorators.push(line);
    index += 1;
  }

  return {
    decorators,
    cleanContent: index > 0 ? lines.slice(index).join("\n") : rawContent,
  };
}

function normalizeEntry(raw = {}, worldbookName = "") {
  const { decorators, cleanContent } = parseDecorators(raw.content || "");

  const positionType = raw.position?.type ?? "at_depth";
  let position = WI_POSITION.atDepth;
  let role = raw.position?.role ?? "system";

  if (
    positionType === "before_char" ||
    positionType === "before" ||
    positionType === "before_character_definition"
  ) {
    position = WI_POSITION.before;
  } else if (
    positionType === "after_char" ||
    positionType === "after" ||
    positionType === "after_character_definition"
  ) {
    position = WI_POSITION.after;
  } else if (
    positionType === "em_top" ||
    positionType === "before_example_messages"
  ) {
    position = WI_POSITION.EMTop;
  } else if (
    positionType === "em_bottom" ||
    positionType === "after_example_messages"
  ) {
    position = WI_POSITION.EMBottom;
  } else if (
    positionType === "an_top" ||
    positionType === "before_author_note"
  ) {
    position = WI_POSITION.ANTop;
  } else if (
    positionType === "an_bottom" ||
    positionType === "after_author_note"
  ) {
    position = WI_POSITION.ANBottom;
  } else if (positionType === "at_depth_as_assistant") {
    position = WI_POSITION.atDepth;
    role = "assistant";
  } else if (positionType === "at_depth_as_user") {
    position = WI_POSITION.atDepth;
    role = "user";
  } else if (typeof raw.extensions?.position === "number") {
    position = raw.extensions.position;
  }

  let enabled;
  if (typeof raw.disable === "boolean") {
    enabled = !raw.disable;
  } else if (typeof raw.enabled === "boolean") {
    enabled = raw.enabled;
  } else {
    enabled = true;
  }

  let selectiveLogic = WI_LOGIC.AND_ANY;
  const logic = raw.strategy?.keys_secondary?.logic;
  if (logic === "not_all") selectiveLogic = WI_LOGIC.NOT_ALL;
  if (logic === "not_any") selectiveLogic = WI_LOGIC.NOT_ANY;
  if (logic === "and_all") selectiveLogic = WI_LOGIC.AND_ALL;

  return {
    uid: Number(raw.uid) || 0,
    name: normalizeKey(raw.name),
    comment: normalizeKey(raw.comment),
    content: String(raw.content || ""),
    cleanContent,
    decorators,
    enabled,
    worldbook: normalizeKey(worldbookName),
    constant: raw.strategy?.type === "constant",
    selective: raw.strategy?.type === "selective",
    keys: Array.isArray(raw.strategy?.keys) ? raw.strategy.keys : [],
    keysSecondary: Array.isArray(raw.strategy?.keys_secondary?.keys)
      ? raw.strategy.keys_secondary.keys
      : [],
    selectiveLogic,
    useProbability:
      (raw.extensions?.useProbability === true ||
        raw.probability !== undefined) &&
      Number(raw.probability ?? 100) < 100,
    probability: Number(raw.probability ?? 100),
    caseSensitive: Boolean(raw.extra?.caseSensitive),
    matchWholeWords: Boolean(raw.extra?.matchWholeWords),
    group: normalizeKey(raw.extra?.group),
    groupOverride: Boolean(raw.extra?.groupOverride),
    groupWeight: Number(raw.extra?.groupWeight ?? 100),
    useGroupScoring: Boolean(raw.extra?.useGroupScoring),
    position,
    depth: Number(raw.position?.depth ?? 0),
    order: Number(raw.position?.order ?? 100),
    role,
  };
}

function parseRegexFromString(input = "") {
  const match = /^\/(.*?)\/([gimsuy]*)$/.exec(String(input || "").trim());
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

function deterministicPercent(seed) {
  const hashed = simpleHash(seed).replace(/^h/, "");
  const parsed = Number.parseInt(hashed.slice(0, 8), 16);
  if (!Number.isFinite(parsed)) return 100;
  return (parsed % 100) + 1;
}

function deterministicWeightedIndex(weights = [], seed = "") {
  const normalized = weights.map((weight) =>
    Math.max(0, Math.trunc(Number(weight) || 0)),
  );
  const totalWeight = sum(normalized);
  if (totalWeight <= 0) return -1;

  const hashed = simpleHash(seed).replace(/^h/, "");
  let roll = (Number.parseInt(hashed.slice(0, 8), 16) % totalWeight) + 1;
  for (let index = 0; index < normalized.length; index += 1) {
    roll -= normalized[index];
    if (roll <= 0) {
      return index;
    }
  }
  return normalized.length - 1;
}

function matchKeys(haystack = "", needle = "", entry) {
  const regex = parseRegexFromString(String(needle || "").trim());
  if (regex) {
    return regex.test(haystack);
  }

  const source = entry.caseSensitive ? haystack : haystack.toLowerCase();
  const target = entry.caseSensitive
    ? String(needle || "").trim()
    : String(needle || "")
        .trim()
        .toLowerCase();

  if (!target) return false;

  if (entry.matchWholeWords) {
    const words = target.split(/\s+/);
    if (words.length > 1) {
      return source.includes(target);
    }
    return new RegExp(`(?:^|\\W)(${escapeRegExp(target)})(?:$|\\W)`).test(
      source,
    );
  }

  return source.includes(target);
}

function getScore(trigger = "", entry) {
  let primaryScore = 0;
  let secondaryScore = 0;

  for (const key of entry.keys) {
    if (matchKeys(trigger, key, entry)) primaryScore += 1;
  }
  for (const key of entry.keysSecondary) {
    if (matchKeys(trigger, key, entry)) secondaryScore += 1;
  }

  if (entry.keys.length === 0) return 0;

  if (entry.keysSecondary.length > 0) {
    if (entry.selectiveLogic === WI_LOGIC.AND_ANY) {
      return primaryScore + secondaryScore;
    }
    if (entry.selectiveLogic === WI_LOGIC.AND_ALL) {
      return secondaryScore === entry.keysSecondary.length
        ? primaryScore + secondaryScore
        : primaryScore;
    }
  }

  return primaryScore;
}

function calcDepth(entry, maxDepth) {
  const offset = DEPTH_MAPPING[entry.position];
  if (offset == null) {
    return entry.depth ?? DEFAULT_DEPTH;
  }
  return offset + maxDepth;
}

function sortEntries(a, b) {
  const maxDepth = Math.max(a.depth ?? 0, b.depth ?? 0, DEFAULT_DEPTH);
  return (
    calcDepth(b, maxDepth) - calcDepth(a, maxDepth) ||
    (a.order ?? 100) - (b.order ?? 100) ||
    (b.uid ?? 0) - (a.uid ?? 0)
  );
}

function selectActivatedEntries(
  entries = [],
  trigger = "",
  templateContext = {},
) {
  const activationSeedBase = simpleHash(String(trigger || ""));
  const activated = new Map();

  const addActivated = (entry, activationDebug = {}) => {
    const key = `${entry.worldbook}:${entry.uid}:${entry.name}`;
    activated.set(key, {
      ...entry,
      activationDebug: {
        mode: activationDebug.mode || "",
        matchedPrimaryKey: activationDebug.matchedPrimaryKey || "",
        matchedSecondaryKeys: Array.isArray(activationDebug.matchedSecondaryKeys)
          ? activationDebug.matchedSecondaryKeys
          : [],
      },
    });
  };

  for (const entry of entries) {
    if (!entry.enabled) continue;

    if (entry.useProbability) {
      const probabilityRoll = deterministicPercent(
        `${activationSeedBase}:prob:${entry.worldbook}:${entry.uid}:${entry.name}`,
      );
      if (entry.probability < probabilityRoll) continue;
    }

    if (entry.constant) {
      addActivated(entry, { mode: "constant" });
      continue;
    }

    if (entry.decorators.includes("@@activate")) {
      addActivated(entry, { mode: "forced" });
      continue;
    }
    if (entry.decorators.includes("@@dont_activate")) continue;

    if (entry.keys.length === 0) continue;
    const matchedPrimary = entry.keys
      .map((key) => substituteTaskEjsParams(key, templateContext))
      .find((key) => matchKeys(trigger, key, entry));
    if (!matchedPrimary) continue;

    const hasSecondaryKeys = entry.selective && entry.keysSecondary.length > 0;
    if (!hasSecondaryKeys) {
      addActivated(entry, {
        mode: "selective",
        matchedPrimaryKey: matchedPrimary,
      });
      continue;
    }

    let hasAnyMatch = false;
    let hasAllMatch = true;
    const matchedSecondaryKeys = [];

    for (const secondaryKey of entry.keysSecondary) {
      const substituted = substituteTaskEjsParams(
        secondaryKey,
        templateContext,
      );
      const hasMatch =
        substituted.trim() !== "" &&
        matchKeys(trigger, substituted.trim(), entry);
      if (hasMatch) hasAnyMatch = true;
      if (!hasMatch) hasAllMatch = false;
      if (hasMatch) matchedSecondaryKeys.push(substituted.trim());

      if (entry.selectiveLogic === WI_LOGIC.AND_ANY && hasMatch) {
        addActivated(entry, {
          mode: "selective",
          matchedPrimaryKey: matchedPrimary,
          matchedSecondaryKeys,
        });
        break;
      }

      if (entry.selectiveLogic === WI_LOGIC.NOT_ALL && !hasMatch) {
        addActivated(entry, {
          mode: "selective",
          matchedPrimaryKey: matchedPrimary,
          matchedSecondaryKeys,
        });
        break;
      }
    }

    if (entry.selectiveLogic === WI_LOGIC.NOT_ANY && !hasAnyMatch) {
      addActivated(entry, {
        mode: "selective",
        matchedPrimaryKey: matchedPrimary,
        matchedSecondaryKeys,
      });
      continue;
    }

    if (entry.selectiveLogic === WI_LOGIC.AND_ALL && hasAllMatch) {
      addActivated(entry, {
        mode: "selective",
        matchedPrimaryKey: matchedPrimary,
        matchedSecondaryKeys,
      });
    }
  }

  if (activated.size === 0) {
    return [];
  }

  const grouped = groupBy([...activated.values()], (entry) => entry.group || "");
  const ungrouped = grouped[""] || [];
  if (ungrouped.length > 0 && Object.keys(grouped).length <= 1) {
    return ungrouped.sort(sortEntries);
  }

  const matched = [];
  for (const [groupName, members] of Object.entries(grouped)) {
    if (groupName === "") continue;

    if (members.length === 1) {
      matched.push(members[0]);
      continue;
    }

    const prioritized = members.filter((entry) => entry.groupOverride);
    if (prioritized.length > 0) {
      const topOrder = Math.min(
        ...prioritized.map((entry) => entry.order ?? 100),
      );
      matched.push(
        prioritized.find((entry) => (entry.order ?? 100) <= topOrder) ||
          prioritized[0],
      );
      continue;
    }

    const scored = members.filter((entry) => entry.useGroupScoring);
    if (scored.length > 0) {
      const scores = members.map((entry) => getScore(trigger, entry));
      const topScore = Math.max(...scores);
      if (topScore > 0) {
        const winnerIndex = Math.max(
          scores.findIndex((score) => score >= topScore),
          0,
        );
        matched.push(members[winnerIndex]);
        continue;
      }
    }

    const weighted = members.filter(
      (entry) => !entry.groupOverride && !entry.useGroupScoring,
    );
    if (weighted.length > 0) {
      const weights = weighted.map((entry) => entry.groupWeight);
      const winner = deterministicWeightedIndex(
        weights,
        `${activationSeedBase}:group:${groupName}:${weighted
          .map((entry) => `${entry.worldbook}:${entry.uid}`)
          .join("|")}`,
      );
      if (winner >= 0) {
        matched.push(weighted[winner]);
      }
    }
  }

  return ungrouped.concat(matched).sort(sortEntries);
}

async function loadNormalizedWorldbookEntries(
  worldbookHost,
  worldbookName,
  {
    mvuCollector = null,
    lazy = false,
    filterMode = "default",
    customFilterKeywords = [],
    customFilterCollector = null,
  } = {},
) {
  const normalizedName = normalizeKey(worldbookName);
  if (!normalizedName || typeof worldbookHost?.getWorldbook !== "function") {
    return [];
  }

  const entries = await worldbookHost.getWorldbook(normalizedName);
  let commentByUid = new Map();
  if (typeof worldbookHost?.getLorebookEntries === "function") {
    try {
      const loreEntries = await worldbookHost.getLorebookEntries(normalizedName);
      commentByUid = new Map(
        (Array.isArray(loreEntries) ? loreEntries : []).map((entry) => [
          entry.uid,
          String(entry.comment ?? ""),
        ]),
      );
    } catch (error) {
      debugDebug(
        `[ST-BME] task-worldinfo 读取 lorebook comment 失败: ${normalizedName}`,
        error,
      );
    }
  }

  const normalizedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalizedEntry = normalizeEntry(
      {
        ...entry,
        comment: commentByUid.get(entry.uid) ?? entry.comment ?? "",
      },
      normalizedName,
    );
    if (String(filterMode || "default") === "custom") {
      if (Array.isArray(customFilterKeywords) && customFilterKeywords.length > 0) {
        const nameLower = normalizedEntry.name.toLowerCase();
        const matchedKeyword = customFilterKeywords.find((keyword) =>
          nameLower.includes(String(keyword || "")),
        );
        if (matchedKeyword) {
          registerCustomFilteredEntry(
            customFilterCollector,
            normalizedEntry,
            matchedKeyword,
            { lazy },
          );
          continue;
        }
      }
    } else {
      const ignoreReason = getMvuIgnoreReason(normalizedEntry);
      if (ignoreReason) {
        registerIgnoredWorldInfoEntry(mvuCollector, normalizedEntry, ignoreReason, {
          lazy,
        });
        continue;
      }
    }
    normalizedEntries.push(normalizedEntry);
  }

  return normalizedEntries;
}

async function collectAllWorldbookEntries(
  worldbookHost = null,
  { filterMode = "default", customFilterKeywords = [] } = {},
) {
  const resolvedWorldbookHost = worldbookHost || (await getWorldbookHost());
  const {
    getWorldbook,
    getCharWorldbookNames,
    sourceLabel,
    fallback,
    capabilityStatus,
    snapshotRevision,
  } = resolvedWorldbookHost;
  const ctx = getStContext();
  const debug = {
    sourceLabel,
    fallback,
    capabilityStatus,
    snapshotRevision: Number(snapshotRevision || 0),
    requestedWorldbooks: [],
    loadedWorldbooks: [],
    worldbookCount: 0,
    cache: {
      hit: false,
      key: "",
      ageMs: 0,
      ttlMs: WORLDINFO_CACHE_TTL_MS,
    },
    loadMs: 0,
  };
  if (!getWorldbook) {
    return {
      entries: [],
      debug,
    };
  }

  const sourceTag = `${sourceLabel}${fallback ? ", fallback" : ""}`;
  const supplementedCapabilities =
    capabilityStatus?.supplementedCapabilities || [];
  const missingCapabilities = capabilityStatus?.missingCapabilities || [];
  if (supplementedCapabilities.length > 0) {
    debugDebug(
      `[ST-BME] task-worldinfo worldbook bridge 已通过 legacy 补齐关键能力: ${supplementedCapabilities.join(", ")} [${sourceTag}]`,
    );
  }
  if (missingCapabilities.length > 0) {
    console.warn(
      `[ST-BME] task-worldinfo worldbook host 缺失关键能力，将显式降级相关旧语义: ${missingCapabilities.join(", ")} [${sourceTag}]`,
    );
  }

  const charWorldbooks = {
    primary: "",
    additional: [],
  };
  if (getCharWorldbookNames) {
    try {
      const resolved = getCharWorldbookNames("current") || {};
      charWorldbooks.primary = normalizeKey(resolved.primary);
      charWorldbooks.additional = Array.isArray(resolved.additional)
        ? resolved.additional.map((name) => normalizeKey(name)).filter(Boolean)
        : [];
    } catch (error) {
      debugDebug(
        `[ST-BME] task-worldinfo 读取角色世界书失败 [${sourceTag}]`,
        error,
      );
    }
  }

  const personaLorebook =
    ctx.extensionSettings?.persona_description_lorebook ||
    ctx.powerUserSettings?.persona_description_lorebook ||
    ctx.power_user?.persona_description_lorebook ||
    "";
  const chatLorebook = ctx.chatMetadata?.world || "";

  const requestedWorldbooks = uniq(
    [
      charWorldbooks.primary,
      ...(charWorldbooks.additional || []),
      personaLorebook,
      chatLorebook,
    ]
      .map((name) => normalizeKey(name))
      .filter(Boolean),
  );
  debug.requestedWorldbooks = requestedWorldbooks;

  const cacheKey = JSON.stringify({
    chatId: ctx.chatId || globalThis.getCurrentChatId?.() || "",
    characterId: ctx.characterId ?? "",
    requestedWorldbooks,
    sourceLabel,
    fallback,
    snapshotRevision: Number(snapshotRevision || 0),
    filterMode: String(filterMode || "default"),
    customFilterKeywords: Array.isArray(customFilterKeywords)
      ? customFilterKeywords
      : [],
  });
  debug.cache.key = cacheKey;

  if (
    worldbookEntriesCache.key === cacheKey &&
    worldbookEntriesCache.expiresAt > Date.now()
  ) {
    return {
      entries: worldbookEntriesCache.entries,
      blockedContents: worldbookEntriesCache.blockedContents,
      ignoredEntries: worldbookEntriesCache.ignoredEntries,
      ignoredLookup: worldbookEntriesCache.ignoredLookup,
      debug: {
        ...debug,
        loadedWorldbooks:
          worldbookEntriesCache.debug?.loadedWorldbooks || requestedWorldbooks,
        worldbookCount: worldbookEntriesCache.entries.length,
        loadMs: worldbookEntriesCache.debug?.loadMs || 0,
        mvu: worldbookEntriesCache.debug?.mvu || buildMvuDebugSummary(null),
        customFilter:
          worldbookEntriesCache.debug?.customFilter ||
          buildCustomFilterDebugSummary(null, {
            filterMode,
            customFilterKeywords,
          }),
        cache: {
          ...debug.cache,
          hit: true,
          ageMs: Math.max(0, Date.now() - worldbookEntriesCache.createdAt),
        },
      },
    };
  }

  const allEntries = [];
  const loadedNames = new Set();
  const startedAt = Date.now();
  const mvuCollector = createMvuCollector();
  const customFilterCollector = createCustomFilterCollector();

  async function loadWorldbookOnce(worldbookName) {
    const normalizedName = normalizeKey(worldbookName);
    if (!normalizedName || loadedNames.has(normalizedName)) return;
    loadedNames.add(normalizedName);

    try {
      const entries = await loadNormalizedWorldbookEntries(
        resolvedWorldbookHost,
        normalizedName,
        {
          mvuCollector,
          filterMode,
          customFilterKeywords,
          customFilterCollector,
        },
      );
      allEntries.push(...entries);
    } catch (error) {
      debugDebug(
        `[ST-BME] task-worldinfo 读取世界书失败: ${normalizedName} [${sourceTag}]`,
        error,
      );
    }
  }

  for (const worldbookName of requestedWorldbooks) {
    await loadWorldbookOnce(worldbookName);
  }

  debug.loadedWorldbooks = [...loadedNames];
  debug.worldbookCount = allEntries.length;
  debug.loadMs = Date.now() - startedAt;
  debug.mvu = buildMvuDebugSummary(mvuCollector);
  debug.customFilter = buildCustomFilterDebugSummary(customFilterCollector, {
    filterMode,
    customFilterKeywords,
  });
  worldbookEntriesCache = {
    key: cacheKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + WORLDINFO_CACHE_TTL_MS,
    entries: allEntries,
    blockedContents: [...mvuCollector.blockedContents],
    ignoredEntries: [...debug.mvu.filteredEntries],
    ignoredLookup: new Map(mvuCollector.ignoredLookup),
    debug: {
      ...debug,
    },
  };

  return {
    entries: allEntries,
    blockedContents: [...mvuCollector.blockedContents],
    ignoredEntries: [...debug.mvu.filteredEntries],
    ignoredLookup: new Map(mvuCollector.ignoredLookup),
    debug,
  };
}

function classifyPosition(entry) {
  switch (entry.position) {
    case WI_POSITION.before:
    case WI_POSITION.EMTop:
    case WI_POSITION.ANTop:
      return "before";
    case WI_POSITION.atDepth:
      return "atDepth";
    case WI_POSITION.after:
    case WI_POSITION.EMBottom:
    case WI_POSITION.ANBottom:
    default:
      return "after";
  }
}

function normalizeResolvedEntry(entry = {}, fallbackIndex = 0) {
  const role = ["system", "user", "assistant"].includes(entry.role)
    ? entry.role
    : "system";
  return {
    name: normalizeKey(entry.name),
    sourceName: normalizeKey(
      entry.sourceName || entry.source_name || entry.name,
    ),
    worldbook: normalizeKey(entry.worldbook),
    content: String(entry.content || ""),
    role,
    position: Number(entry.position ?? WI_POSITION.after),
    depth: Number(entry.depth ?? 0),
    order: Number(entry.order ?? 100),
    index: fallbackIndex,
    activationDebug:
      entry.activationDebug && typeof entry.activationDebug === "object"
        ? {
            ...entry.activationDebug,
          }
        : null,
  };
}

function sortAtDepthEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const depthA = Number(a.depth ?? 0);
    const depthB = Number(b.depth ?? 0);
    return (
      depthB - depthA ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.index - b.index
    );
  });
}

function buildAdditionalMessages(entries = []) {
  return sortAtDepthEntries(entries)
    .map((entry) => ({
      role: entry.role,
      content: String(entry.content || "").trim(),
      source: "worldInfo-atDepth",
      sourceKey: "taskAdditionalMessages",
    }))
    .filter((entry) => entry.content);
}

function buildWorldInfoText(entries = []) {
  return entries
    .map((entry) => String(entry.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildActivationSourceTexts({
  chatMessages = [],
  userMessage = "",
  templateContext = {},
} = {}) {
  const texts = [];

  if (Array.isArray(chatMessages)) {
    for (const message of chatMessages) {
      const text =
        typeof message === "string"
          ? message
          : typeof message?.content === "string"
            ? message.content
            : typeof message?.mes === "string"
              ? message.mes
              : "";
      if (text) texts.push(text);
    }
  }

  if (typeof userMessage === "string" && userMessage.trim()) {
    texts.push(userMessage);
  }

  const fallbackContextFields = [
    "recentMessages",
    "dialogueText",
    "userMessage",
    "candidateNodes",
    "candidateText",
    "nodeContent",
    "eventSummary",
    "characterSummary",
    "threadSummary",
    "contradictionSummary",
  ];

  for (const key of fallbackContextFields) {
    const value = templateContext?.[key];
    if (typeof value === "string" && value.trim()) {
      texts.push(value);
    }
  }

  return uniq(texts.map((text) => String(text).trim()).filter(Boolean));
}

function getEntryIdentity(entry = {}) {
  return `${entry.worldbook}:${entry.uid}:${entry.name}`;
}

function toActivationMap(entries = []) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    map.set(getEntryIdentity(entry), entry);
  }
  return map;
}

function warnLegacyEntryNames(entries = [], warnings = []) {
  const legacyNames = uniq(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry?.name || "").trim())
      .filter(
        (name) => name.startsWith("EW/Controller/") || name.startsWith("EW/Dyn/"),
      ),
  );

  if (legacyNames.length === 0) {
    return;
  }

  const warning =
    `检测到旧 EW 命名条目 (${legacyNames.join(", ")})；这些条目现在只按普通世界书条目处理，不再有专用魔法行为`;
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
  console.warn(`[ST-BME] task-worldinfo ${warning}`);
}

function mergeActivationDebug(entry = {}, overrides = {}) {
  return {
    ...(entry.activationDebug && typeof entry.activationDebug === "object"
      ? entry.activationDebug
      : {}),
    ...overrides,
  };
}

export async function resolveTaskWorldInfo({
  settings = {},
  chatMessages = [],
  userMessage = "",
  templateContext = {},
} = {}) {
  const filterMode = String(settings.worldInfoFilterMode || "default").trim();
  const isCustomFilter = filterMode === "custom";
  const customFilterKeywords = isCustomFilter
    ? String(settings.worldInfoFilterCustomKeywords || "")
        .split(",")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const result = {
    beforeEntries: [],
    afterEntries: [],
    atDepthEntries: [],
    beforeText: "",
    afterText: "",
    additionalMessages: [],
    activatedEntryNames: [],
    allEntries: [],
    debug: {
      sourceLabel: "",
      fallback: false,
      capabilityStatus: null,
      snapshotRevision: 0,
      requestedWorldbooks: [],
      loadedWorldbooks: [],
      worldbookCount: 0,
      triggerLength: 0,
      activatedEntryCount: 0,
      constantActivatedCount: 0,
      selectiveActivatedCount: 0,
      ejsForcedActivationCount: 0,
      ejsInlinePullCount: 0,
      resolvePassCount: 0,
      forcedActivatedEntries: [],
      inlinePulledEntries: [],
      lazyLoadedWorldbooks: [],
      recursionWarnings: [],
      cache: {
        hit: false,
        key: "",
        ageMs: 0,
        ttlMs: WORLDINFO_CACHE_TTL_MS,
      },
      loadMs: 0,
      ejsRuntimeStatus: "",
      ejsRuntimeFallback: false,
      ejsLastError: "",
      warnings: [],
      resolvedEntries: [],
      customRender: {
        stNativeRuntimeAvailable: false,
        envPrepared: false,
        usedEntryCount: 0,
        fallbackEntryCount: 0,
        ejsErrorCount: 0,
        bridgedStatDataFromLatestMessage: false,
        taskEjsStatDataRoots: {
          global: false,
          local: false,
          message: false,
          cache: false,
        },
      },
      mvu: buildMvuDebugSummary(null),
      customFilter: buildCustomFilterDebugSummary(null, {
        filterMode,
        customFilterKeywords,
      }),
    },
  };

  try {
    const worldbookHost = await getWorldbookHost();
    const collected = await collectAllWorldbookEntries(worldbookHost, {
      filterMode,
      customFilterKeywords,
    });
    const allEntries = Array.isArray(collected?.entries) ? collected.entries : [];
    const blockedContents = Array.isArray(collected?.blockedContents)
      ? collected.blockedContents
      : [];
    const ignoredLookup =
      collected?.ignoredLookup instanceof Map
        ? collected.ignoredLookup
        : new Map();
    result.allEntries = allEntries;
    Object.defineProperty(result, "__mvuBlockedContents", {
      value: blockedContents,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    result.debug = {
      ...result.debug,
      ...(collected?.debug || {}),
      cache: {
        ...result.debug.cache,
        ...(collected?.debug?.cache || {}),
      },
      warnings: Array.isArray(result.debug.warnings)
        ? result.debug.warnings
        : [],
      resolvedEntries: Array.isArray(result.debug.resolvedEntries)
        ? result.debug.resolvedEntries
        : [],
      mvu:
        collected?.debug?.mvu && typeof collected.debug.mvu === "object"
          ? { ...collected.debug.mvu }
          : buildMvuDebugSummary(null),
      customFilter:
        collected?.debug?.customFilter &&
        typeof collected.debug.customFilter === "object"
          ? { ...collected.debug.customFilter }
          : buildCustomFilterDebugSummary(null, {
              filterMode,
              customFilterKeywords,
            }),
    };
    if (allEntries.length === 0) {
      return result;
    }
    warnLegacyEntryNames(allEntries, result.debug.warnings);

    const triggerTexts = buildActivationSourceTexts({
      chatMessages,
      userMessage,
      templateContext,
    });
    const trigger = triggerTexts.join("\n\n");
    result.debug.triggerLength = trigger.length;
    const ejsBackend = await inspectTaskEjsRuntimeBackend();
    result.debug.ejsRuntimeStatus = ejsBackend.status || "";
    result.debug.ejsRuntimeFallback = Boolean(ejsBackend.isFallback);
    result.debug.ejsLastError = ejsBackend.error
      ? ejsBackend.error instanceof Error
        ? ejsBackend.error.message
        : String(ejsBackend.error)
      : "";

    const normalizedTemplateContext = {
      ...templateContext,
      user_input: userMessage || templateContext?.user_input || "",
    };
    const initialActivated = selectActivatedEntries(
      allEntries,
      trigger,
      normalizedTemplateContext,
    );
    if (initialActivated.length === 0) {
      return result;
    }

    const allActivated = toActivationMap(initialActivated);
    const aggregatedForcedEntries = new Map();
    const aggregatedInlineEntries = new Map();
    const recursionWarnings = new Set();
    const lazyMvuCollector = {
      blockedContents,
      filteredEntries: Array.isArray(result.debug.mvu.filteredEntries)
        ? result.debug.mvu.filteredEntries
        : [],
      lazyFilteredEntries: [],
      ignoredLookup,
      seenEntries: new Set(),
    };
    const lazyCustomFilterCollector = createCustomFilterCollector();
    const knownWorldbooks = new Set(
      allEntries.map((entry) => entry.worldbook).filter(Boolean),
    );
    const lazyLoadWorldbookEntries = async (worldbookName) => {
      const normalizedWorldbook = normalizeKey(worldbookName);
      if (!normalizedWorldbook || knownWorldbooks.has(normalizedWorldbook)) {
        return [];
      }
      const lazyEntries = await loadNormalizedWorldbookEntries(
        worldbookHost,
        normalizedWorldbook,
        {
          mvuCollector: lazyMvuCollector,
          lazy: true,
          filterMode,
          customFilterKeywords,
          customFilterCollector: lazyCustomFilterCollector,
        },
      );
      knownWorldbooks.add(normalizedWorldbook);
      const newLazyIgnoredEntries = [...lazyMvuCollector.lazyFilteredEntries];
      result.debug.mvu = {
        ...result.debug.mvu,
        blockedContentsCount: uniq(
          blockedContents.map((item) => String(item || "").trim()).filter(Boolean),
        ).length,
        filteredEntries: [
          ...(Array.isArray(result.debug.mvu.filteredEntries)
            ? result.debug.mvu.filteredEntries
            : []),
          ...newLazyIgnoredEntries,
        ],
        lazyFilteredEntryCount:
          Number(result.debug.mvu.lazyFilteredEntryCount || 0) +
          newLazyIgnoredEntries.length,
      };
      lazyMvuCollector.lazyFilteredEntries = [];
      if (isCustomFilter) {
        const newLazyCustomEntries = [
          ...lazyCustomFilterCollector.lazyFilteredEntries,
        ];
        if (newLazyCustomEntries.length > 0) {
          result.debug.customFilter = {
            ...result.debug.customFilter,
            filteredEntries: [
              ...(Array.isArray(result.debug.customFilter?.filteredEntries)
                ? result.debug.customFilter.filteredEntries
                : []),
              ...newLazyCustomEntries,
            ],
            filteredEntryCount:
              Number(result.debug.customFilter?.filteredEntryCount || 0) +
              newLazyCustomEntries.length,
            lazyFilteredEntryCount:
              Number(result.debug.customFilter?.lazyFilteredEntryCount || 0) +
              newLazyCustomEntries.length,
          };
        }
        lazyCustomFilterCollector.lazyFilteredEntries = [];
      }
      return lazyEntries;
    };

    const renderCtx = createTaskEjsRenderContext(
      allEntries.map((entry) => ({
        uid: entry.uid,
        name: entry.name,
        comment: entry.comment,
        content: entry.cleanContent || entry.content,
        worldbook: entry.worldbook,
        role: entry.role,
        position: entry.position,
        depth: entry.depth,
        order: entry.order,
        activationDebug: entry.activationDebug,
      })),
      {
        templateContext: normalizedTemplateContext,
        currentActivatedEntries: [...allActivated.values()],
        loadWorldbookEntries: lazyLoadWorldbookEntries,
        resolveIgnoredEntry: isCustomFilter
          ? () => null
          : (worldbookName, identifier) =>
              findIgnoredWorldInfoEntry(
                { ignoredLookup },
                worldbookName,
                identifier,
              ),
      },
    );

    const customRenderEnv = isCustomFilter
      ? await prepareStNativeEjsEnv()
      : null;
    const customRenderMessageVars = isCustomFilter
      ? getLatestMessageVarTable()
      : null;
    if (isCustomFilter) {
      result.debug.customRender.bridgedStatDataFromLatestMessage =
        bridgeCustomTaskEjsStatData(renderCtx, customRenderMessageVars);
    }

    result.debug.customRender = {
      ...result.debug.customRender,
      taskEjsStatDataRoots: {
        global: Object.prototype.hasOwnProperty.call(
          renderCtx.variableState?.globalVars || {},
          "stat_data",
        ),
        local: Object.prototype.hasOwnProperty.call(
          renderCtx.variableState?.localVars || {},
          "stat_data",
        ),
        message: Object.prototype.hasOwnProperty.call(
          renderCtx.variableState?.messageVars || {},
          "stat_data",
        ),
        cache: Object.prototype.hasOwnProperty.call(
          renderCtx.variableState?.cacheVars || {},
          "stat_data",
        ),
      },
    };
    result.debug.customRender = {
      ...result.debug.customRender,
      stNativeRuntimeAvailable:
        result.debug.customRender.stNativeRuntimeAvailable ||
        Boolean(globalThis.window?.EjsTemplate || globalThis.EjsTemplate),
      envPrepared: Boolean(customRenderEnv),
    };

    const maxResolvePasses =
      Number.isFinite(Number(settings.worldInfoMaxResolvePasses)) &&
      Number(settings.worldInfoMaxResolvePasses) > 0
        ? Number(settings.worldInfoMaxResolvePasses)
        : DEFAULT_MAX_RESOLVE_PASSES;

    const beforeEntries = [];
    const afterEntries = [];
    const atDepthEntries = [];
    let resolvedIndex = 0;
    let finalResolvedEntries = [];
    let hitResolveCap = false;

    for (let pass = 0; pass < maxResolvePasses; pass += 1) {
      result.debug.resolvePassCount = pass + 1;
      renderCtx.currentActivatedEntries = [...allActivated.values()];
      renderCtx.forcedActivatedEntries.clear();
      renderCtx.inlinePulledEntries.clear();
      renderCtx.warnings = [];
      finalResolvedEntries = [];
      resolvedIndex = 0;

      const activatedEntries = [...allActivated.values()].sort(sortEntries);

      for (const entry of activatedEntries) {
        const sourceContent = entry.cleanContent || entry.content;
        let renderedContent = sourceContent;
        let taskEjsRenderedContent = sourceContent;
        let taskEjsError = null;
        try {
          taskEjsRenderedContent = await evalTaskEjsTemplate(sourceContent, renderCtx, {
            world_info: {
              comment: entry.comment || entry.name,
              name: entry.name,
              world: entry.worldbook,
            },
          });
        } catch (error) {
          const warning =
            error?.code === "st_bme_task_ejs_unsupported_helper"
              ? `世界书条目 ${entry.name} 调用了不支持的 helper: ${error.helperName}`
              : error?.code === "st_bme_task_ejs_runtime_unavailable"
                ? `世界书条目 ${entry.name} 依赖 EJS runtime，当前已跳过`
                : `世界书条目 ${entry.name} 渲染失败，已跳过`;
          if (!result.debug.warnings.includes(warning)) {
            result.debug.warnings.push(warning);
          }
          console.warn(
            `[ST-BME] task-worldinfo 渲染世界书条目失败: ${entry.name}`,
            error,
          );
          if (
            error?.code === "st_bme_task_ejs_runtime_unavailable" &&
            !result.debug.ejsLastError
          ) {
            result.debug.ejsLastError =
              error instanceof Error ? error.message : String(error);
          }
          taskEjsError = error;
          taskEjsRenderedContent = "";
        }
        renderedContent = taskEjsRenderedContent;

        if (isCustomFilter) {
          const sourceIncludesEjs = String(sourceContent || "").includes("<%");
          const shouldAttemptNativeEjsFallback =
            taskEjsError?.code === "st_bme_task_ejs_runtime_unavailable" &&
            sourceIncludesEjs;
          const stNativeRender = await renderTemplateWithStSupport(
            shouldAttemptNativeEjsFallback ? sourceContent : renderedContent,
            {
              env: customRenderEnv,
              messageVars: customRenderMessageVars,
              evaluateEjs: shouldAttemptNativeEjsFallback,
            },
          );
          if (stNativeRender.ejsError) {
            result.debug.customRender.ejsErrorCount += 1;
          }

          const shouldUseStNativeResult =
            (shouldAttemptNativeEjsFallback && stNativeRender.ejsEvaluated) ||
            (!shouldAttemptNativeEjsFallback &&
              (stNativeRender.macroApplied ||
                stNativeRender.messageVariableMacrosApplied ||
                stNativeRender.text !== renderedContent));

          if (shouldUseStNativeResult) {
            renderedContent = stNativeRender.text;
            result.debug.customRender.usedEntryCount += 1;
          } else {
            result.debug.customRender.fallbackEntryCount += 1;
          }
        }

        for (const warning of renderCtx.warnings || []) {
          recursionWarnings.add(String(warning || ""));
        }

        const mvuSanitized = isCustomFilter
          ? {
              text: renderedContent,
              changed: false,
              dropped: false,
              reasons: [],
              blockedHitCount: 0,
              artifactRemovedCount: 0,
            }
          : sanitizeMvuContent(renderedContent, {
              mode: "aggressive",
              blockedContents,
            });
        if (mvuSanitized.dropped) {
          const warning = `世界书条目 ${entry.name} 渲染结果命中 MVU 规则，已跳过`;
          if (!result.debug.warnings.includes(warning)) {
            result.debug.warnings.push(warning);
          }
        }
        const trimmedContent = String(mvuSanitized.text || "").trim();
        if (!trimmedContent) {
          continue;
        }

        finalResolvedEntries.push(
          normalizeResolvedEntry(
            {
              name: entry.comment || entry.name,
              sourceName: entry.name,
              worldbook: entry.worldbook,
              content: trimmedContent,
              role: entry.role,
              position: entry.position,
              depth: entry.depth,
              order: entry.order,
              activationDebug: entry.activationDebug,
            },
            resolvedIndex++,
          ),
        );
      }

      for (const pulledEntry of renderCtx.inlinePulledEntries.values()) {
        const key = `${pulledEntry.worldbook}:${pulledEntry.name}`;
        if (!aggregatedInlineEntries.has(key)) {
          aggregatedInlineEntries.set(key, {
            name: pulledEntry.comment || pulledEntry.name,
            sourceName: pulledEntry.name,
            worldbook: pulledEntry.worldbook,
          });
        }
      }

      let discoveredNewActivation = false;
      for (const forcedEntry of renderCtx.forcedActivatedEntries.values()) {
        const key = getEntryIdentity(forcedEntry);
        if (!aggregatedForcedEntries.has(key)) {
          aggregatedForcedEntries.set(key, {
            name: forcedEntry.comment || forcedEntry.name,
            sourceName: forcedEntry.name,
            worldbook: forcedEntry.worldbook,
          });
        }
        if (!allActivated.has(key)) {
          allActivated.set(key, {
            ...forcedEntry,
            activationDebug: mergeActivationDebug(forcedEntry, {
              mode: "ejs-forced",
            }),
          });
          discoveredNewActivation = true;
        }
      }

      if (!discoveredNewActivation) {
        break;
      }

      if (pass + 1 >= maxResolvePasses) {
        hitResolveCap = true;
      }
    }

    if (hitResolveCap) {
      const warning = `世界书 EJS 激活达到递归上限 ${maxResolvePasses}，已停止继续展开`;
      if (!result.debug.warnings.includes(warning)) {
        result.debug.warnings.push(warning);
      }
      recursionWarnings.add(warning);
    }

    for (const entry of finalResolvedEntries) {
      const bucketName = classifyPosition(entry);
      const bucket =
        bucketName === "before"
          ? beforeEntries
          : bucketName === "after"
            ? afterEntries
            : atDepthEntries;
      bucket.push(entry);
    }

    result.beforeEntries = beforeEntries;
    result.afterEntries = afterEntries;
    result.atDepthEntries = sortAtDepthEntries(atDepthEntries);
    result.beforeText = buildWorldInfoText(result.beforeEntries);
    result.afterText = buildWorldInfoText(result.afterEntries);
    result.additionalMessages = buildAdditionalMessages(result.atDepthEntries);
    result.debug.activatedEntryCount = allActivated.size;
    result.debug.constantActivatedCount = [...allActivated.values()].filter(
      (entry) => entry.activationDebug?.mode === "constant",
    ).length;
    result.debug.selectiveActivatedCount = [...allActivated.values()].filter(
      (entry) =>
        entry.activationDebug?.mode === "selective" ||
        entry.activationDebug?.mode === "forced",
    ).length;
    result.debug.ejsForcedActivationCount = aggregatedForcedEntries.size;
    result.debug.ejsInlinePullCount = aggregatedInlineEntries.size;
    result.debug.forcedActivatedEntries = [...aggregatedForcedEntries.values()];
    result.debug.inlinePulledEntries = [...aggregatedInlineEntries.values()];
    result.debug.lazyLoadedWorldbooks = [...renderCtx.lazyLoadedWorldbooks];
    result.debug.recursionWarnings = [...recursionWarnings];
    result.debug.resolvedEntries = [
      ...result.beforeEntries.map((entry) => ({
        name: entry.name,
        bucket: "before",
        sourceName: entry.sourceName,
        worldbook: entry.worldbook,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
      })),
      ...result.afterEntries.map((entry) => ({
        name: entry.name,
        bucket: "after",
        sourceName: entry.sourceName,
        worldbook: entry.worldbook,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
      })),
      ...result.atDepthEntries.map((entry) => ({
        name: entry.name,
        bucket: "atDepth",
        sourceName: entry.sourceName,
        worldbook: entry.worldbook,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
      })),
    ];
    result.activatedEntryNames = uniq(
      [
        ...result.beforeEntries.map((entry) => entry.name),
        ...result.afterEntries.map((entry) => entry.name),
        ...result.atDepthEntries.map((entry) => entry.name),
        ...[...aggregatedForcedEntries.values()].map(
          (entry) => entry.name || entry.sourceName,
        ),
      ].filter(Boolean),
    );
  } catch (error) {
    console.error("[ST-BME] task-worldinfo 解析失败:", error);
  }

  return result;
}
