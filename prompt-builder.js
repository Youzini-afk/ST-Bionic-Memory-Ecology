// ST-BME: Prompt Builder（Phase 1 兼容骨架）

import { getActiveTaskProfile, getLegacyPromptForTask } from "./prompt-profiles.js";

export function buildTaskPrompt(settings = {}, taskType, context = {}) {
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
        content = interpolateVariables(block.content, context);
      } else if (block.sourceKey) {
        const value = getByPath(context, block.sourceKey);
        if (value != null) {
          content =
            typeof value === "string" ? value : JSON.stringify(value, null, 2);
        }
      }
    } else if (block.type === "custom") {
      content = interpolateVariables(block.content || "", context);
    }

    if (!content) continue;
    const mode = normalizeInjectionMode(block.injectionMode);

    if (role === "system") {
      if (!systemPrompt) {
        systemPrompt = content;
      } else if (mode === "prepend") {
        systemPrompt = `${content}\n\n${systemPrompt}`;
      } else {
        systemPrompt = `${systemPrompt}\n\n${content}`;
      }
    } else {
      if (mode === "prepend") {
        customMessages.unshift({ role, content });
      } else {
        customMessages.push({ role, content });
      }
    }
  }

  return {
    profile,
    systemPrompt,
    customMessages,
    debug: {
      taskType,
      profileId: profile?.id || "",
      profileName: profile?.name || "",
      usedLegacyPrompt: Boolean(legacyPrompt),
      blockCount: blocks.length,
    },
  };
}

export function interpolateVariables(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = getByPath(context, key);
    return value == null ? "" : String(value);
  });
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
