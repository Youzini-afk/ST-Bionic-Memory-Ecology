// ST-BME: Prompt Builder
// 统一负责任务预设块排序、变量渲染，以及世界书/EJS 上下文接入。

import { getActiveTaskProfile, getLegacyPromptForTask } from "./prompt-profiles.js";
import { sanitizeMvuContent } from "./mvu-compat.js";
import { resolveTaskWorldInfo } from "./task-worldinfo.js";
import { applyTaskRegex } from "./task-regex.js";

const WORLD_INFO_VARIABLE_KEYS = [
  "worldInfoBefore",
  "worldInfoAfter",
  "worldInfoBeforeEntries",
  "worldInfoAfterEntries",
  "worldInfoAtDepthEntries",
  "activatedWorldInfoNames",
  "taskAdditionalMessages",
];

const INPUT_CONTEXT_MVU_FIELDS = [
  "userMessage",
  "recentMessages",
  "chatMessages",
  "dialogueText",
  "candidateText",
  "candidateNodes",
  "nodeContent",
  "eventSummary",
  "characterSummary",
  "threadSummary",
  "contradictionSummary",
  "charDescription",
  "userPersona",
];

const INPUT_REGEX_STAGE_BY_FIELD = {
  userMessage: "input.userMessage",
  recentMessages: "input.recentMessages",
  chatMessages: "input.recentMessages",
  dialogueText: "input.recentMessages",
  candidateText: "input.candidateText",
  candidateNodes: "input.candidateText",
  nodeContent: "input.candidateText",
  eventSummary: "input.candidateText",
  characterSummary: "input.candidateText",
  threadSummary: "input.candidateText",
  contradictionSummary: "input.candidateText",
};

const INPUT_REGEX_ROLE_BY_FIELD = {
  userMessage: "user",
  recentMessages: "mixed",
  chatMessages: "mixed",
  dialogueText: "mixed",
};

