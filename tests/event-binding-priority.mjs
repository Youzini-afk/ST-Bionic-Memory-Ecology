import assert from "node:assert/strict";
import {
  registerBeforeCombinePromptsController,
  registerGenerationAfterCommandsController,
} from "../host/event-binding.js";

function createRuntime(eventSource, overrides = {}) {
  return {
    console: { warn() {} },
    eventSource,
    eventTypes: {
      GENERATE_BEFORE_COMBINE_PROMPTS: "before-combine",
      GENERATION_AFTER_COMMANDS: "after-commands",
    },
    getEventMakeFirst: () => undefined,
    ...overrides,
  };
}

function testEventSourceMakeFirstWinsAndIsBound() {
  const calls = [];
  const fallbackCalls = [];
  const eventSource = {
    marker: "event-source",
    makeFirst(eventName, listener) {
      assert.equal(this, eventSource);
      calls.push({ eventName, listener });
    },
    removeListener(eventName, listener) {
      calls.push({ removed: eventName, listener });
    },
    on() {
      throw new Error("ordinary .on should not be used when makeFirst exists");
    },
  };
  const runtime = createRuntime(eventSource, {
    getEventMakeFirst: () => (...args) => fallbackCalls.push(args),
  });
  const beforeListener = () => {};
  const afterListener = () => {};

  const beforeCleanup = registerBeforeCombinePromptsController(
    runtime,
    beforeListener,
  );
  const afterCleanup = registerGenerationAfterCommandsController(
    runtime,
    afterListener,
  );

  assert.equal(typeof beforeCleanup, "function");
  assert.equal(typeof afterCleanup, "function");
  assert.deepEqual(calls, [
    { eventName: "before-combine", listener: beforeListener },
    { eventName: "after-commands", listener: afterListener },
  ]);
  assert.deepEqual(fallbackCalls, []);
  beforeCleanup();
  afterCleanup();
  assert.deepEqual(calls.slice(2), [
    { removed: "before-combine", listener: beforeListener },
    { removed: "after-commands", listener: afterListener },
  ]);
}

function testRuntimeMakeFirstFallback() {
  const calls = [];
  const eventSource = {
    on() {
      throw new Error("ordinary .on should not be used when fallback exists");
    },
  };
  const runtime = createRuntime(eventSource, {
    getEventMakeFirst: () => (eventName, listener) => {
      calls.push({ eventName, listener });
      return `cleanup:${eventName}`;
    },
  });
  const beforeListener = () => {};
  const afterListener = () => {};

  assert.equal(
    registerBeforeCombinePromptsController(runtime, beforeListener),
    "cleanup:before-combine",
  );
  assert.equal(
    registerGenerationAfterCommandsController(runtime, afterListener),
    "cleanup:after-commands",
  );
  assert.deepEqual(calls, [
    { eventName: "before-combine", listener: beforeListener },
    { eventName: "after-commands", listener: afterListener },
  ]);
}

function testOrdinaryOnFallback() {
  const calls = [];
  const eventSource = {
    on(eventName, listener) {
      calls.push({ eventName, listener });
    },
    off(eventName, listener) {
      assert.equal(this, eventSource);
      calls.push({ removed: eventName, listener });
    },
  };
  const runtime = createRuntime(eventSource);
  const beforeListener = () => {};
  const afterListener = () => {};

  const beforeCleanup = registerBeforeCombinePromptsController(runtime, beforeListener);
  const afterCleanup = registerGenerationAfterCommandsController(runtime, afterListener);
  assert.equal(typeof beforeCleanup, "function");
  assert.equal(typeof afterCleanup, "function");
  assert.deepEqual(calls, [
    { eventName: "before-combine", listener: beforeListener },
    { eventName: "after-commands", listener: afterListener },
  ]);
  beforeCleanup();
  afterCleanup();
  assert.deepEqual(calls.slice(2), [
    { removed: "before-combine", listener: beforeListener },
    { removed: "after-commands", listener: afterListener },
  ]);
}

testEventSourceMakeFirstWinsAndIsBound();
testRuntimeMakeFirstFallback();
testOrdinaryOnFallback();

console.log("event-binding-priority tests passed");
