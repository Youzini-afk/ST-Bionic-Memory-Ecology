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

  let systemPrompt = "";
  const customMessages = [];

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

  return {
    profile,
    systemPrompt,
    customMessages,
    additionalMessages: resolvedContext.taskAdditionalMessages || [],
    worldInfo: {
      beforeText: resolvedContext.worldInfoBefore,
      afterText: resolvedContext.worldInfoAfter,
      beforeEntries: resolvedContext.worldInfoBeforeEntries,
      afterEntries: resolvedContext.worldInfoAfterEntries,
      atDepthEntries: resolvedContext.worldInfoAtDepthEntries,
      activatedEntryNames: resolvedContext.activatedWorldInfoNames,
    },
    debug: {
      taskType,
      profileId: profile?.id || "",
      profileName: profile?.name || "",
      usedLegacyPrompt: Boolean(legacyPrompt),
      blockCount: blocks.length,
      worldInfoRequested,
      worldInfoBeforeCount: resolvedContext.worldInfoBeforeEntries.length,
      worldInfoAfterCount: resolvedContext.worldInfoAfterEntries.length,
      worldInfoAtDepthCount: resolvedContext.worldInfoAtDepthEntries.length,
      additionalMessageCount: resolvedContext.taskAdditionalMessages.length,
    },
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return stringifyInterpolatedValue(getByPath(context, key));
  });
}