function cloneRuntimeDebugValue(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

function getRuntimeDebugState() {
  const stateKey = "__stBmeRuntimeDebugState";
  if (
    !globalThis[stateKey] ||
    typeof globalThis[stateKey] !== "object"
  ) {
    globalThis[stateKey] = {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      updatedAt: "",
    };
  }
  return globalThis[stateKey];
}

function recordTaskPromptBuild(taskType, snapshot = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  const state = getRuntimeDebugState();
  state.taskPromptBuilds[normalizedTaskType] = {
    updatedAt: new Date().toISOString(),
    ...cloneRuntimeDebugValue(snapshot, {}),
  };
  state.updatedAt = new Date().toISOString();
}

function mergeRegexCollectors(...collectors) {
  const mergedEntries = [];
  for (const collector of collectors) {
    if (!Array.isArray(collector?.entries)) {
      continue;
    }
    mergedEntries.push(...collector.entries);
  }
  return {
    entries: mergedEntries,
  };
}

export function buildTaskExecutionDebugContext(
  promptBuild = null,
  options = {},
) {
  const promptDebug = promptBuild?.debug || {};
  const worldInfoDebug =
    promptBuild?.worldInfo?.debug || promptBuild?.worldInfoResolution?.debug || {};
  const worldInfoHit =
    Number(promptDebug.worldInfoBeforeCount || 0) +
      Number(promptDebug.worldInfoAfterCount || 0) +
      Number(promptDebug.worldInfoAtDepthCount || 0) >
    0;

  return {
    promptAssembly: {
      mode: "ordered-private-messages",
      hostInjectionPlanMode:
        promptDebug.hostInjectionPlanMode || "diagnostic-plan-only",
      privateTaskMessageCount: Number(
        promptDebug.executionMessageCount ??
          promptBuild?.executionMessages?.length ??
          promptDebug.privateTaskMessageCount ??
          promptBuild?.privateTaskMessages?.length ??
          0,
      ),
    },
    promptBuild: {
      taskType: String(promptDebug.taskType || ""),
      profileId: String(promptDebug.profileId || ""),
      profileName: String(promptDebug.profileName || ""),
      renderedBlockCount: Number(promptDebug.renderedBlockCount || 0),
      privateTaskMessageCount: Number(promptDebug.privateTaskMessageCount || 0),
    },
    effectiveDelivery:
      promptDebug.effectiveDelivery && typeof promptDebug.effectiveDelivery === "object"
        ? cloneRuntimeDebugValue(promptDebug.effectiveDelivery, {})
        : null,
    ejsRuntimeStatus: String(
      promptDebug.ejsRuntimeStatus || worldInfoDebug.ejsRuntimeStatus || "",
    ),
    worldInfo: {
      requested: promptDebug.worldInfoRequested !== false,
      hit: worldInfoHit,
      cacheHit: Boolean(promptDebug.worldInfoCacheHit),
      beforeCount: Number(promptDebug.worldInfoBeforeCount || 0),
      afterCount: Number(promptDebug.worldInfoAfterCount || 0),
      atDepthCount: Number(promptDebug.worldInfoAtDepthCount || 0),
      loadMs: Number(worldInfoDebug.loadMs || 0),
    },
    mvu:
      promptDebug.mvu && typeof promptDebug.mvu === "object"
        ? cloneRuntimeDebugValue(promptDebug.mvu, {})
        : null,
    regexInput:
      (() => {
        const merged = mergeRegexCollectors(
          promptBuild?.regexInput,
          options.regexInput,
        );
        return Array.isArray(merged.entries) && merged.entries.length > 0
          ? cloneRuntimeDebugValue(merged, {})
          : null;
      })(),
  };
}

function getByPath(target, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function normalizeRole(role) {
  const value = String(role || "system").toLowerCase();
  if (["system", "user", "assistant"].includes(value)) {
    return value;
  }
  return "system";
}

function normalizeInjectionMode(mode) {
  const value = String(mode || "append").toLowerCase();
  if (["prepend", "append", "relative"].includes(value)) {
    return value;
  }
  return "append";
}

function createExecutionMessage(
  role,
  content,
  extra = {},
) {
  const trimmedContent = String(content || "").trim();
  if (!trimmedContent) {
    return null;
  }
  return {
    role: normalizeRole(role),
    content: trimmedContent,
    ...extra,
  };
}

function stringifyInterpolatedValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildEmptyWorldInfoContext() {
  return {
    worldInfoBefore: "",
    worldInfoAfter: "",
    worldInfoBeforeEntries: [],
    worldInfoAfterEntries: [],
    worldInfoAtDepthEntries: [],
    activatedWorldInfoNames: [],
    taskAdditionalMessages: [],
    worldInfoDebug: null,
  };
}

function createEmptyMvuPromptDebug() {
  return {
    sanitizedFieldCount: 0,
    sanitizedFields: [],
    finalMessageStripCount: 0,
    worldInfoBlockedContentHits: 0,
  };
}

function pushMvuPromptDebugEntry(debugState, entry = {}) {
  if (!debugState || !entry || (!entry.changed && !entry.dropped)) {
    return;
  }

  debugState.sanitizedFields.push({
    name: String(entry.name || ""),
    stage: String(entry.stage || ""),
    changed: Boolean(entry.changed),
    dropped: Boolean(entry.dropped),
    reasons: Array.isArray(entry.reasons) ? [...entry.reasons] : [],
    blockedHitCount: Number(entry.blockedHitCount || 0),
  });
  debugState.sanitizedFieldCount = debugState.sanitizedFields.length;
}

function sanitizeTaskPromptText(
  settings = {},
  taskType,
  text,
  {
    mode = "aggressive",
    blockedContents = [],
    regexStage = "",
    role = "system",
    regexCollector = null,
    applyMvu = true,
  } = {},
) {
  const originalText = typeof text === "string" ? text : "";
  const mvuResult = applyMvu
    ? sanitizeMvuContent(originalText, {
        mode,
        blockedContents,
      })
    : {
        text: originalText,
        changed: false,
        dropped: false,
        reasons: [],
        blockedHitCount: 0,
        artifactRemovedCount: 0,
      };
  const afterMvu = String(mvuResult.text || "");
  const finalText = regexStage
    ? applyTaskRegex(
        settings,
        taskType,
        regexStage,
        afterMvu,
        regexCollector,
        role,
      )
    : afterMvu;

  return {
    text: finalText,
    changed: finalText !== originalText,
    dropped: Boolean(mvuResult.dropped),
    reasons: Array.isArray(mvuResult.reasons) ? mvuResult.reasons : [],
    blockedHitCount: Number(mvuResult.blockedHitCount || 0),
    artifactRemovedCount: Number(mvuResult.artifactRemovedCount || 0),
  };
}

function joinStructuredPath(basePath = "", segment = "") {
  const normalizedSegment = String(segment || "");
  if (!normalizedSegment) {
    return basePath;
  }
  if (!basePath) {
    return normalizedSegment.startsWith("[")
      ? normalizedSegment.slice(1, -1)
      : normalizedSegment;
  }
  return normalizedSegment.startsWith("[")
    ? `${basePath}${normalizedSegment}`
    : `${basePath}.${normalizedSegment}`;
}

function looksLikeMvuStateContainer(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => looksLikeMvuStateContainer(item, seen));
  }

  const keys = Object.keys(value).map((key) =>
    String(key || "").trim().toLowerCase(),
  );
  if (
    keys.some((key) =>
      ["stat_data", "display_data", "delta_data", "$internal"].includes(key),
    )
  ) {
    return true;
  }

  return Object.values(value).some((item) =>
    looksLikeMvuStateContainer(item, seen),
  );
}

function getMvuObjectKeyStripReason(key, value) {
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (
    ["stat_data", "display_data", "delta_data", "$internal"].includes(
      normalizedKey,
    )
  ) {
    return "mvu_state_key_removed";
  }
  if (
    ["variables", "message_variables", "chat_variables"].includes(normalizedKey) &&
    looksLikeMvuStateContainer(value)
  ) {
    return "mvu_variables_container_removed";
  }
  return "";
}

