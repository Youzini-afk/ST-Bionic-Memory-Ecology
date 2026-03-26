// ST-BME: Prompt Builder
// 统一负责任务预设块排序、变量渲染，以及世界书/EJS 上下文接入。

import { getActiveTaskProfile, getLegacyPromptForTask } from "./prompt-profiles.js";
import { resolveTaskWorldInfo } from "./task-worldinfo.js";

const WORLD_INFO_VARIABLE_KEYS = [
  "worldInfoBefore",
  "worldInfoAfter",
  "worldInfoBeforeEntries",
  "worldInfoAfterEntries",
  "worldInfoAtDepthEntries",
  "activatedWorldInfoNames",
  "taskAdditionalMessages",
];

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
    regexInput:
      options.regexInput && typeof options.regexInput === "object"
        ? cloneRuntimeDebugValue(options.regexInput, {})
        : null,
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
  return false;
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

  if (worldInfoRequested) {
    const worldInfo = await resolveTaskWorldInfo({
      settings,
      chatMessages: extractWorldInfoChatMessages(context),
      userMessage: String(context.userMessage || ""),
      templateContext: context,
    });
    resolvedWorldInfo = {
      worldInfoBefore: worldInfo.beforeText || "",
      worldInfoAfter: worldInfo.afterText || "",
      worldInfoBeforeEntries: worldInfo.beforeEntries || [],
      worldInfoAfterEntries: worldInfo.afterEntries || [],
      worldInfoAtDepthEntries: worldInfo.atDepthEntries || [],
      activatedWorldInfoNames: worldInfo.activatedEntryNames || [],
      taskAdditionalMessages: worldInfo.additionalMessages || [],
      worldInfoDebug: worldInfo.debug || null,
    };
  }

  const resolvedContext = {
    ...context,
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

    if (!String(content || "").trim()) continue;

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
      effectivePath: {
        promptAssembly: "ordered-private-messages",
        hostInjectionPlan: "diagnostic-plan-only",
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
    debug: result.debug,
  });

  return result;
}

export function buildTaskLlmPayload(promptBuild = null, fallbackUserPrompt = "") {
  const executionMessages = Array.isArray(promptBuild?.executionMessages)
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

  const hasUserMessage = executionMessages.some(
    (message) => message.role === "user",
  );

  return {
    systemPrompt: String(promptBuild?.systemPrompt || ""),
    userPrompt: hasUserMessage ? "" : String(fallbackUserPrompt || ""),
    promptMessages: executionMessages,
    additionalMessages:
      executionMessages.length > 0
        ? []
        : Array.isArray(promptBuild?.privateTaskMessages)
          ? promptBuild.privateTaskMessages
          : [],
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return stringifyInterpolatedValue(getByPath(context, key));
  });
}
