import assert from "node:assert/strict";
import {
  classifyGenerationKind,
  createConversationSession,
  resolveGenerationParentUserFloor,
} from "../runtime/conversation-session.js";

assert.equal(classifyGenerationKind("normal"), "fresh");
assert.equal(classifyGenerationKind("swipe"), "no-new-user");
assert.equal(classifyGenerationKind("regenerate"), "no-new-user");
assert.equal(classifyGenerationKind("continue"), "no-new-user");
assert.equal(classifyGenerationKind("quiet"), "skip");
assert.equal(classifyGenerationKind("impersonate"), "skip");
assert.equal(classifyGenerationKind("normal", { automatic_trigger: true }), "skip");
assert.equal(classifyGenerationKind("normal", { quiet_prompt: true }), "skip");

{
  let chatId = "chat-swipe";
  let now = 1000;
  const tracker = createConversationSession({
    now: () => now,
  });
  tracker.enterChat({ chatId });

  tracker.noteSwipe(7);
  const context = tracker.beginGeneration("swipe");

  assert.equal(context.type, "swipe");
  assert.equal(context.kind, "no-new-user");
  assert.equal(context.swipedAssistantFloor, 7);
  assert.equal(context.chatId, chatId);
}

{
  let chatId = "chat-dry-run";
  let now = 2000;
  const tracker = createConversationSession({
    now: () => now,
  });
  tracker.enterChat({ chatId });

  const original = tracker.beginGeneration("normal", { existing: true });
  assert.equal(tracker.beginGeneration("swipe", {}, { dryRun: true }), null);
  assert.deepEqual(tracker.getGeneration(), original);

  now += 1;
  assert.equal(tracker.updateGeneration("regenerate", {}, { dryRun: true }), null);
  assert.deepEqual(tracker.getGeneration(), original);
}

{
  let chatId = "chat-update";
  let now = 3000;
  const tracker = createConversationSession({
    now: () => now,
  });
  tracker.enterChat({ chatId });

  tracker.beginGeneration("regenerate");
  now += 25;
  const context = tracker.updateGeneration(
    "regenerate",
    {},
    { phase: "GENERATION_AFTER_COMMANDS" },
  );

  assert.equal(context.type, "regenerate");
  assert.equal(context.kind, "no-new-user");
  assert.equal(context.afterCommandsAt, now);
}

{
  let chatId = "chat-group-regenerate";
  let now = 3200;
  const tracker = createConversationSession({
    now: () => now,
    rerollInferenceWindowMs: 1000,
  });
  tracker.enterChat({ chatId });

  tracker.noteAssistantTailDelete({ chatLengthOrMessageId: 4 });
  now += 20;
  const inferred = tracker.beginGeneration("normal", { __stBmeFreshInputHint: false });
  assert.equal(inferred.rawType, "normal");
  assert.equal(inferred.type, "regenerate");
  assert.equal(inferred.kind, "no-new-user");
  assert.equal(inferred.inferredFrom, "assistant-tail-delete-without-fresh-input");

  now += 20;
  const afterCommands = tracker.updateGeneration("normal", {}, { phase: "GENERATION_AFTER_COMMANDS" });
  assert.equal(afterCommands.rawType, "normal");
  assert.equal(afterCommands.type, "regenerate");
  assert.equal(afterCommands.kind, "no-new-user");
  assert.equal(afterCommands.afterCommandsAt, now);
}

{
  let chatId = "chat-real-normal";
  let now = 3300;
  const tracker = createConversationSession({
    now: () => now,
    rerollInferenceWindowMs: 1000,
  });
  tracker.enterChat({ chatId });

  tracker.noteAssistantTailDelete({ chatLengthOrMessageId: 4 });
  now += 20;
  const fresh = tracker.beginGeneration("normal", { __stBmeFreshInputHint: true });
  assert.equal(fresh.rawType, "normal");
  assert.equal(fresh.type, "normal");
  assert.equal(fresh.kind, "fresh");
}

{
  const chatId = "chat-explicit-lifecycle";
  let now = 4000;
  const tracker = createConversationSession({
    now: () => now,
  });
  tracker.enterChat({ chatId });

  tracker.beginGeneration("normal");
  now += 60000;
  assert.equal(tracker.getGeneration()?.chatId, chatId);

  tracker.clearGeneration("generation-ended");
  assert.equal(tracker.getGeneration(), null);
}

{
  let chatId = "chat-original";
  let now = 5000;
  const tracker = createConversationSession({
    now: () => now,
  });
  tracker.enterChat({ chatId });

  tracker.beginGeneration("normal");
  const lease = tracker.captureLease({ requireGeneration: true });
  chatId = "chat-current";
  tracker.enterChat({ chatId }, { forceNewEpoch: true });

  assert.equal(tracker.getGeneration(), null);
  assert.equal(tracker.isLeaseCurrent(lease, { requireGeneration: true }), false);

  chatId = "chat-original";
  tracker.enterChat({ chatId }, { forceNewEpoch: true });
  assert.equal(tracker.getGeneration(), null);
}

{
  const tracker = createConversationSession();
  const first = tracker.enterChat({
    chatId: "host-chat-42",
    hostChatId: "host-chat-42",
  });
  const lease = tracker.captureLease();
  tracker.beginGeneration("normal");
  tracker.setInput("pendingRecallSendIntent", { text: "preserve me" });
  const promoted = tracker.enterChat({
    chatId: "integrity-42",
    hostChatId: "host-chat-42",
    integrity: "integrity-42",
  });

  assert.equal(promoted.changed, false);
  assert.equal(promoted.epoch, first.epoch);
  assert.equal(tracker.isLeaseCurrent(lease), true);
  assert.equal(tracker.getGeneration()?.chatId, "integrity-42");
  assert.equal(
    tracker.getInput("pendingRecallSendIntent")?.text,
    "preserve me",
  );
}

{
  const chat = [
    { is_system: true, mes: "greeting" },
    { is_user: true, mes: "first" },
    { is_user: false, mes: "assistant first" },
    { is_user: true, mes: "parent" },
    { is_user: false, mes: "assistant active" },
  ];

  assert.equal(
    resolveGenerationParentUserFloor(chat, {
      type: "swipe",
      swipedAssistantFloor: 4,
    }),
    3,
  );
  assert.equal(resolveGenerationParentUserFloor(chat, { type: "regenerate" }), 3);
}

{
  const chatAfterRegenerateDelete = [
    { is_system: true, mes: "greeting" },
    { is_user: true, mes: "parent" },
  ];
  assert.equal(
    resolveGenerationParentUserFloor(chatAfterRegenerateDelete, {
      type: "regenerate",
    }),
    1,
  );
}

{
  const chat = [
    { is_system: true, mes: "greeting" },
    { is_user: true, mes: "hidden", is_system: true },
    { is_user: true, mes: "visible" },
    { is_user: false, mes: "assistant" },
  ];
  assert.equal(
    resolveGenerationParentUserFloor(chat, { type: "swipe", swipedAssistantFloor: 3 }),
    2,
  );
}