function sanitizeStructuredPromptValue(
  settings = {},
  taskType,
  value,
  {
    fieldName = "",
    path = fieldName,
    mode = "aggressive",
    blockedContents = [],
    regexStage = "",
    role = "system",
    debugState = null,
    regexCollector = null,
    applyMvu = true,
    stripMvuContainers = true,
    seen = new WeakSet(),
  } = {},
) {
  if (typeof value === "string") {
    const sanitized = sanitizeTaskPromptText(settings, taskType, value, {
      mode,
      blockedContents,
      regexStage,
      role,
      regexCollector,
      applyMvu,
    });
    pushMvuPromptDebugEntry(debugState, {
      name: path || fieldName,
      stage: regexStage,
      ...sanitized,
    });
    return {
      value: sanitized.text,
      changed: Boolean(sanitized.changed || sanitized.dropped),
      omit:
        !String(sanitized.text || "").trim() &&
        String(value || "").trim().length > 0,
    };
  }

  if (Array.isArray(value)) {
    const sanitizedArray = [];
    let changed = false;
    for (let index = 0; index < value.length; index += 1) {
      const childResult = sanitizeStructuredPromptValue(
        settings,
        taskType,
        value[index],
        {
          fieldName,
          path: joinStructuredPath(path, `[${index}]`),
          mode,
          blockedContents,
          regexStage,
          role,
          debugState,
          regexCollector,
          applyMvu,
          stripMvuContainers,
          seen,
        },
      );
      if (childResult.omit) {
        changed = true;
        continue;
      }
      sanitizedArray.push(childResult.value);
      if (childResult.changed) {
        changed = true;
      }
    }
    return {
      value: sanitizedArray,
      changed: changed || sanitizedArray.length !== value.length,
      omit: value.length > 0 && sanitizedArray.length === 0,
    };
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return {
        value,
        changed: false,
        omit: false,
      };
    }
    seen.add(value);

    const originalLooksMvuContainer = looksLikeMvuStateContainer(value);
    const sanitizedObject = {};
    let changed = false;
    let keptEntries = 0;

    for (const [key, entryValue] of Object.entries(value)) {
      const stripReason = stripMvuContainers
        ? getMvuObjectKeyStripReason(key, entryValue)
        : "";
      if (stripReason) {
        changed = true;
        pushMvuPromptDebugEntry(debugState, {
          name: joinStructuredPath(path, key),
          stage: regexStage,
          changed: true,
          dropped: true,
          reasons: [stripReason],
          blockedHitCount: 0,
        });
        continue;
      }

      const childResult = sanitizeStructuredPromptValue(
        settings,
        taskType,
        entryValue,
        {
          fieldName,
          path: joinStructuredPath(path, key),
          mode,
          blockedContents,
          regexStage,
          role,
          debugState,
          regexCollector,
          applyMvu,
          stripMvuContainers,
          seen,
        },
      );
      if (childResult.omit) {
        changed = true;
        continue;
      }
      sanitizedObject[key] = childResult.value;
      keptEntries += 1;
      if (childResult.changed) {
        changed = true;
      }
    }

    return {
      value: sanitizedObject,
      changed,
      omit: originalLooksMvuContainer && keptEntries === 0,
    };
  }

  return {
    value,
    changed: false,
    omit: false,
  };
}

function sanitizePromptMessages(
  settings = {},
  taskType,
  messages = [],
  {
    blockedContents = [],
    regexStage = "",
    debugState = null,
    regexCollector = null,
  } = {},
) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const sanitized = sanitizeStructuredPromptValue(
        settings,
        taskType,
        message,
        {
          fieldName: "message",
          path: `message[${index}]`,
          mode: "final-safe",
          blockedContents,
          regexStage,
          role: message?.role || "system",
          debugState,
          regexCollector,
        },
      );
      if (debugState && (sanitized.changed || sanitized.omit)) {
        debugState.finalMessageStripCount += 1;
      }
      if (sanitized.omit) {
        return null;
      }
      const executionMessage = createExecutionMessage(
        sanitized.value?.role || message?.role,
        sanitized.value?.content,
        {
          source: String(sanitized.value?.source || message?.source || ""),
          blockId: String(sanitized.value?.blockId || message?.blockId || ""),
          blockName: String(
            sanitized.value?.blockName || message?.blockName || "",
          ),
          blockType: String(
            sanitized.value?.blockType || message?.blockType || "",
          ),
          sourceKey: String(
            sanitized.value?.sourceKey || message?.sourceKey || "",
          ),
          injectionMode: String(
            sanitized.value?.injectionMode || message?.injectionMode || "",
          ),
        },
      );
      return executionMessage;
    })
    .filter(Boolean);
}

function sanitizePromptContextInputs(
  settings = {},
  taskType,
  context = {},
  debugState = null,
  regexCollector = null,
  options = {},
) {
  const sanitizedContext = {
    ...context,
  };
  const {
    applyMvu = true,
    stripMvuContainers = applyMvu,
  } = options || {};

  for (const fieldName of INPUT_CONTEXT_MVU_FIELDS) {
    if (!(fieldName in sanitizedContext)) {
      continue;
    }
    const value = sanitizedContext[fieldName];
    const regexStage = INPUT_REGEX_STAGE_BY_FIELD[fieldName] || "";
    const regexRole = INPUT_REGEX_ROLE_BY_FIELD[fieldName] || "system";
    const sanitized = sanitizeStructuredPromptValue(
      settings,
      taskType,
      value,
      {
        fieldName,
        path: fieldName,
        mode: "aggressive",
        regexStage,
        role: regexRole,
        debugState,
        regexCollector,
        applyMvu,
        stripMvuContainers,
      },
    );
    sanitizedContext[fieldName] = sanitized.omit
      ? Array.isArray(value)
        ? []
        : typeof value === "string"
          ? ""
          : null
      : sanitized.value;
  }

  return sanitizedContext;
}

