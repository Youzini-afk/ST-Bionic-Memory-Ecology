import assert from "node:assert/strict";

import {
  applyHideSettings,
  getHideStateSnapshot,
  resetHideState,
  runIncrementalHideCheck,
  unhideAll,
} from "../hide-engine.js";

function createRuntime(chat) {
  const domWrites = [];
  return {
    chat,
    domWrites,
    getContext() {
      return { chat: this.chat };
    },
    $(selector) {
      return {
        attr(name, value) {
          domWrites.push({ selector, name, value });
        },
      };
    },
  };
}

function testApplyAndUnhidePreservesOriginalSystemMessages() {
  const chat = [
    { mes: "原系统", is_system: true },
    { mes: "用户1", is_user: true, is_system: false },
    { mes: "助手1", is_user: false, is_system: false },
    { mes: "用户2", is_user: true, is_system: false },
    { mes: "助手2", is_user: false, is_system: false },
  ];
  const runtime = createRuntime(chat);

  const applyResult = applyHideSettings(
    { enabled: true, hide_last_n: 2 },
    runtime,
  );
  assert.equal(applyResult.active, true);
  assert.equal(chat[0].is_system, true);
  assert.equal(chat[1].is_system, true);
  assert.equal(chat[2].is_system, true);
  assert.equal(chat[3].is_system, false);
  assert.equal(chat[4].is_system, false);
  assert.equal(applyResult.managedCount, 2);

  const unhideResult = unhideAll(runtime);
  assert.equal(unhideResult.active, false);
  assert.equal(chat[0].is_system, true, "原系统消息不应被恢复");
  assert.equal(chat[1].is_system, false);
  assert.equal(chat[2].is_system, false);
}

function testResetRestoresPreviousManagedChat() {
  const oldChat = [
    { mes: "用户1", is_user: true, is_system: false },
    { mes: "助手1", is_user: false, is_system: false },
    { mes: "用户2", is_user: true, is_system: false },
    { mes: "助手2", is_user: false, is_system: false },
  ];
  const newChat = [
    { mes: "新用户", is_user: true, is_system: false },
    { mes: "新助手", is_user: false, is_system: false },
  ];
  const runtime = createRuntime(oldChat);

  applyHideSettings({ enabled: true, hide_last_n: 1 }, runtime);
  assert.equal(oldChat[0].is_system, true);
  assert.equal(oldChat[1].is_system, true);
  assert.equal(oldChat[2].is_system, true);

  runtime.chat = newChat;
  resetHideState(runtime);

  assert.equal(oldChat[0].is_system, false);
  assert.equal(oldChat[1].is_system, false);
  assert.equal(oldChat[2].is_system, false);
  assert.deepEqual(getHideStateSnapshot(), {
    hasManagedChat: false,
    managedHiddenCount: 0,
    lastProcessedLength: 0,
    scheduled: false,
  });
}

function testIncrementalHideOnlyHidesNewOverflowMessages() {
  const chat = [
    { mes: "用户1", is_user: true, is_system: false },
    { mes: "助手1", is_user: false, is_system: false },
    { mes: "用户2", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);

  applyHideSettings({ enabled: true, hide_last_n: 2 }, runtime);
  assert.equal(chat[0].is_system, true);
  assert.equal(chat[1].is_system, false);
  assert.equal(chat[2].is_system, false);

  chat.push({ mes: "助手2", is_user: false, is_system: false });
  const result = runIncrementalHideCheck(
    { enabled: true, hide_last_n: 2 },
    runtime,
  );
  assert.equal(result.incremental, true);
  assert.equal(result.hiddenCount, 1);
  assert.equal(chat[1].is_system, true);
  assert.equal(chat[2].is_system, false);
  assert.equal(chat[3].is_system, false);
}

testApplyAndUnhidePreservesOriginalSystemMessages();
testResetRestoresPreviousManagedChat();
testIncrementalHideOnlyHidesNewOverflowMessages();

console.log("hide-engine tests passed");
