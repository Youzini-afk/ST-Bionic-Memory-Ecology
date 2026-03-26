// ST-BME: 任务级世界书激活引擎
// 复刻 Evolution_World 的世界书来源、激活与 EJS 渲染主逻辑，
// 但只接入 ST-BME 的任务预设系统，不引入完整工作流调度层。

import {
  createTaskEjsRenderContext,
  evalTaskEjsTemplate,
  inspectTaskEjsRuntimeBackend,
  substituteTaskEjsParams,
} from "./task-ejs.js";

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
const DEFAULT_CONTROLLER_ENTRY_PREFIX = "EW/Controller/";
const WORLDINFO_CACHE_TTL_MS = 3000;
const KNOWN_DECORATORS = [
  "@@activate",
  "@@dont_activate",
  "@@message_formatting",
  "@@generate",
  "@@generate_before",
  "@@generate_after",
  "@@render",
  "@@render_before",
  "@@render_after",
  "@@dont_preload",
  "@@initial_variables",
  "@@always_enabled",
  "@@only_preload",
  "@@iframe",
  "@@preprocessing",
  "@@if",
  "@@private",
];

const SPECIAL_NAME_MARKERS = [
  "[GENERATE:",
  "[RENDER:",
  "@INJECT",
  "[InitialVariables]",
];

let worldbookEntriesCache = {
  key: "",
  createdAt: 0,
  expiresAt: 0,
  entries: [],
  debug: null,
};

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
    console.debug(
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
  const decorators = [];
  const cleanLines = [];

  for (const line of String(content || "").split("\n")) {
    const trimmed = line.trim();
    const matched = KNOWN_DECORATORS.find((decorator) =>
      trimmed.startsWith(decorator),
    );
    if (matched) {
      const firstSpace = trimmed.indexOf(" ");
      decorators.push(firstSpace > 0 ? trimmed.slice(0, firstSpace) : trimmed);
    } else {
      cleanLines.push(line);
    }
  }

  return {
    decorators,
    cleanContent: cleanLines.join("\n").trim(),
  };
}

