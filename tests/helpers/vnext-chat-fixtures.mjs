import { createHash, randomUUID } from "node:crypto";

export function contentHash(value = "") {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function createChatIdentity(overrides = {}) {
  const hostChatId = String(overrides.hostChatId || "chat-file-1");
  return {
    chatId: String(overrides.chatId || `chat:${randomUUID()}`),
    hostChatId,
    integrity: String(overrides.integrity || randomUUID()),
    lineageId: String(overrides.lineageId || randomUUID()),
    branchCutoff: Number.isFinite(overrides.branchCutoff)
      ? Math.floor(overrides.branchCutoff)
      : null,
  };
}

export function createUserMessage(text, overrides = {}) {
  return {
    name: String(overrides.name || "You"),
    mes: String(text || ""),
    is_user: true,
    is_system: false,
    extra: {
      ...(overrides.extra || {}),
    },
  };
}

export function createAssistantMessage(text, overrides = {}) {
  const swipes = Array.isArray(overrides.swipes)
    ? overrides.swipes.map((item) => String(item || ""))
    : [String(text || "")];
  const swipeId = Number.isFinite(overrides.swipeId)
    ? Math.max(0, Math.floor(overrides.swipeId))
    : 0;
  return {
    name: String(overrides.name || "Character"),
    mes: swipes[swipeId] ?? String(text || ""),
    is_user: false,
    is_system: false,
    swipes,
    swipe_id: swipeId,
    original_avatar: overrides.originalAvatar,
    extra: {
      ...(overrides.genId ? { gen_id: String(overrides.genId) } : {}),
      ...(overrides.extra || {}),
    },
  };
}

export function createConversation(overrides = {}) {
  const chat = Array.isArray(overrides.chat)
    ? overrides.chat
    : [
        createUserMessage("你好"),
        createAssistantMessage("你好，需要我做什么？"),
      ];
  return {
    identity: createChatIdentity(overrides.identity || {}),
    chat,
    fingerprint: contentHash(
      chat
        .map((message, index) =>
          [
            index,
            message?.is_user ? "user" : message?.is_system ? "system" : "assistant",
            Number(message?.swipe_id || 0),
            String(message?.mes || ""),
          ].join(":"),
        )
        .join("\n"),
    ),
  };
}

export function branchConversation(source, cutoff, overrides = {}) {
  const safeCutoff = Math.max(0, Math.min(source.chat.length - 1, Math.floor(cutoff)));
  return createConversation({
    identity: {
      ...source.identity,
      chatId: overrides.chatId || `chat:${randomUUID()}`,
      hostChatId: overrides.hostChatId || `branch-${randomUUID()}`,
      branchCutoff: safeCutoff,
    },
    chat: source.chat.slice(0, safeCutoff + 1).map((message) =>
      typeof structuredClone === "function"
        ? structuredClone(message)
        : JSON.parse(JSON.stringify(message)),
    ),
  });
}

