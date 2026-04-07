// ST-BME: SillyTavern 上下文数据读取辅助
// 为 prompt 变量扩展（Phase 2）提供统一的 ST 上下文数据接口

import { getContext } from "../../../../extensions.js";

function safeClone(value, fallback) {
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
    return fallback ?? value;
  }
}

function resolveCharacter(ctx) {
  const charId = ctx?.characterId;
  return (
    ctx?.character ||
    ctx?.characters?.[Number(charId)] ||
    ctx?.characters?.[charId] ||
    null
  );
}

function resolvePersona(ctx) {
  return (
    ctx?.powerUserSettings?.persona_description ||
    ctx?.extensionSettings?.persona_description ||
    ctx?.name1_description ||
    ctx?.persona ||
    ""
  );
}

function resolveCharacterDescription(char) {
  return (
    char?.description ||
    char?.data?.description ||
    char?.data?.personality ||
    ""
  );
}

function resolveLastUserMessage(chat = []) {
  return (
    chat.findLast?.((message) => message?.is_user)?.mes ||
    [...chat].reverse().find((message) => message?.is_user)?.mes ||
    ""
  );
}

function buildStructuredSnapshot(ctx = {}) {
  const char = resolveCharacter(ctx);
  const chat = Array.isArray(ctx.chat) ? safeClone(ctx.chat, []) : [];
  const currentTime = new Date().toLocaleString("zh-CN");
  const globalVars = safeClone(
    ctx.extensionSettings?.variables?.global || {},
    {},
  );
  const localVars = safeClone(ctx.chatMetadata?.variables || {}, {});

  return {
    persona: {
      text: resolvePersona(ctx),
      lorebook:
        ctx.extensionSettings?.persona_description_lorebook ||
        ctx.powerUserSettings?.persona_description_lorebook ||
        ctx.power_user?.persona_description_lorebook ||
        "",
    },
    character: {
      id: ctx.characterId ?? null,
      name: ctx.name2 || char?.name || "",
      description: resolveCharacterDescription(char),
      avatar: char?.avatar ? `/characters/${char.avatar}` : "",
      worldbook: char?.data?.extensions?.world || char?.extensions?.world || "",
      raw: safeClone(char, null),
    },
    user: {
      name: ctx.name1 || "",
      avatar: "",
      raw: safeClone(ctx.user || null, null),
    },
    chat: {
      id: ctx.chatId || globalThis.getCurrentChatId?.() || "",
      messages: chat,
      lastUserMessage: resolveLastUserMessage(chat),
    },
    worldbook: {
      character: char?.data?.extensions?.world || char?.extensions?.world || "",
      persona:
        ctx.extensionSettings?.persona_description_lorebook ||
        ctx.powerUserSettings?.persona_description_lorebook ||
        ctx.power_user?.persona_description_lorebook ||
        "",
      chat: ctx.chatMetadata?.world || "",
    },
    variables: {
      global: globalVars,
      local: localVars,
      merged: {
        ...globalVars,
        ...localVars,
      },
    },
    time: {
      current: currentTime,
      locale: "zh-CN",
    },
    host: {
      meta: {
        onlineStatus: ctx.onlineStatus || "",
        selectedGroupId: ctx.selectedGroupId ?? null,
      },
      capabilities: {
        hasGetContext: typeof getContext === "function",
        hasGlobalGetContext:
          typeof globalThis.SillyTavern?.getContext === "function",
        hasCurrentChatId: typeof globalThis.getCurrentChatId === "function",
      },
    },
    raw: safeClone(ctx, {}),
  };
}

function buildCompatPromptAliases(snapshot) {
  return {
    userPersona: snapshot.persona.text,
    charDescription: snapshot.character.description,
    charName: snapshot.character.name,
    userName: snapshot.user.name,
    currentTime: snapshot.time.current,
  };
}

export function getSTContextSnapshot() {
  try {
    const ctx = getContext?.() || {};
    const snapshot = buildStructuredSnapshot(ctx);
    return {
      snapshot,
      prompt: buildCompatPromptAliases(snapshot),
    };
  } catch (e) {
    console.warn("[ST-BME] getSTContextSnapshot 失败:", e);
    const snapshot = buildStructuredSnapshot({});
    return {
      snapshot,
      prompt: buildCompatPromptAliases(snapshot),
    };
  }
}

/**
 * 从 SillyTavern 的 getContext() 提取当前上下文数据，
 * 返回的字段可直接展开传入 buildTaskPrompt 的 context 参数，
 * 用户在自定义 prompt 块中可通过 {{key}} 引用。
 *
 * @returns {object} 上下文字段映射
 */
export function getSTContextForPrompt() {
  return getSTContextSnapshot().prompt;
}