function sanitizeWorldInfoEntries(
  settings = {},
  taskType,
  entries = [],
  blockedContents = [],
  debugState = null,
  regexCollector = null,
) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const sanitized = sanitizeTaskPromptText(
        settings,
        taskType,
        String(entry?.content || ""),
        {
          mode: "aggressive",
          blockedContents,
          regexStage: "",
          role: entry?.role || "system",
          regexCollector,
        },
      );
      debugState.worldInfoBlockedContentHits += sanitized.blockedHitCount;
      if (sanitized.changed || sanitized.dropped) {
        debugState.finalMessageStripCount += 1;
      }
      if (!sanitized.text.trim()) {
        return null;
      }
      return {
        ...entry,
        content: sanitized.text,
        index:
          Number.isFinite(Number(entry?.index))
            ? Number(entry.index)
            : index,
      };
    })
    .filter(Boolean);
}

function sanitizeWorldInfoContext(
  settings = {},
  taskType,
  worldInfo = null,
  debugState = null,
  regexCollector = null,
) {
  const rawDebug =
    worldInfo?.debug && typeof worldInfo.debug === "object"
      ? worldInfo.debug
      : null;
  const blockedContentsCount = Number(rawDebug?.mvu?.blockedContentsCount || 0);
  const blockedContents = [];
  if (blockedContentsCount > 0 && Array.isArray(rawDebug?.mvu?.filteredEntries)) {
    // Use only the structural count for debug; blocked content strings stay internal
    // on the world info object via the non-enumerable runtime property below.
  }

  const runtimeBlockedContents = Array.isArray(worldInfo?.__mvuBlockedContents)
    ? worldInfo.__mvuBlockedContents
    : [];

  const beforeEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.beforeEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
  );
  const afterEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.afterEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
  );
  const atDepthEntries = sanitizeWorldInfoEntries(
    settings,
    taskType,
    worldInfo?.atDepthEntries,
    runtimeBlockedContents,
    debugState,
    regexCollector,
  );
  const additionalMessages = (Array.isArray(worldInfo?.additionalMessages)
    ? worldInfo.additionalMessages
    : []
  )
    .map((message) => {
      const sanitized = sanitizeTaskPromptText(
        settings,
        taskType,
        String(message?.content || ""),
        {
          mode: "aggressive",
          blockedContents: runtimeBlockedContents,
          regexStage: "",
          role: message?.role || "system",
          regexCollector,
        },
      );
      debugState.worldInfoBlockedContentHits += sanitized.blockedHitCount;
      if (sanitized.changed || sanitized.dropped) {
        debugState.finalMessageStripCount += 1;
      }
      if (!sanitized.text.trim()) {
        return null;
      }
      return {
        ...message,
        content: sanitized.text,
      };
    })
    .filter(Boolean);

  const beforeText = beforeEntries.map((entry) => entry.content).join("\n\n");
  const afterText = afterEntries.map((entry) => entry.content).join("\n\n");
  const activatedEntryNames = [
    ...beforeEntries.map((entry) => entry.name),
    ...afterEntries.map((entry) => entry.name),
    ...atDepthEntries.map((entry) => entry.name),
  ].filter(Boolean);

  const sanitizedWorldInfo = {
    beforeEntries,
    afterEntries,
    atDepthEntries,
    beforeText,
    afterText,
    additionalMessages,
    activatedEntryNames: [...new Set(activatedEntryNames)],
    debug: rawDebug,
  };

  Object.defineProperty(sanitizedWorldInfo, "__mvuBlockedContents", {
    value: [...runtimeBlockedContents],
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return sanitizedWorldInfo;
}

function createHostInjectionEntry(
  entry = {},
  position = "after",
  source = "worldInfo",
) {
  return {
    source,
    position,
    role: normalizeRole(entry.role),
    content: String(entry.content || "").trim(),
    name: String(entry.name || ""),
    sourceName: String(entry.sourceName || entry.name || ""),
    worldbook: String(entry.worldbook || ""),
    depth:
      position === "atDepth" && Number.isFinite(Number(entry.depth))
        ? Number(entry.depth)
        : null,
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
  };
}

function buildWorldInfoResolution(worldInfoContext = {}) {
  const beforeEntries = Array.isArray(worldInfoContext.worldInfoBeforeEntries)
    ? worldInfoContext.worldInfoBeforeEntries
    : [];
  const afterEntries = Array.isArray(worldInfoContext.worldInfoAfterEntries)
    ? worldInfoContext.worldInfoAfterEntries
    : [];
  const atDepthEntries = Array.isArray(worldInfoContext.worldInfoAtDepthEntries)
    ? worldInfoContext.worldInfoAtDepthEntries
    : [];
  const additionalMessages = Array.isArray(worldInfoContext.taskAdditionalMessages)
    ? worldInfoContext.taskAdditionalMessages
    : [];

  return {
    beforeText: String(worldInfoContext.worldInfoBefore || ""),
    afterText: String(worldInfoContext.worldInfoAfter || ""),
    beforeEntries,
    afterEntries,
    atDepthEntries,
    activatedEntryNames: Array.isArray(worldInfoContext.activatedWorldInfoNames)
      ? worldInfoContext.activatedWorldInfoNames
      : [],
    additionalMessages,
    debug:
      worldInfoContext.worldInfoDebug &&
      typeof worldInfoContext.worldInfoDebug === "object"
        ? worldInfoContext.worldInfoDebug
        : null,
    injections: {
      before: beforeEntries
        .map((entry) => createHostInjectionEntry(entry, "before"))
        .filter((entry) => entry.content),
      after: afterEntries
        .map((entry) => createHostInjectionEntry(entry, "after"))
        .filter((entry) => entry.content),
      atDepth: atDepthEntries
        .map((entry) => createHostInjectionEntry(entry, "atDepth"))
        .filter((entry) => entry.content),
    },
  };
}

function sortInjectionEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const orderLeft = Number.isFinite(Number(left?.order))
      ? Number(left.order)
      : 0;
    const orderRight = Number.isFinite(Number(right?.order))
      ? Number(right.order)
      : 0;
    return orderLeft - orderRight;
  });
}

