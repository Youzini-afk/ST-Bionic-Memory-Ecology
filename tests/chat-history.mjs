import assert from "node:assert/strict";
import {
  applyHideSettings,
  isInManagedHideRange,
  resetHideState,
} from "../ui/hide-engine.js";
import {
  buildPluginVisibleChatMessages,
  buildExtractionMessages,
  getAssistantTurns,
  isAssistantChatMessage,
  isBmeManagedHiddenMessage,
  isSystemMessageForExtraction,
} from "../maintenance/chat-history.js";

const visibleAssistant = {
  is_user: false,
  is_system: false,
  mes: "visible assistant",
};
assert.equal(isAssistantChatMessage(visibleAssistant), true);

const managedHiddenAssistant = {
  is_user: false,
  is_system: true,
  mes: "managed hidden assistant",
  extra: { __st_bme_hide_managed: true },
};
assert.equal(isBmeManagedHiddenMessage(managedHiddenAssistant), true);
assert.equal(isSystemMessageForExtraction(managedHiddenAssistant), false);
assert.equal(isAssistantChatMessage(managedHiddenAssistant), true);

const realSystemMessage = {
  is_user: false,
  is_system: true,
  mes: "real system",
};
assert.equal(isSystemMessageForExtraction(realSystemMessage), true);
assert.equal(isAssistantChatMessage(realSystemMessage), false);
const pluginVisibleChat = buildPluginVisibleChatMessages([
  realSystemMessage,
  managedHiddenAssistant,
]);
assert.equal(
  pluginVisibleChat[0].is_system,
  true,
  "real system message should remain system in plugin-visible chat",
);
assert.equal(
  pluginVisibleChat[1].is_system,
  false,
  "BME-managed hidden message should be restored for plugin-internal chat views",
);
assert.equal(
  managedHiddenAssistant.is_system,
  true,
  "plugin-visible chat clone must not mutate original managed hidden message",
);

function createRuntime(chat, chatId = "chat-a") {
  return {
    chat,
    chatId,
    async executeSlashCommands() {
      return "";
    },
    getContext() {
      return {
        chat: this.chat,
        chatId: this.chatId,
        executeSlashCommands: this.executeSlashCommands.bind(this),
      };
    },
  };
}

const chat = [
  { is_user: false, is_system: true, mes: "greeting/system" },
  { is_user: true, is_system: false, mes: "user-1" },
  managedHiddenAssistant,
  { is_user: true, is_system: false, mes: "user-2" },
  visibleAssistant,
  realSystemMessage,
];

assert.deepEqual(
  getAssistantTurns(chat),
  [2, 4],
  "managed hidden assistant floors should still be extractable assistant turns",
);

const extractionMessages = buildExtractionMessages(chat, 4, 4, {
  extractContextTurns: 2,
});
assert.deepEqual(
  extractionMessages.map((message) => ({
    seq: message.seq,
    role: message.role,
    content: message.content,
  })),
  [
    { seq: 1, role: "user", content: "user-1" },
    { seq: 2, role: "assistant", content: "managed hidden assistant" },
    { seq: 3, role: "user", content: "user-2" },
    { seq: 4, role: "assistant", content: "visible assistant" },
  ],
  "extraction should keep BME-managed hidden context but still skip real system messages",
);

const blankAssistantChat = [
  { is_user: false, is_system: true, mes: "greeting/system" },
  { is_user: true, is_system: false, mes: "user-1" },
  { is_user: false, is_system: false, mes: "   " },
  { is_user: true, is_system: false, mes: "<plot>secret</plot>" },
  { is_user: false, is_system: false, mes: "assistant-2" },
];

assert.deepEqual(
  getAssistantTurns(blankAssistantChat),
  [4],
  "blank assistant floors should not be treated as extractable turns",
);
assert.deepEqual(
  buildExtractionMessages(blankAssistantChat, 4, 4, {
    extractContextTurns: 3,
  }).map((message) => ({
    seq: message.seq,
    role: message.role,
    content: message.content,
  })),
  [
    { seq: 1, role: "user", content: "user-1" },
    { seq: 4, role: "assistant", content: "assistant-2" },
  ],
  "blank assistant text and planner-tag-only user text should be skipped",
);

resetHideState();
const autoHiddenChat = [
  { is_user: false, is_system: true, mes: "greeting/system" },
  { is_user: true, is_system: false, mes: "user-1" },
  { is_user: false, is_system: false, mes: "assistant-1" },
  { is_user: true, is_system: false, mes: "user-2" },
  { is_user: false, is_system: false, mes: "assistant-2" },
  { is_user: true, is_system: false, mes: "user-3" },
  { is_user: false, is_system: false, mes: "assistant-3" },
];
await applyHideSettings(
  { enabled: true, hide_last_n: 2 },
  createRuntime(autoHiddenChat),
);

assert.equal(
  isInManagedHideRange(2, autoHiddenChat),
  true,
  "auto-hidden ordinary floors should be queryable from hide-engine managed range",
);
assert.equal(
  isSystemMessageForExtraction(autoHiddenChat[2], {
    index: 2,
    chat: autoHiddenChat,
  }),
  false,
  "auto-hidden ordinary floors inside managed range should remain extractable",
);
assert.equal(
  isSystemMessageForExtraction(autoHiddenChat[0], {
    index: 0,
    chat: autoHiddenChat,
  }),
  true,
  "greeting/system floor should still be treated as system even if hide range starts at 0",
);

console.log("chat-history tests passed");
