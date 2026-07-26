import assert from "node:assert/strict";
import {
  classifyGenerationKind,
  createGenerationContextTracker,
  resolveGenerationParentUserFloor,
} from "../runtime/generation-context.js";

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
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
  });

  tracker.noteSwipe(7);
  const context = tracker.begin("swipe");

  assert.equal(context.type, "swipe");
  assert.equal(context.kind, "no-new-user");
  assert.equal(context.swipedAssistantFloor, 7);
  assert.equal(context.chatId, chatId);
}

{
  let chatId = "chat-dry-run";
  let now = 2000;
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
  });

  const original = tracker.begin("normal", { existing: true });
  assert.equal(tracker.begin("swipe", {}, { dryRun: true }), null);
  assert.deepEqual(tracker.get(), original);

  now += 1;
  assert.equal(tracker.update("regenerate", {}, { dryRun: true }), null);
  assert.deepEqual(tracker.get(), original);
}

{
  let chatId = "chat-update";
  let now = 3000;
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
  });

  tracker.begin("regenerate");
  now += 25;
  const context = tracker.update(
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
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
    ttlMs: 1000,
  });

  tracker.noteAssistantTailDelete({ chatLengthOrMessageId: 4 });
  now += 20;
  const inferred = tracker.begin("normal", { __stBmeFreshInputHint: false });
  assert.equal(inferred.rawType, "normal");
  assert.equal(inferred.type, "regenerate");
  assert.equal(inferred.kind, "no-new-user");
  assert.equal(inferred.inferredFrom, "assistant-tail-delete-without-fresh-input");

  now += 20;
  const afterCommands = tracker.update("normal", {}, { phase: "GENERATION_AFTER_COMMANDS" });
  assert.equal(afterCommands.rawType, "normal");
  assert.equal(afterCommands.type, "regenerate");
  assert.equal(afterCommands.kind, "no-new-user");
  assert.equal(afterCommands.afterCommandsAt, now);
}

{
  let chatId = "chat-real-normal";
  let now = 3300;
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
    ttlMs: 1000,
  });

  tracker.noteAssistantTailDelete({ chatLengthOrMessageId: 4 });
  now += 20;
  const fresh = tracker.begin("normal", { __stBmeFreshInputHint: true });
  assert.equal(fresh.rawType, "normal");
  assert.equal(fresh.type, "normal");
  assert.equal(fresh.kind, "fresh");
}

{
  let chatId = "chat-ttl";
  let now = 4000;
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
    ttlMs: 10,
  });

  tracker.begin("normal");
  now += 11;

  assert.equal(tracker.get(), null);
  assert.equal(tracker.get({ allowStale: true }), null);
}

{
  let chatId = "chat-original";
  let now = 5000;
  const tracker = createGenerationContextTracker({
    getCurrentChatId: () => chatId,
    now: () => now,
  });

  tracker.begin("normal");
  chatId = "chat-current";

  assert.equal(tracker.get(), null);

  chatId = "chat-original";
  assert.equal(tracker.get(), null);
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