function createHostInjectionPlanEntry(block = {}, position, extra = {}) {
  return {
    source: "block",
    origin: "profile-block",
    position,
    role: normalizeRole(block.role),
    content: String(block.content || "").trim(),
    blockId: String(block.id || ""),
    blockName: String(block.name || ""),
    sourceKey: String(block.sourceKey || ""),
    injectionMode: normalizeInjectionMode(block.injectionMode),
    order: Number.isFinite(Number(block.order)) ? Number(block.order) : 0,
    ...extra,
  };
}

function buildHostInjectionPlan(renderedBlocks = [], worldInfoResolution = {}) {
  const beforeEntryNames = (
    Array.isArray(worldInfoResolution.beforeEntries)
      ? worldInfoResolution.beforeEntries
      : []
  )
    .map((entry) => String(entry?.name || entry?.sourceName || "").trim())
    .filter(Boolean);
  const afterEntryNames = (
    Array.isArray(worldInfoResolution.afterEntries)
      ? worldInfoResolution.afterEntries
      : []
  )
    .map((entry) => String(entry?.name || entry?.sourceName || "").trim())
    .filter(Boolean);
  const atDepthEntries = Array.isArray(worldInfoResolution.injections?.atDepth)
    ? worldInfoResolution.injections.atDepth
    : [];

  const plan = {
    before: [],
    after: [],
    atDepth: [],
  };

  for (const block of renderedBlocks) {
    if (!block?.content) continue;

    if (
      block.type === "builtin" &&
      String(block.sourceKey || "") === "worldInfoBefore"
    ) {
      plan.before.push(
        createHostInjectionPlanEntry(block, "before", {
          entryNames: beforeEntryNames,
          entryCount: beforeEntryNames.length,
        }),
      );
      continue;
    }

    if (
      block.type === "builtin" &&
      String(block.sourceKey || "") === "worldInfoAfter"
    ) {
      plan.after.push(
        createHostInjectionPlanEntry(block, "after", {
          entryNames: afterEntryNames,
          entryCount: afterEntryNames.length,
        }),
      );
    }
  }

  for (const entry of atDepthEntries) {
    if (!entry?.content) continue;
    plan.atDepth.push({
      ...entry,
      origin: "worldInfo-entry",
      entryName: String(entry.name || entry.sourceName || "").trim(),
    });
  }

  return {
    before: sortInjectionEntries(plan.before),
    after: sortInjectionEntries(plan.after),
    atDepth: sortInjectionEntries(plan.atDepth),
  };
}

function resolveBlockDelivery(block = {}) {
  return normalizeRole(block.role) === "system"
    ? "private.system"
    : "private.message";
}

function getBlockDiagnosticInjectionPosition(block = {}) {
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoBefore"
  ) {
    return "before";
  }
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoAfter"
  ) {
    return "after";
  }
  return "";
}

function profileRequiresWorldInfo(profile) {
  if (
    profile?.worldInfo === false ||
    profile?.metadata?.disableWorldInfo === true
  ) {
    return false;
  }

  const blocks = Array.isArray(profile?.blocks) ? profile.blocks : [];
  for (const block of blocks) {
    if (!block || block.enabled === false) continue;
    if (
      block.type === "builtin" &&
      ["worldInfoBefore", "worldInfoAfter"].includes(String(block.sourceKey || ""))
    ) {
      return true;
    }

    const rawContent = String(block.content || "");
    if (!rawContent.includes("{{")) continue;
    if (
      WORLD_INFO_VARIABLE_KEYS.some((key) =>
        rawContent.includes(`{{${key}}}`) ||
        rawContent.includes(`{{ ${key} }}`),
      )
    ) {
      return true;
    }
  }

  // atDepth world info is implicit in the final message chain, so profiles
  // without explicit before/after placeholders should still resolve lore.
  return blocks.some((block) => block && block.enabled !== false);
}

function extractWorldInfoChatMessages(context = {}) {
  if (Array.isArray(context.chatMessages)) {
    return context.chatMessages;
  }
  return [];
}

