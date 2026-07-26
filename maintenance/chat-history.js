// ST-BME: 聊天历史纯函数
// 此模块中的函数均不依赖 index.js 模块级可变状态，
// 可被 index.js 及其他模块安全导入。

import { clampInt } from "../ui/ui-status.js";
import { sanitizePlannerMessageText } from "../runtime/planner-tag-utils.js";
import { rollbackBatch } from "../runtime/runtime-state.js";
import { isInManagedHideRange } from "../ui/hide-engine.js";

export function isBmeManagedHiddenMessage(
  message,
  { index = null, chat = null } = {},
) {
  if (
    Number.isFinite(index) &&
    index > 0 &&
    isInManagedHideRange(index, chat)
  ) {
    return true;
  }

  return Boolean(
    message?.extra &&
      typeof message.extra === "object" &&
      message.extra.__st_bme_hide_managed === true,
  );
}

export function isDialogueGreetingMessage(
  message,
  { index = null } = {},
) {
  if (!Number.isFinite(index) || index !== 0) return false;
  if (!message || typeof message !== "object") return false;
  return String(message?.mes ?? "").trim().length > 0;
}

export function isTrueSystemMessage(
  message,
  { index = null, chat = null } = {},
) {
  if (!message?.is_system) return false;
  if (isDialogueGreetingMessage(message, { index, chat })) return false;
  return !isBmeManagedHiddenMessage(message, { index, chat });
}

export function isDialogueCountedMessage(
  message,
  { index = null, chat = null } = {},
) {
  if (!message || typeof message !== "object") return false;
  if (!String(message?.mes ?? "").trim()) return false;
  return !isTrueSystemMessage(message, { index, chat });
}

export function isDialogueAssistantMessage(
  message,
  { index = null, chat = null } = {},
) {
  if (!isDialogueCountedMessage(message, { index, chat })) return false;
  if (isDialogueGreetingMessage(message, { index, chat })) return false;
  return Boolean(message) && !message.is_user;
}

export function buildDialogueFloorMap(chat = []) {
  const floorToChatIndex = [];
  const chatIndexToFloor = {};
  const floorToRole = {};
  const assistantDialogueFloors = [];
  const assistantChatIndices = [];

  if (!Array.isArray(chat)) {
    return {
      latestDialogueFloor: -1,
      floorToChatIndex,
      chatIndexToFloor,
      floorToRole,
      assistantDialogueFloors,
      assistantChatIndices,
    };
  }

  let currentFloor = -1;
  for (let index = 0; index < chat.length; index += 1) {
    const message = chat[index];
    if (!isDialogueCountedMessage(message, { index, chat })) continue;
    currentFloor += 1;
    floorToChatIndex[currentFloor] = index;
    chatIndexToFloor[index] = currentFloor;

    if (isDialogueGreetingMessage(message, { index, chat })) {
      floorToRole[currentFloor] = "greeting";
      continue;
    }

    const role = message?.is_user ? "user" : "assistant";
    floorToRole[currentFloor] = role;
    if (role === "assistant") {
      assistantDialogueFloors.push(currentFloor);
      assistantChatIndices.push(index);
    }
  }

  return {
    latestDialogueFloor: currentFloor,
    floorToChatIndex,
    chatIndexToFloor,
    floorToRole,
    assistantDialogueFloors,
    assistantChatIndices,
  };
}

export function normalizeDialogueFloorRange(
  chat = [],
  startFloor = null,
  endFloor = null,
) {
  const map = buildDialogueFloorMap(chat);
  const latestDialogueFloor = Number(map.latestDialogueFloor);
  const hasStart =
    startFloor !== null &&
    startFloor !== undefined &&
    startFloor !== "" &&
    Number.isFinite(Number(startFloor));
  const hasEnd =
    endFloor !== null &&
    endFloor !== undefined &&
    endFloor !== "" &&
    Number.isFinite(Number(endFloor));
  if (latestDialogueFloor < 0) {
    return {
      map,
      latestDialogueFloor,
      valid: false,
      reason: "empty-dialogue",
      startFloor: null,
      endFloor: null,
    };
  }
  if (!hasStart && hasEnd) {
    return {
      map,
      latestDialogueFloor,
      valid: false,
      reason: "end-without-start",
      startFloor: null,
      endFloor: null,
    };
  }
  const normalizedStart = hasStart
    ? Math.max(0, Math.min(latestDialogueFloor, Math.floor(Number(startFloor))))
    : null;
  const normalizedEnd = hasEnd
    ? Math.max(
        normalizedStart ?? 0,
        Math.min(latestDialogueFloor, Math.floor(Number(endFloor))),
      )
    : hasStart
      ? latestDialogueFloor
      : null;

  return {
    map,
    latestDialogueFloor,
    valid: true,
    reason: "",
    startFloor: normalizedStart,
    endFloor: normalizedEnd,
  };
}

