import assert from "node:assert/strict";

import {
  onMessageEditedController,
  onMessageUpdatedController,
  registerCoreEventHooksController,
} from "../host/event-binding.js";

{
  let invalidated = 0;
  let rechecked = 0;
  let refreshed = 0;
  let ignored = null;

  const result = onMessageUpdatedController(
    {
      invalidateRecallAfterHistoryMutation() {
        invalidated += 1;
      },
      scheduleHistoryMutationRecheck() {
        rechecked += 1;
      },
      refreshPersistedRecallMessageUi() {
        refreshed += 1;
      },
      recordIgnoredMutationEvent(eventName, detail) {
        ignored = { eventName, detail };
      },
    },
    17,
    { source: "unit-test" },
  );

  assert.equal(invalidated, 0);
  assert.equal(rechecked, 0);
  assert.equal(refreshed, 1);
  assert.equal(result.lightweight, true);
  assert.equal(ignored?.eventName, "message-updated");
  assert.equal(ignored?.detail?.reason, "lightweight-refresh-only");
}

{
  let removedMessageIndex = null;
  let invalidated = 0;
  let rechecked = 0;
  let refreshed = 0;

  onMessageEditedController(
    {
      isMvuExtraAnalysisGuardActive: () => false,
      removeMessageRecallRecord(messageIndex) {
        removedMessageIndex = messageIndex;
      },
      invalidateRecallAfterHistoryMutation() {
        invalidated += 1;
      },
      scheduleHistoryMutationRecheck() {
        rechecked += 1;
      },
      refreshPersistedRecallMessageUi() {
        refreshed += 1;
      },
    },
    9,
    { source: "unit-test" },
  );

  assert.equal(removedMessageIndex, 9);
  assert.equal(invalidated, 1);
  assert.equal(rechecked, 1);
  assert.equal(refreshed, 1);
}

{
  const bindings = [];
  const runtime = {
    eventSource: {
      on(eventName, handler) {
        bindings.push({ eventName, handler });
      },
    },
    eventTypes: {
      MESSAGE_UPDATED: "message-updated",
      MESSAGE_EDITED: "message-edited",
      CHAT_CHANGED: "chat-changed",
    },
    handlers: {
      onChatChanged() {},
      onMessageEdited() {},
      onMessageUpdated() {},
    },
    registerBeforeCombinePrompts() {
      return null;
    },
    registerGenerationAfterCommands() {
      return null;
    },
    getCoreEventBindingState() {
      return { registered: false, cleanups: [] };
    },
    setCoreEventBindingState() {},
  };

  registerCoreEventHooksController(runtime);
  const updatedBinding = bindings.find((entry) => entry.eventName === "message-updated");
  const editedBinding = bindings.find((entry) => entry.eventName === "message-edited");
  assert.equal(updatedBinding?.handler, runtime.handlers.onMessageUpdated);
  assert.equal(editedBinding?.handler, runtime.handlers.onMessageEdited);
}

console.log("message-updated-lightweight tests passed");
