import assert from "node:assert/strict";

import {
  applyHideSettings,
  getHideStateSnapshot,
  resetHideState,
  runIncrementalHideCheck,
  scheduleHideSettingsApply,
  unhideAll,
} from "../ui/hide-engine.js";

function createRuntime(chat, chatId = "chat-a") {
  const commands = [];
  const domWrites = [];
  return {
    chat,
    chatId,
    commands,
    domWrites,
    async executeSlashCommands(command) {
      commands.push(command);
      return "";
    },
    $(selector) {
      return {
        attr(name, value) {
          domWrites.push({ selector, name, value });
        },
      };
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

async function testApplyUsesNativeHide() {
  resetHideState();
  const chat = [
    { mes: "user-1", is_user: true, is_system: false },
    { mes: "assistant-1", is_user: false, is_system: false },
    { mes: "user-2", is_user: true, is_system: false },
    { mes: "assistant-2", is_user: false, is_system: false },
    { mes: "user-3", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);

  const result = await applyHideSettings(
    { enabled: true, hide_last_n: 2 },
    runtime,
  );

  assert.equal(result.active, true);
  assert.equal(result.hiddenCount, 3);
  assert.deepEqual(runtime.commands, ["/hide 0-2"]);
  assert.equal(chat[0].is_system, true);
  assert.equal(chat[1].is_system, true);
  assert.equal(chat[2].is_system, true);
  assert.equal(chat[3].is_system, false);
  assert.deepEqual(getHideStateSnapshot(), {
    hasManagedChat: true,
    managedHiddenCount: 3,
    lastProcessedLength: 5,
    scheduled: false,
  });
}

async function testDisableUnhidesManagedRange() {
  resetHideState();
  const chat = [
    { mes: "system", is_user: false, is_system: true },
    { mes: "assistant-1", is_user: false, is_system: false },
    { mes: "user-2", is_user: true, is_system: false },
    { mes: "assistant-2", is_user: false, is_system: false },
  ];
  const runtime = createRuntime(chat);

  await applyHideSettings({ enabled: true, hide_last_n: 1 }, runtime);
  runtime.commands.length = 0;

  const result = await unhideAll(runtime);
  assert.equal(result.active, false);
  assert.equal(result.shownCount, 4);
  assert.deepEqual(runtime.commands, ["/unhide 0-3"]);
  assert.equal(chat[0].is_system, true);
  assert.equal(chat[1].is_system, false);
  assert.equal(chat[2].is_system, false);
  assert.equal(getHideStateSnapshot().managedHiddenCount, 0);
}

async function testIncrementalOnlyHidesOverflowDelta() {
  resetHideState();
  const chat = [
    { mes: "user-1", is_user: true, is_system: false },
    { mes: "assistant-1", is_user: false, is_system: false },
    { mes: "user-2", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);

  await applyHideSettings({ enabled: true, hide_last_n: 2 }, runtime);
  runtime.commands.length = 0;

  chat.push({ mes: "assistant-2", is_user: false, is_system: false });
  const result = await runIncrementalHideCheck(
    { enabled: true, hide_last_n: 2 },
    runtime,
  );

  assert.equal(result.incremental, true);
  assert.equal(result.hiddenCount, 2);
  assert.deepEqual(runtime.commands, ["/hide 1-1"]);
  assert.equal(chat[0].is_system, true);
  assert.equal(chat[1].is_system, true);
  assert.equal(chat[2].is_system, false);
  assert.equal(chat[3].is_system, false);
  assert.equal(getHideStateSnapshot().managedHiddenCount, 2);
}

async function testResetClearsStateWithoutIssuingCommands() {
  resetHideState();
  const chat = [
    { mes: "user-1", is_user: true, is_system: false },
    { mes: "assistant-1", is_user: false, is_system: false },
    { mes: "user-2", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);

  await applyHideSettings({ enabled: true, hide_last_n: 1 }, runtime);
  runtime.commands.length = 0;

  resetHideState(runtime);

  assert.deepEqual(runtime.commands, []);
  assert.equal(chat[0].is_system, false);
  assert.equal(chat[1].is_system, false);
  assert.deepEqual(getHideStateSnapshot(), {
    hasManagedChat: false,
    managedHiddenCount: 0,
    lastProcessedLength: 0,
    scheduled: false,
  });
}

async function testUnhideAllRecoversPersistedManagedMarkersAfterStateLoss() {
  resetHideState();
  const chat = [
    {
      mes: "user-1",
      is_user: true,
      is_system: true,
      extra: { __st_bme_hide_managed: true },
    },
    {
      mes: "assistant-1",
      is_user: false,
      is_system: true,
      extra: { __st_bme_hide_managed: true },
    },
    { mes: "user-2", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);

  const result = await unhideAll(runtime);

  assert.equal(result.active, false);
  assert.equal(result.shownCount, 3);
  assert.deepEqual(runtime.commands, ["/unhide 0-2"]);
  assert.equal(chat[0].is_system, false);
  assert.equal(chat[1].is_system, false);
  assert.equal(chat[0].extra, undefined);
  assert.equal(chat[1].extra, undefined);
}

async function testScheduledApplyRefreshesPanelState() {
  resetHideState();
  const chat = [
    { mes: "user-1", is_user: true, is_system: false },
    { mes: "assistant-1", is_user: false, is_system: false },
    { mes: "user-2", is_user: true, is_system: false },
  ];
  const runtime = createRuntime(chat);
  const timers = [];
  let refreshCount = 0;
  runtime.setTimeout = (callback, delayMs) => {
    timers.push({ callback, delayMs });
    return timers.length;
  };
  runtime.clearTimeout = () => {};
  runtime.refreshPanelLiveState = () => {
    refreshCount += 1;
  };

  scheduleHideSettingsApply({ enabled: true, hide_last_n: 1 }, runtime, 25);

  assert.equal(refreshCount, 1);
  assert.equal(getHideStateSnapshot().scheduled, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 25);

  timers[0].callback();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.equal(getHideStateSnapshot().scheduled, false);
  assert.equal(getHideStateSnapshot().managedHiddenCount, 2);
  assert.equal(refreshCount, 2);
}

await testApplyUsesNativeHide();
await testDisableUnhidesManagedRange();
await testIncrementalOnlyHidesOverflowDelta();
await testResetClearsStateWithoutIssuingCommands();
await testUnhideAllRecoversPersistedManagedMarkersAfterStateLoss();
await testScheduledApplyRefreshesPanelState();

console.log("hide-engine tests passed");
