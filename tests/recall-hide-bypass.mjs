import assert from "node:assert/strict";

import { buildRecallRecentMessagesController } from "../retrieval/recall-controller.js";

const chat = [
  { is_user: false, is_system: true, mes: "greeting/system" },
  {
    is_user: false,
    is_system: true,
    mes: "managed hidden assistant",
    extra: { __st_bme_hide_managed: true },
  },
  { is_user: true, is_system: false, mes: "user message" },
  { is_user: false, is_system: true, mes: "real system" },
  { is_user: false, is_system: false, mes: "visible assistant" },
];

const recentMessages = buildRecallRecentMessagesController(chat, 6, "", {
  formatRecallContextLine(message) {
    return `[${message.is_user ? "user" : "assistant"}]: ${message.mes}`;
  },
  normalizeRecallInputText(value = "") {
    return String(value || "").trim();
  },
});

assert.deepEqual(recentMessages, [
  "[assistant]: managed hidden assistant",
  "[user]: user message",
  "[assistant]: visible assistant",
]);

console.log("recall-hide-bypass tests passed");