export function getDialogueFloorForChatIndex(chat = [], chatIndex = null) {
  if (!Number.isFinite(Number(chatIndex))) return null;
  const map = buildDialogueFloorMap(chat);
  const floor = map.chatIndexToFloor[Math.floor(Number(chatIndex))];
  return Number.isFinite(Number(floor)) ? Number(floor) : null;
}

function cloneChatMessageForPluginView(message) {
  if (!message || typeof message !== "object") {
    return message;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(message);
    }
  } catch {
    // ignore and fall back to JSON clone
  }

  try {
    return JSON.parse(JSON.stringify(message));
  } catch {
    return {
      ...message,
      extra:
        message.extra && typeof message.extra === "object"
          ? { ...message.extra }
          : message.extra,
    };
  }
}

export function buildPluginVisibleChatMessages(chat = []) {
  if (!Array.isArray(chat)) return [];

  return chat.map((message, index) => {
    const cloned = cloneChatMessageForPluginView(message);
    if (
      cloned &&
      typeof cloned === "object" &&
      isBmeManagedHiddenMessage(message, { index, chat })
    ) {
      cloned.is_system = false;
    }
    return cloned;
  });
}

export function isSystemMessageForExtraction(
  message,
  { index = null, chat = null } = {},
) {
  if (!message?.is_system) return false;
  if (Number.isFinite(index) && index === 0) return true;

  return !isBmeManagedHiddenMessage(message, { index, chat });
}

export function isSystemMessageForSummary(
  message,
  { index = null, chat = null } = {},
) {
  if (!message?.is_system) return false;
  if (Number.isFinite(index) && index === 0) return true;
  return !isBmeManagedHiddenMessage(message, { index, chat });
}

export function isAssistantChatMessage(
  message,
  { index = null, chat = null } = {},
) {
  return (
    Boolean(message) &&
    !message.is_user &&
    !isSystemMessageForExtraction(message, { index, chat })
  );
}

export function getAssistantTurns(chat) {
  const assistantTurns = [];
  // 从 index 1 开始：index 0 是角色卡首条消息（greeting），不参与提取
  for (let index = 1; index < chat.length; index++) {
    if (!isAssistantChatMessage(chat[index], { index, chat })) continue;
    if (!String(chat[index]?.mes ?? "").trim()) continue;
    assistantTurns.push(index);
  }
  return assistantTurns;
}

export function getMinExtractableAssistantFloor(chat) {
  const assistantTurns = getAssistantTurns(chat);
  return assistantTurns.length > 0 ? assistantTurns[0] : null;
}

export function buildExtractionMessages(chat, startIdx, endIdx, settings) {
  const contextTurns = clampInt(settings.extractContextTurns, 2, 0, 20);
  const contextStart = Math.max(0, startIdx - contextTurns * 2);
  const messages = [];

  for (
    let index = contextStart;
    index <= endIdx && index < chat.length;
    index++
  ) {
    const msg = chat[index];
    if (isSystemMessageForExtraction(msg, { index, chat })) continue;
    const content = sanitizePlannerMessageText(msg);
    if (!String(content || "").trim()) continue;
    messages.push({
      seq: index,
      role: msg.is_user ? "user" : "assistant",
      content,
      rawContent: String(msg?.mes ?? ""),
      name: String(msg?.name ?? "").trim(),
      speaker: String(msg?.name ?? "").trim(),
      isContextOnly: index < startIdx,
    });
  }

  return messages;
}

export function buildSummarySourceMessages(
  chat,
  startIdx,
  endIdx,
  options = {},
) {
  const extraContextFloors = clampInt(
    options.rawChatContextFloors,
    0,
    0,
    200,
  );
  const contextStart = Math.max(0, Number(startIdx || 0) - extraContextFloors);
  const messages = [];

  for (
    let index = contextStart;
    index <= endIdx && index < chat.length;
    index += 1
  ) {
    const msg = chat[index];
    if (isSystemMessageForSummary(msg, { index, chat })) continue;
    const content = sanitizePlannerMessageText(msg);
    if (!String(content || "").trim()) continue;
    messages.push({
      seq: index,
      role: msg.is_user ? "user" : "assistant",
      content,
      hiddenManaged: isBmeManagedHiddenMessage(msg, { index, chat }),
    });
  }

  return messages;
}

