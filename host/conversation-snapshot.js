import { hashDomainValue } from "../domain/memory-id.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function readExtra(message) {
  return message?.extra && typeof message.extra === "object" && !Array.isArray(message.extra)
    ? message.extra
    : {};
}

function messageRole(message, index) {
  if (!message || typeof message !== "object") return "ignored";
  if (index === 0 && !message.is_user) return "greeting";
  if (message.is_system) return "system";
  return message.is_user ? "user" : "assistant";
}

function stableMessageHint(message, role) {
  const extra = readExtra(message);
  const explicit =
    extra.bme_message_id ||
    extra.bme_turn_id ||
    extra.message_id ||
    message?.message_id ||
    "";
  if (String(explicit).trim()) return `${role}:id:${String(explicit).trim()}`;
  const sentAt = String(message?.send_date || extra.send_date || "").trim();
  const generationId = String(extra.gen_id || "").trim();
  const speaker = String(
    message?.original_avatar || extra.original_avatar || message?.name || "",
  ).trim();
  if (sentAt) return `${role}:sent:${sentAt}:${speaker}`;
  if (generationId) return `${role}:generation:${generationId}:${speaker}`;
  return "";
}

function speakerKey(message) {
  const extra = readExtra(message);
  return String(
    message?.original_avatar || extra.original_avatar || message?.name || "assistant",
  ).trim();
}

export function buildConversationEvidenceSnapshot(
  chat = [],
  {
    chatId = "",
    hostChatId = "",
    sanitizeMessage = (message) => message?.mes,
  } = {},
) {
  const messages = Array.isArray(chat) ? chat : [];
  const turns = [];
  const fingerprintParts = [];
  let currentUser = null;
  const assistantOrdinalsByUserAndSpeaker = new Map();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = messageRole(message, index);
    const text = normalizeText(sanitizeMessage(message, index, messages));
    if (role === "system" || role === "ignored" || role === "greeting" || !text) continue;
    const hint = stableMessageHint(message, role);
    fingerprintParts.push(
      hashDomainValue({
        role,
        text,
        speaker: role === "assistant" ? speakerKey(message) : String(message?.name || ""),
        swipeId: role === "assistant" ? Number(message?.swipe_id || 0) : null,
      }),
    );

    if (role === "user") {
      currentUser = {
        text,
        floor: index,
        messageId: hint,
        anchor: hint || `user:${hashDomainValue(text)}`,
      };
      continue;
    }
    if (!currentUser) continue;

    const extra = readExtra(message);
    const speaker = speakerKey(message);
    const ordinalKey = `${currentUser.anchor}\u0000${speaker}`;
    const speakerOrdinal = (assistantOrdinalsByUserAndSpeaker.get(ordinalKey) || 0) + 1;
    assistantOrdinalsByUserAndSpeaker.set(ordinalKey, speakerOrdinal);
    const hostTurnKey = hint ? `${currentUser.anchor}->${hint}` : "";
    turns.push({
      hostTurnKey,
      logicalSlotKey: `${currentUser.anchor}->${speaker}:${speakerOrdinal}`,
      hostChatId: String(hostChatId || "").trim(),
      userMessageId: currentUser.messageId,
      assistantMessageId: hint,
      userFloor: currentUser.floor,
      assistantFloor: index,
      assistantSwipeId: Number.isFinite(Number(message?.swipe_id))
        ? Math.max(0, Math.floor(Number(message.swipe_id)))
        : 0,
      generationId: String(extra.gen_id || "").trim(),
      groupGenerationId: String(extra.gen_id || "").trim(),
      userText: currentUser.text,
      assistantText: text,
      normalizedUserText: currentUser.text,
      normalizedAssistantText: text,
      speaker,
      metadata: {
        chatId: String(chatId || "").trim(),
        userName: String(messages[currentUser.floor]?.name || "").trim(),
        assistantName: String(message?.name || "").trim(),
        originalAvatar: String(message?.original_avatar || "").trim(),
      },
    });
  }

  const historyFingerprint = hashDomainValue(fingerprintParts);
  return {
    chatId: String(chatId || "").trim(),
    hostChatId: String(hostChatId || "").trim(),
    historyFingerprint,
    turns: turns.map((turn) => ({ ...turn, historyFingerprint })),
  };
}