export async function buildTaskPrompt(settings = {}, taskType, context = {}) {
  const profile = getActiveTaskProfile(settings, taskType);
  const legacyPrompt = getLegacyPromptForTask(settings, taskType);
  const promptRegexInput = { entries: [] };
  const worldInfoRegexInput = { entries: [] };
  const mvuPromptDebug = createEmptyMvuPromptDebug();
  const worldInfoInputContext = sanitizePromptContextInputs(
    settings,
    taskType,
    context,
    null,
    worldInfoRegexInput,
    {
      applyMvu: false,
      stripMvuContainers: false,
    },
  );
  const sanitizedInputContext = sanitizePromptContextInputs(
    settings,
    taskType,
    context,
    mvuPromptDebug,
    promptRegexInput,
  );
  const rawBlocks = Array.isArray(profile?.blocks) ? profile.blocks : [];
  const blocks = rawBlocks
    .map((block, index) => ({ ...block, _orderIndex: index }))
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.order))
        ? Number(a.order)
        : a._orderIndex;
      const orderB = Number.isFinite(Number(b.order))
        ? Number(b.order)
        : b._orderIndex;
      return orderA - orderB;
    });

  const worldInfoRequested = profileRequiresWorldInfo(profile);
  const emptyWorldInfo = buildEmptyWorldInfoContext();
  let resolvedWorldInfo = emptyWorldInfo;
  let worldInfoRuntimeBlockedContents = [];

  if (worldInfoRequested) {
    const worldInfo = await resolveTaskWorldInfo({
      settings,
      chatMessages: extractWorldInfoChatMessages(worldInfoInputContext),
      userMessage: String(worldInfoInputContext.userMessage || ""),
      templateContext: worldInfoInputContext,
    });
    const sanitizedWorldInfo = sanitizeWorldInfoContext(
      settings,
      taskType,
      worldInfo,
      mvuPromptDebug,
      promptRegexInput,
    );
    worldInfoRuntimeBlockedContents = Array.isArray(
      sanitizedWorldInfo.__mvuBlockedContents,
    )
      ? sanitizedWorldInfo.__mvuBlockedContents
      : [];
    resolvedWorldInfo = {
      worldInfoBefore: sanitizedWorldInfo.beforeText || "",
      worldInfoAfter: sanitizedWorldInfo.afterText || "",
      worldInfoBeforeEntries: sanitizedWorldInfo.beforeEntries || [],
      worldInfoAfterEntries: sanitizedWorldInfo.afterEntries || [],
      worldInfoAtDepthEntries: sanitizedWorldInfo.atDepthEntries || [],
      activatedWorldInfoNames: sanitizedWorldInfo.activatedEntryNames || [],
      taskAdditionalMessages: sanitizedWorldInfo.additionalMessages || [],
      worldInfoDebug: sanitizedWorldInfo.debug || null,
    };
  }

  const resolvedContext = {
    ...sanitizedInputContext,
    ...emptyWorldInfo,
    ...resolvedWorldInfo,
  };
  const worldInfoResolution = buildWorldInfoResolution(resolvedContext);

  let systemPrompt = "";
  const customMessages = [];
  const executionMessages = [];
  const renderedBlocks = [];
  let userRoleBlockCount = 0;
  let assistantRoleBlockCount = 0;
  let systemRoleBlockCount = 0;

  console.log(
    `[ST-BME][prompt-diag] buildTaskPrompt: taskType=${taskType}, ` +
      `total blocks=${blocks.length}, ` +
      `block roles=[${blocks.map((b) => `${b.name}(${b.role},${b.enabled !== false ? "on" : "off"})`).join(", ")}]`,
  );

  for (const block of blocks) {
    if (!block || block.enabled === false) continue;

    const role = normalizeRole(block.role);
    let content = "";

    if (block.type === "legacyPrompt") {
      content = legacyPrompt || block.content || "";
    } else if (block.type === "builtin") {
      if (block.content) {
        content = interpolateVariables(block.content, resolvedContext);
      } else if (block.sourceKey) {
        content = stringifyInterpolatedValue(
          getByPath(resolvedContext, block.sourceKey),
        );
      }
    } else if (block.type === "custom") {
      content = interpolateVariables(block.content || "", resolvedContext);
    }

    if (role === "user") {
      console.log(
        `[ST-BME][prompt-diag] user block "${block.name || block.id}": ` +
          `type=${block.type}, contentLen=${String(content || "").length}, ` +
          `rawContentLen=${String(block.content || "").length}, ` +
          `blockedContentsCount=${worldInfoRuntimeBlockedContents.length}`,
      );
    }

    const sanitizedBlockContent = sanitizeTaskPromptText(
      settings,
      taskType,
      content,
      {
        mode: "final-safe",
        blockedContents: worldInfoRuntimeBlockedContents,
        regexStage: "",
        role,
        regexCollector: promptRegexInput,
      },
    );
    mvuPromptDebug.worldInfoBlockedContentHits +=
      sanitizedBlockContent.blockedHitCount;
    if (sanitizedBlockContent.changed || sanitizedBlockContent.dropped) {
      mvuPromptDebug.finalMessageStripCount += 1;
    }
    content = sanitizedBlockContent.text;

    if (!String(content || "").trim()) {
      if (role === "user" && String(block.content || "").trim()) {
        console.warn(
          `[ST-BME] buildTaskPrompt: user block "${block.name || block.id}" ` +
            `content emptied during sanitization! ` +
            `original length=${String(block.content || "").length}, ` +
            `dropped=${sanitizedBlockContent.dropped}, ` +
            `reasons=[${(sanitizedBlockContent.reasons || []).join(", ")}], ` +
            `blockedHitCount=${sanitizedBlockContent.blockedHitCount}`,
        );
      }
      continue;
    }

    const mode = normalizeInjectionMode(block.injectionMode);
    renderedBlocks.push({
      id: String(block.id || ""),
      name: String(block.name || ""),
      type: String(block.type || "custom"),
      role,
      sourceKey: String(block.sourceKey || ""),
      sourceField: String(block.sourceField || ""),
      content,
      order: Number.isFinite(Number(block.order))
        ? Number(block.order)
        : block._orderIndex,
      injectionMode: mode,
      delivery: resolveBlockDelivery(block),
      effectiveDelivery: resolveBlockDelivery(block),
      diagnosticInjectionPosition: getBlockDiagnosticInjectionPosition(block),
    });

    const executionMessage = createExecutionMessage(role, content, {
      source: "profile-block",
      blockId: String(block.id || ""),
      blockName: String(block.name || ""),
      blockType: String(block.type || "custom"),
      sourceKey: String(block.sourceKey || ""),
      injectionMode: mode,
    });
    if (executionMessage) {
      executionMessages.push(executionMessage);
    }

    if (role === "system") {
      systemRoleBlockCount += 1;
      if (!systemPrompt) {
        systemPrompt = content;
      } else if (mode === "prepend") {
        systemPrompt = `${content}\n\n${systemPrompt}`;
      } else {
        systemPrompt = `${systemPrompt}\n\n${content}`;
      }
      continue;
    }

    if (role === "user") {
      userRoleBlockCount += 1;
    } else if (role === "assistant") {
      assistantRoleBlockCount += 1;
    }
    if (mode === "prepend") {
      customMessages.unshift({ role, content });
    } else {
      customMessages.push({ role, content });
    }
  }

  console.log(
    `[ST-BME][prompt-diag] buildTaskPrompt done: ` +
      `executionMessages=${executionMessages.length}, ` +
      `userBlocks=${userRoleBlockCount}, systemBlocks=${systemRoleBlockCount}, ` +
      `customMessages=${customMessages.length}`,
  );

  for (const message of worldInfoResolution.additionalMessages || []) {
    const executionMessage = createExecutionMessage(
      message.role,
      message.content,
      {
        source: "worldInfo-atDepth",
      },
    );
    if (executionMessage) {
      executionMessages.push(executionMessage);
    }
  }

  const privateTaskMessages = [
    ...customMessages,
    ...worldInfoResolution.additionalMessages,
  ];
  const hostInjectionPlan = buildHostInjectionPlan(
    renderedBlocks,
    worldInfoResolution,
  );

  const result = {
    profile,
    hostInjections: worldInfoResolution.injections,
    hostInjectionPlan,
    privateTaskPrompt: {
      systemPrompt,
      messages: privateTaskMessages,
    },
    executionMessages,
    privateTaskMessages,
    renderedBlocks,
    regexInput: mergeRegexCollectors(promptRegexInput, worldInfoRegexInput),
    worldInfoResolution,
    systemPrompt,
    customMessages,
    additionalMessages: worldInfoResolution.additionalMessages,
    worldInfo: {
      beforeText: worldInfoResolution.beforeText,
      afterText: worldInfoResolution.afterText,
      beforeEntries: worldInfoResolution.beforeEntries,
      afterEntries: worldInfoResolution.afterEntries,
      atDepthEntries: worldInfoResolution.atDepthEntries,
      activatedEntryNames: worldInfoResolution.activatedEntryNames,
      debug: worldInfoResolution.debug,
    },
    debug: {
      taskType,
      profileId: profile?.id || "",
      profileName: profile?.name || "",
      usedLegacyPrompt: Boolean(legacyPrompt),
      blockCount: blocks.length,
      renderedBlockCount: renderedBlocks.length,
      worldInfoRequested,
      worldInfoBeforeCount: worldInfoResolution.beforeEntries.length,
      worldInfoAfterCount: worldInfoResolution.afterEntries.length,
      worldInfoAtDepthCount: worldInfoResolution.atDepthEntries.length,
      hostInjectionCount:
        worldInfoResolution.injections.before.length +
        worldInfoResolution.injections.after.length +
        worldInfoResolution.injections.atDepth.length,
      hostInjectionPlanCount:
        hostInjectionPlan.before.length +
        hostInjectionPlan.after.length +
        hostInjectionPlan.atDepth.length,
      hostInjectionPlanMode: "diagnostic-plan-only",
      customMessageCount: customMessages.length,
      additionalMessageCount: worldInfoResolution.additionalMessages.length,
      privateTaskMessageCount: privateTaskMessages.length,
      executionMessageCount: executionMessages.length,
      userRoleBlockCount,
      assistantRoleBlockCount,
      systemRoleBlockCount,
      effectiveDelivery: {
        profileBlocks: "ordered-private-messages",
        worldInfoBeforeAfter: "inline-in-ordered-messages",
        worldInfoAtDepth: "appended-private-messages",
      },
      worldInfoCacheHit: Boolean(worldInfoResolution.debug?.cache?.hit),
      ejsRuntimeStatus: worldInfoResolution.debug?.ejsRuntimeStatus || "",
      mvu: {
        sanitizedFieldCount: mvuPromptDebug.sanitizedFieldCount,
        sanitizedFields: cloneRuntimeDebugValue(
          mvuPromptDebug.sanitizedFields,
          [],
        ),
        finalMessageStripCount: mvuPromptDebug.finalMessageStripCount,
        worldInfoBlockedContentHits: mvuPromptDebug.worldInfoBlockedContentHits,
      },
      effectivePath: {
        promptAssembly: "ordered-private-messages",
        hostInjectionPlan: "diagnostic-plan-only",
        worldInfoInputContext: "raw-context-for-trigger-and-ejs",
        ejs:
          worldInfoResolution.debug?.ejsRuntimeStatus ||
          "unknown",
        worldInfo:
          worldInfoRequested !== false
            ? worldInfoResolution.activatedEntryNames.length > 0
              ? "matched"
              : "requested-but-missed"
            : "disabled",
      },
    },
  };

  Object.defineProperty(result, "__mvuRuntime", {
    value: {
      blockedContents: [...worldInfoRuntimeBlockedContents],
    },
    configurable: true,
    enumerable: false,
    writable: false,
  });

  recordTaskPromptBuild(taskType, {
    taskType,
    profileId: profile?.id || "",
    profileName: profile?.name || "",
    systemPrompt,
    privateTaskMessages,
    executionMessages,
    renderedBlocks,
    hostInjections: worldInfoResolution.injections,
    hostInjectionPlan,
    worldInfoResolution,
    mvu: result.debug.mvu,
    regexInput: result.regexInput,
    debug: result.debug,
  });

  return result;
}