export function getChatIndexForPlayableSeq(chat, playableSeq) {
  if (!Array.isArray(chat) || !Number.isFinite(playableSeq)) return null;

  let currentSeq = -1;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (isSystemMessageForExtraction(message, { index, chat })) continue;
    currentSeq++;
    if (currentSeq >= playableSeq) {
      return index;
    }
  }

  return chat.length;
}

export function getChatIndexForAssistantSeq(chat, assistantSeq) {
  if (!Array.isArray(chat) || !Number.isFinite(assistantSeq)) return null;

  let currentSeq = -1;
  for (let index = 0; index < chat.length; index++) {
    if (!isAssistantChatMessage(chat[index], { index, chat })) continue;
    currentSeq++;
    if (currentSeq >= assistantSeq) {
      return index;
    }
  }

  return chat.length;
}

export function resolveDirtyFloorFromMutationMeta(trigger, primaryArg, meta, chat) {
  if (!meta || typeof meta !== "object") return null;

  const candidates = [];
  const isDeleteTrigger = String(trigger || "").includes("message-deleted");
  const minExtractableFloor = getMinExtractableAssistantFloor(chat);

  // 删除后 chat 已是收缩后的状态，删除事件携带的 seq 更接近"被删区间起点"，
  // 因此这里额外向前退一层，避免恢复仍停留在被删楼层对应的旧图谱边界。
  if (!isDeleteTrigger && Number.isFinite(meta.messageId)) {
    candidates.push({
      floor: meta.messageId,
      source: `${trigger}-meta`,
    });
  }
  if (Number.isFinite(meta.deletedPlayableSeqFrom)) {
    const floor = getChatIndexForPlayableSeq(chat, meta.deletedPlayableSeqFrom);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor: Number.isFinite(minExtractableFloor)
          ? Math.max(minExtractableFloor, floor - 1)
          : Math.max(0, floor - 1),
        source: `${trigger}-meta-delete-boundary`,
      });
    }
  }
  if (Number.isFinite(meta.deletedAssistantSeqFrom)) {
    const floor = getChatIndexForAssistantSeq(
      chat,
      meta.deletedAssistantSeqFrom,
    );
    if (Number.isFinite(floor)) {
      candidates.push({
        floor: Number.isFinite(minExtractableFloor)
          ? Math.max(minExtractableFloor, floor - 1)
          : Math.max(0, floor - 1),
        source: `${trigger}-meta-delete-boundary`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(meta.playableSeq)) {
    const floor = getChatIndexForPlayableSeq(chat, meta.playableSeq);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor,
        source: `${trigger}-meta`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(meta.assistantSeq)) {
    const floor = getChatIndexForAssistantSeq(chat, meta.assistantSeq);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor,
        source: `${trigger}-meta`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(primaryArg)) {
    candidates.push({
      floor: primaryArg,
      source: `${trigger}-meta`,
    });
  }

  if (candidates.length === 0) return null;
  const validCandidates = Number.isFinite(minExtractableFloor)
    ? candidates.filter((c) => c.floor >= minExtractableFloor)
    : candidates;
  if (validCandidates.length === 0) return null;
  return validCandidates.reduce((earliest, current) =>
    current.floor < earliest.floor ? current : earliest,
  );
}

export function clampRecoveryStartFloor(chat, floor) {
  if (!Number.isFinite(floor)) return floor;

  const minExtractableFloor = getMinExtractableAssistantFloor(chat);
  if (!Number.isFinite(minExtractableFloor)) {
    return floor;
  }

  return Math.max(floor, minExtractableFloor);
}

export function rollbackAffectedJournals(graph, affectedJournals = []) {
  for (let index = affectedJournals.length - 1; index >= 0; index--) {
    rollbackBatch(graph, affectedJournals[index]);
  }
  graph.batchJournal = Array.isArray(graph.batchJournal)
    ? graph.batchJournal.slice(
        0,
        Math.max(0, graph.batchJournal.length - affectedJournals.length),
      )
    : [];
}

export function pruneProcessedMessageHashesFromFloor(graph, fromFloor) {
  if (!graph?.historyState?.processedMessageHashes) return;
  if (!Number.isFinite(fromFloor)) return;

  const hashes = graph.historyState.processedMessageHashes;
  for (const key of Object.keys(hashes)) {
    if (Number(key) >= fromFloor) {
      delete hashes[key];
    }
  }
}
