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

function resolveBlockDelivery(block = {}) {
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoBefore"
  ) {
    return "host.before";
  }
  if (
    block.type === "builtin" &&
    String(block.sourceKey || "") === "worldInfoAfter"
  ) {
    return "host.after";
  }
  return normalizeRole(block.role) === "system"
    ? "private.system"
    : "private.message";
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
  const renderedBlocks = [];

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
    });

    if (role === "system") {
      if (!systemPrompt) {
        systemPrompt = content;
      } else if (mode === "prepend") {
        systemPrompt = `${content}\n\n${systemPrompt}`;
      } else {
        systemPrompt = `${systemPrompt}\n\n${content}`;
      }
      continue;
    }

    if (mode === "prepend") {
      customMessages.unshift({ role, content });
    } else {
      customMessages.push({ role, content });
    }
  }

  const privateTaskMessages = [
    ...customMessages,
    ...worldInfoResolution.additionalMessages,
  ];

  return {
    profile,
    hostInjections: worldInfoResolution.injections,
    privateTaskPrompt: {
      systemPrompt,
      messages: privateTaskMessages,
    },
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
      customMessageCount: customMessages.length,
      additionalMessageCount: worldInfoResolution.additionalMessages.length,
      privateTaskMessageCount: privateTaskMessages.length,
    },
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return stringifyInterpolatedValue(getByPath(context, key));
  });
}
