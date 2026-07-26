import assert from "node:assert/strict";

import { setLocale } from "../i18n/index.js";
import { createUiStatus, getStageNoticeTitle } from "../ui/ui-status.js";

setLocale("zh-CN");

const status = createUiStatus({
  textKey: "status.graphLoad.title",
  textFallback: "图谱已加载",
  metaKey: "status.graphLoad.loading.detail",
  metaParams: { chatId: "chat-1" },
  metaFallback: "正在读取聊天 chat-1 的 IndexedDB 图谱",
  level: "running",
});

assert.equal(status.level, "running");
assert.equal(status.text, "图谱已加载");
assert.equal(status.meta, "正在读取聊天 chat-1 的 IndexedDB 图谱");

setLocale("en-US");
const englishStatus = createUiStatus({
  textKey: "status.graphLoad.title",
  textFallback: "图谱已加载",
  metaKey: "status.graphLoad.loading.detail",
  metaParams: { chatId: "chat-1" },
  metaFallback: "正在读取聊天 chat-1 的 IndexedDB 图谱",
  level: "running",
});
assert.equal(englishStatus.text, "Graph Loaded");
assert.equal(englishStatus.meta, "Reading the IndexedDB graph for chat chat-1");
assert.equal(getStageNoticeTitle("recall"), "ST-BME Recall");

setLocale("zh-CN");
assert.equal(getStageNoticeTitle("history"), "ST-BME 历史恢复");

console.log("i18n status tests passed");
