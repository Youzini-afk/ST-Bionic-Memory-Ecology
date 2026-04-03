import assert from "node:assert/strict";
import {
  buildExtractionMessages,
  getAssistantTurns,
  isAssistantChatMessage,
  isBmeManagedHiddenMessage,
  isSystemMessageForExtraction,
} from "../chat-history.js";

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

console.log("chat-history tests passed");