export function buildTaskLlmPayload(promptBuild = null, fallbackUserPrompt = "") {
  const runtimeMvu = promptBuild?.__mvuRuntime || {};
  const taskType = String(promptBuild?.debug?.taskType || "");
  const blockedContents = Array.isArray(runtimeMvu?.blockedContents)
    ? runtimeMvu.blockedContents
    : [];
  const rawExecutionMessages = Array.isArray(promptBuild?.executionMessages)
    ? promptBuild.executionMessages
        .map((message) =>
          createExecutionMessage(message.role, message.content, {
            source: String(message.source || ""),
            blockId: String(message.blockId || ""),
            blockName: String(message.blockName || ""),
            blockType: String(message.blockType || ""),
            sourceKey: String(message.sourceKey || ""),
            injectionMode: String(message.injectionMode || ""),
          }),
        )
        .filter(Boolean)
    : [];
  const executionMessages = sanitizePromptMessages(
    {},
    taskType,
    rawExecutionMessages,
    {
      blockedContents,
      regexStage: "",
    },
  );

  const hasUserMessage = executionMessages.some(
    (message) => message.role === "user",
  );
  if (!hasUserMessage && rawExecutionMessages.length > 0) {
    const userBlocksBefore = (promptBuild?.executionMessages || []).filter(
      (m) => m?.role === "user",
    );
    const userBlocksAfterRaw = rawExecutionMessages.filter(
      (m) => m?.role === "user",
    );
    const userBlocksAfterSanitize = executionMessages.filter(
      (m) => m?.role === "user",
    );
    console.warn(
      `[ST-BME] buildTaskLlmPayload fallback triggered: ` +
        `user blocks in promptBuild=${userBlocksBefore.length}, ` +
        `after recreate=${userBlocksAfterRaw.length}, ` +
        `after sanitize=${userBlocksAfterSanitize.length}, ` +
        `blockedContents count=${blockedContents.length}, ` +
        `total executionMessages=${executionMessages.length}`,
    );
    if (userBlocksBefore.length > 0) {
      for (const block of userBlocksBefore) {
        console.warn(
          `[ST-BME]   user block "${block.blockName || block.blockId}": ` +
            `content length=${String(block.content || "").length}, ` +
            `content preview="${String(block.content || "").slice(0, 80)}..."`,
        );
      }
    }
    if (blockedContents.length > 0) {
      console.warn(
        `[ST-BME]   blockedContents lengths: [${blockedContents.map((c) => String(c || "").length).join(", ")}]`,
      );
    }
  }
  const sanitizedFallbackUserPrompt = sanitizeTaskPromptText(
    {},
    promptBuild?.debug?.taskType || "",
    String(fallbackUserPrompt || ""),
    {
      mode: "final-safe",
      blockedContents,
      regexStage: "",
    },
  ).text;
  const additionalMessages =
    executionMessages.length > 0
      ? []
      : sanitizePromptMessages(
          {},
          taskType,
          Array.isArray(promptBuild?.privateTaskMessages)
            ? promptBuild.privateTaskMessages
            : [],
          {
            blockedContents,
            regexStage: "",
          },
        );

  return {
    systemPrompt:
      executionMessages.length > 0 ? "" : String(promptBuild?.systemPrompt || ""),
    userPrompt: hasUserMessage ? "" : sanitizedFallbackUserPrompt,
    promptMessages: executionMessages,
    additionalMessages,
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return stringifyInterpolatedValue(getByPath(context, key));
  });
}
