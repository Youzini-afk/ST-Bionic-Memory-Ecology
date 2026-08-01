import assert from "node:assert/strict";

import { setLocale } from "../i18n/index.js";
import {
  createUiStatus,
  getStageNoticeTitle,
  reportPanelGraphLoadFailure,
} from "../ui/ui-status.js";

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
assert.equal(getStageNoticeTitle("history"), "ST-BME 楼层回滚");

const originalToastr = globalThis.toastr;
const originalConsoleError = console.error;
const reported = {};
try {
  globalThis.toastr = { error: (message, title) => Object.assign(reported, { message, title }) };
  console.error = () => {};
  const message = reportPanelGraphLoadFailure(new Error("OPFS down"), (level, detail) =>
    Object.assign(reported, { level, detail }));
  assert.match(message, /OPFS down/);
  assert.deepEqual(reported, { message, title: "ST-BME", level: "error", detail: message });
} finally {
  console.error = originalConsoleError;
  if (originalToastr === undefined) delete globalThis.toastr;
  else globalThis.toastr = originalToastr;
}

console.log("i18n status tests passed");
