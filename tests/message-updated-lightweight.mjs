import assert from "node:assert/strict";
import {
  onMessageEditedController,
  onMessageUpdatedController,
} from "../host/event-binding.js";

function testMessageUpdatedIsLightweightOnly() {
  let invalidated = 0;
  let rechecked = 0;
  let refreshed = 0;
  const ignored = [];

  const result = onMessageUpdatedController(
    {
      getCurrentGenerationWorkload: () => null,
      invalidateRecallAfterHistoryMutation: () => {
        invalidated += 1;
      },
      scheduleHistoryMutationRecheck: () => {
        rechecked += 1;
      },
      noteIgnoredMutationEvent: (...args) => {
        ignored.push(args);
      },
      refreshPersistedRecallMessageUi: () => {
        refreshed += 1;
      },
    },
    5,
    { isAssistant: true },
  );

  assert.equal(invalidated, 0);
  assert.equal(rechecked, 0);
  assert.equal(refreshed, 1);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0][0], "MESSAGE_UPDATED");
  assert.equal(result.lightweight, true);
  assert.equal(result.reason, "lightweight-refresh-only");
}

function testMessageEditedStillInvalidatesByDefault() {
  let invalidated = 0;
  const rechecked = [];
  let refreshed = 0;

  const result = onMessageEditedController(
    {
      shouldTreatMutationAsBackground: () => false,
      invalidateRecallAfterHistoryMutation: () => {
        invalidated += 1;
      },
      scheduleHistoryMutationRecheck: (...args) => {
        rechecked.push(args);
      },
      refreshPersistedRecallMessageUi: () => {
        refreshed += 1;
      },
    },
    7,
    { isAssistant: true },
  );

  assert.equal(invalidated, 1);
  assert.equal(rechecked.length, 1);
  assert.equal(refreshed, 1);
  assert.equal(result.downgraded, false);
  assert.equal(result.lightweight, false);
}

function testBackgroundPluginMessageEditIsDowngraded() {
  let invalidated = 0;
  let rechecked = 0;
  let refreshed = 0;
  const ignored = [];
  const workload = {
    kind: "background-plugin",
    backgroundReason: "mvu-extra-analysis",
    sourceEvidence: ["mvu-runtime-method"],
    active: true,
  };

  const result = onMessageEditedController(
    {
      getCurrentGenerationWorkload: () => workload,
      shouldTreatMutationAsBackground: () => true,
      invalidateRecallAfterHistoryMutation: () => {
        invalidated += 1;
      },
      scheduleHistoryMutationRecheck: () => {
        rechecked += 1;
      },
      noteIgnoredMutationEvent: (...args) => {
        ignored.push(args);
      },
      refreshPersistedRecallMessageUi: () => {
        refreshed += 1;
      },
    },
    9,
    { isAssistant: true },
  );

  assert.equal(invalidated, 0);
  assert.equal(rechecked, 0);
  assert.equal(refreshed, 1);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0][0], "MESSAGE_EDITED");
  assert.equal(result.downgraded, true);
  assert.equal(result.reason, "background-mutation-downgraded");
}

testMessageUpdatedIsLightweightOnly();
testMessageEditedStillInvalidatesByDefault();
testBackgroundPluginMessageEditIsDowngraded();

console.log("message-updated-lightweight tests passed");