function isSpecialEntryByComment(comment = "") {
  return SPECIAL_NAME_MARKERS.some((marker) =>
    String(comment).includes(marker),
  );
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
    if (entry.decorators.includes("@@only_preload")) continue;

    const specialDecorators = [
      "@@generate",
      "@@generate_before",
      "@@generate_after",
      "@@render",
      "@@render_before",
      "@@render_after",
      "@@initial_variables",
      "@@preprocessing",
      "@@iframe",
    ];
    if (
      entry.decorators.some((decorator) =>
        specialDecorators.includes(decorator),
      )
    ) {
      continue;
    }
    if (isSpecialEntryByComment(entry.comment)) continue;

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

async function collectAllWorldbookEntries() {
  const {
    getWorldbook,
    getLorebookEntries,
    getCharWorldbookNames,
    sourceLabel,
    fallback,
    capabilityStatus,
    snapshotRevision,
  } = await getWorldbookHost();
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
    console.debug(
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
      console.debug(
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
  });
  debug.cache.key = cacheKey;

  if (
    worldbookEntriesCache.key === cacheKey &&
    worldbookEntriesCache.expiresAt > Date.now()
  ) {
    return {
      entries: worldbookEntriesCache.entries,
      debug: {
        ...debug,
        loadedWorldbooks:
          worldbookEntriesCache.debug?.loadedWorldbooks || requestedWorldbooks,
        worldbookCount: worldbookEntriesCache.entries.length,
        loadMs: worldbookEntriesCache.debug?.loadMs || 0,
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

  async function loadWorldbookOnce(worldbookName) {
    const normalizedName = normalizeKey(worldbookName);
    if (!normalizedName || loadedNames.has(normalizedName)) return;
    loadedNames.add(normalizedName);

    try {
      const entries = await getWorldbook(normalizedName);
      let commentByUid = new Map();
      if (getLorebookEntries) {
        try {
          const loreEntries = await getLorebookEntries(normalizedName);
          commentByUid = new Map(
            (Array.isArray(loreEntries) ? loreEntries : []).map((entry) => [
              entry.uid,
              String(entry.comment ?? ""),
            ]),
          );
        } catch (error) {
          console.debug(
            `[ST-BME] task-worldinfo 读取 lorebook comment 失败: ${normalizedName} [${sourceTag}]`,
            error,
          );
        }
      }

      for (const entry of Array.isArray(entries) ? entries : []) {
        allEntries.push(
          normalizeEntry(
            {
              ...entry,
              comment: commentByUid.get(entry.uid) ?? entry.comment ?? "",
            },
            normalizedName,
          ),
        );
      }
    } catch (error) {
      console.debug(
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
  worldbookEntriesCache = {
    key: cacheKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + WORLDINFO_CACHE_TTL_MS,
    entries: allEntries,
    debug: {
      ...debug,
    },
  };

  return {
    entries: allEntries,
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
    controllerSource: String(entry.controllerSource || ""),
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

export async function resolveTaskWorldInfo({
  settings = {},
  chatMessages = [],
  userMessage = "",
  templateContext = {},
} = {}) {
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
      controllerActivatedCount: 0,
      controllerPulledCount: 0,
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
    },
  };

  try {
    const collected = await collectAllWorldbookEntries();
    const allEntries = Array.isArray(collected?.entries) ? collected.entries : [];
    result.allEntries = allEntries;
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
    };
    if (allEntries.length === 0) {
      return result;
    }

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

    const activated = selectActivatedEntries(allEntries, trigger, {
      ...templateContext,
      user_input: userMessage || templateContext?.user_input || "",
    });
    result.debug.activatedEntryCount = activated.length;
    result.debug.constantActivatedCount = activated.filter(
      (entry) => entry.activationDebug?.mode === "constant",
    ).length;
    result.debug.selectiveActivatedCount = activated.filter(
      (entry) => entry.activationDebug?.mode === "selective",
    ).length;
    result.debug.controllerActivatedCount = activated.filter((entry) =>
      entry.name.startsWith(String(
        settings.worldInfoControllerEntryPrefix ||
          settings.controller_entry_prefix ||
          DEFAULT_CONTROLLER_ENTRY_PREFIX,
      )),
    ).length;
    if (activated.length === 0) {
      return result;
    }

    const renderCtx = createTaskEjsRenderContext(
      allEntries.map((entry) => ({
        name: entry.name,
        comment: entry.comment,
        content: entry.cleanContent || entry.content,
        worldbook: entry.worldbook,
      })),
      {
        templateContext: {
          ...templateContext,
          user_input: userMessage || templateContext?.user_input || "",
        },
      },
    );

    const controllerPrefix =
      settings.worldInfoControllerEntryPrefix ||
      settings.controller_entry_prefix ||
      DEFAULT_CONTROLLER_ENTRY_PREFIX;

    const beforeEntries = [];
    const afterEntries = [];
    const atDepthEntries = [];
    let resolvedIndex = 0;

    for (const entry of activated) {
      renderCtx.pulledEntries.clear();

      const sourceContent = entry.cleanContent || entry.content;
      const isControllerEntry = entry.name.startsWith(String(controllerPrefix || ""));
      let renderedContent = sourceContent;
      try {
        renderedContent = await evalTaskEjsTemplate(sourceContent, renderCtx, {
          world_info: {
            comment: entry.comment || entry.name,
            name: entry.name,
            world: entry.worldbook,
          },
        });
      } catch (error) {
        result.debug.warnings.push(
          error?.code === "st_bme_task_ejs_runtime_unavailable"
            ? `世界书条目 ${entry.name} 依赖 EJS runtime，当前已跳过`
            : `世界书条目 ${entry.name} 渲染失败，已跳过`,
        );
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
        renderedContent = "";
      }

      if (!isControllerEntry && !String(renderedContent || "").trim()) {
        continue;
      }

      const bucketName = classifyPosition(entry);
      const bucket =
        bucketName === "before"
          ? beforeEntries
          : bucketName === "after"
            ? afterEntries
            : atDepthEntries;

      if (isControllerEntry) {
        for (const pulledEntry of renderCtx.pulledEntries.values()) {
          if (!String(pulledEntry.content || "").trim()) continue;
          if (
            pulledEntry.worldbook === entry.worldbook &&
            pulledEntry.name === entry.name
          ) {
            continue;
          }
          bucket.push(
            normalizeResolvedEntry(
              {
                name: pulledEntry.comment || pulledEntry.name,
                sourceName: pulledEntry.name,
                worldbook: pulledEntry.worldbook,
                content: pulledEntry.content,
                role: entry.role,
                position: entry.position,
                depth: entry.depth,
                order: entry.order,
                activationDebug: {
                  ...(entry.activationDebug || {}),
                  mode: "controller-pulled",
                },
                controllerSource: entry.name,
              },
              resolvedIndex++,
            ),
          );
          result.debug.controllerPulledCount += 1;
        }
        continue;
      }

      bucket.push(
        normalizeResolvedEntry(
          {
            name: entry.comment || entry.name,
            sourceName: entry.name,
            worldbook: entry.worldbook,
            content: renderedContent,
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

    result.beforeEntries = beforeEntries;
    result.afterEntries = afterEntries;
    result.atDepthEntries = sortAtDepthEntries(atDepthEntries);
    result.beforeText = buildWorldInfoText(result.beforeEntries);
    result.afterText = buildWorldInfoText(result.afterEntries);
    result.additionalMessages = buildAdditionalMessages(result.atDepthEntries);
    result.debug.resolvedEntries = [
      ...result.beforeEntries.map((entry) => ({
        name: entry.name,
        bucket: "before",
        sourceName: entry.sourceName,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
        controllerSource: entry.controllerSource || "",
      })),
      ...result.afterEntries.map((entry) => ({
        name: entry.name,
        bucket: "after",
        sourceName: entry.sourceName,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
        controllerSource: entry.controllerSource || "",
      })),
      ...result.atDepthEntries.map((entry) => ({
        name: entry.name,
        bucket: "atDepth",
        sourceName: entry.sourceName,
        activationMode: entry.activationDebug?.mode || "",
        matchedPrimaryKey: entry.activationDebug?.matchedPrimaryKey || "",
        matchedSecondaryKeys: entry.activationDebug?.matchedSecondaryKeys || [],
        controllerSource: entry.controllerSource || "",
      })),
    ];
    result.activatedEntryNames = uniq(
      [
        ...result.beforeEntries.map((entry) => entry.name),
        ...result.afterEntries.map((entry) => entry.name),
        ...result.atDepthEntries.map((entry) => entry.name),
        ...[...renderCtx.activatedEntries.values()].map(
          (entry) => entry.comment || entry.name,
        ),
      ].filter(Boolean),
    );
  } catch (error) {
    console.error("[ST-BME] task-worldinfo 解析失败:", error);
  }

  return result;
}
