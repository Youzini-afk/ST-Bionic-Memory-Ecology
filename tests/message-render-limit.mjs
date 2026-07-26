import assert from "node:assert/strict";
import {
  applyMessageRenderLimit,
  getMessageRenderLimitSettings,
  getRenderLimitedHistoryRecoveryGuard,
} from "../ui/message-render-limit.js";

// Builds a fake host adapter mirroring index.js getMessageRenderLimitHostAdapter,
// so we test the real extracted module by import (no index.js slicing).
function createHostHarness() {
  const state = {
    powerUser: { chat_truncation: 0 },
    reloadCount: 0,
    inputValue: "",
    counterValue: "",
    triggeredEvents: [],
  };

  function makeInput(kind) {
    return {
      length: 1,
      val(value) {
        if (arguments.length > 0) {
          if (kind === "counter") state.counterValue = value;
          else state.inputValue = value;
          return this;
        }
        return kind === "counter" ? state.counterValue : state.inputValue;
      },
      trigger(eventName) {
        state.triggeredEvents.push(eventName);
        return this;
      },
    };
  }

  const host = {
    getPowerUser() {
      return state.powerUser;
    },
    jq(selector) {
      if (selector === "#chat_truncation") return makeInput("input");
      if (selector === "#chat_truncation_counter") return makeInput("counter");
      return { length: 0 };
    },
    reloadCurrentChat() {
      state.reloadCount += 1;
    },
    console,
  };

  return { host, state };
}

function getState(state) {
  return {
    counterValue: state.counterValue,
    inputValue: state.inputValue,
    powerUserChatTruncation: state.powerUser.chat_truncation,
    reloadCount: state.reloadCount,
    triggeredEvents: [...state.triggeredEvents],
  };
}

// ── normalization ────────────────────────────────────────────────
assert.deepEqual(
  getMessageRenderLimitSettings({
    enabled: true,
    hideOldMessagesRenderLimitEnabled: true,
    hideOldMessagesRenderLimit: "24",
  }),
  { enabled: true, render_last_n: 24 },
);
assert.deepEqual(
  getMessageRenderLimitSettings({
    enabled: false,
    hideOldMessagesRenderLimitEnabled: true,
    hideOldMessagesRenderLimit: 24,
  }),
  { enabled: false, render_last_n: 24 },
);

// ── apply (active) ───────────────────────────────────────────────
{
  const { host, state } = createHostHarness();
  const applied = applyMessageRenderLimit(
    {
      enabled: true,
      hideOldMessagesRenderLimitEnabled: true,
      hideOldMessagesRenderLimit: 24,
    },
    { reloadCurrentChat: true },
    host,
  );
  assert.deepEqual(applied, {
    active: true,
    renderLimit: 24,
    applied: true,
    skipped: false,
  });
  assert.deepEqual(getState(state), {
    counterValue: "24",
    inputValue: "24",
    powerUserChatTruncation: 24,
    reloadCount: 1,
    triggeredEvents: ["change"],
  });
}

// ── history recovery guard ───────────────────────────────────────
{
  const guarded = getRenderLimitedHistoryRecoveryGuard(
    new Array(10).fill({ mes: "visible" }),
    {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 30,
        processedMessageHashes: { 0: "a", 30: "b" },
      },
    },
  );
  assert.equal(guarded.blocked, true);
  assert.equal(guarded.renderLimit, 10);
  assert.equal(guarded.highestProcessedFloor, 30);

  const notGuardedWhenFullerThanRenderWindow =
    getRenderLimitedHistoryRecoveryGuard(new Array(20).fill({}), {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 30,
        processedMessageHashes: { 30: "b" },
      },
    });
  assert.equal(notGuardedWhenFullerThanRenderWindow.blocked, false);

  const notGuardedWhenHistoryFitsVisibleChat =
    getRenderLimitedHistoryRecoveryGuard(new Array(10).fill({}), {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 5,
        processedMessageHashes: { 5: "b" },
      },
    });
  assert.equal(notGuardedWhenHistoryFitsVisibleChat.blocked, false);
}

// ── apply (skipped vs cleared) ───────────────────────────────────
{
  const { host, state } = createHostHarness();
  state.powerUser.chat_truncation = 24;
  const skipped = applyMessageRenderLimit(
    {
      enabled: true,
      hideOldMessagesRenderLimitEnabled: false,
      hideOldMessagesRenderLimit: 24,
    },
    {},
    host,
  );
  assert.equal(skipped.skipped, true);
  assert.equal(getState(state).powerUserChatTruncation, 24);

  const cleared = applyMessageRenderLimit(
    {
      enabled: true,
      hideOldMessagesRenderLimitEnabled: false,
      hideOldMessagesRenderLimit: 24,
    },
    { clearWhenDisabled: true, reloadCurrentChat: true },
    host,
  );
  assert.deepEqual(cleared, {
    active: false,
    renderLimit: 0,
    applied: true,
    skipped: false,
  });
  assert.deepEqual(getState(state), {
    counterValue: "0",
    inputValue: "0",
    powerUserChatTruncation: 0,
    reloadCount: 1,
    triggeredEvents: ["change"],
  });
}

console.log("message-render-limit tests passed");
