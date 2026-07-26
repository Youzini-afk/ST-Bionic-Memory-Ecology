import assert from "node:assert/strict";

import { ConversationEngine } from "../../src/core/conversation-engine.js";
import { getHistoryPrefixHash } from "../../src/core/history.js";
import { MemoryStateStore } from "../../src/core/memory-store.js";
import { GenerationCoordinator } from "../../src/generation/generation-coordinator.js";
import {
  CHAT_IDENTITY_METADATA_KEY,
  StHostAdapter,
} from "../../src/host/st-host-adapter.js";
import {
  decideEnaSend,
  EnaPlannerService,
  normalizeEnaOptions,
} from "../../src/planner/ena-planner.js";
import { PlannerSendCoordinator } from "../../src/planner/send-coordinator.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });
const quietLogger = { error() {}, warn() {} };

const userMessage = (text) => ({
  is_user: true,
  is_system: false,
  name: "User",
  mes: text,
});

const identity = (chatKey, {
  chatId = chatKey,
  ownerId = "assistant.png",
} = {}) => ({
  version: 1,
  chatKey,
  ownerType: "character",
  ownerId,
  chatId,
});

class FakeDocument {
  listeners = new Map();
  clickCount = 0;

  constructor() {
    this.textarea = { id: "send_textarea", value: "" };
    this.stopButton = { id: "mes_stop", style: { display: "none" } };
    this.button = {
      id: "send_but",
      contains: (target) => target === this.button,
      click: () => {
        this.clickCount += 1;
        this.dispatch("click", this.event(this.button));
      },
    };
  }

  getElementById(id) {
    if (id === "send_textarea") return this.textarea;
    if (id === "send_but") return this.button;
    if (id === "mes_stop") return this.stopButton;
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  dispatch(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }

  event(target, extra = {}) {
    return {
      target,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...extra,
    };
  }
}

function createRuntime({ recall, plannerRun, enaOptions = { enabled: true } } = {}) {
  const state = {
    chatId: "chat-a",
    chat: [],
    chatMetadata: { [CHAT_IDENTITY_METADATA_KEY]: identity("chat-a") },
    characters: [{ avatar: "assistant.png" }],
    injections: [],
  };
  const documentLike = new FakeDocument();
  const context = {
    get chatId() { return state.chatId; },
    get chat() { return state.chat; },
    get chatMetadata() { return state.chatMetadata; },
    get characters() { return state.characters; },
    characterId: 0,
    groupId: "",
    name1: "User",
    name2: "Assistant",
    setExtensionPrompt(...args) { state.injections.push(args); },
  };
  let clock = 100;
  let id = 0;
  const store = new MemoryStateStore({ now: () => ++clock, id: () => `planner-tx-${++id}` });
  const engine = new ConversationEngine({ store });
  const host = new StHostAdapter({
    getContext: () => context,
    documentLike,
    logger: quietLogger,
  });
  const plannerService = { run: plannerRun };
  const sendPlanner = new PlannerSendCoordinator({
    engine,
    host,
    recall,
    planner: plannerService,
    getOptions: () => enaOptions,
    logger: quietLogger,
  });
  const bridge = {
    takeCalls: 0,
    bindCalls: 0,
    cancelCalls: 0,
    bindGeneration(args) {
      this.bindCalls += 1;
      return sendPlanner.bindGeneration(args);
    },
    takePending(args) {
      this.takeCalls += 1;
      return sendPlanner.takePending(args);
    },
    cancelPending(reason) {
      this.cancelCalls += 1;
      return sendPlanner.cancelPending(reason);
    },
  };
  const generation = new GenerationCoordinator({
    engine,
    host,
    recall,
    planner: bridge,
    logger: quietLogger,
  });
  return {
    state,
    documentLike,
    store,
    engine,
    host,
    sendPlanner,
    bridge,
    generation,
  };
}

async function createPlannedUser(runtime, raw = "raw input") {
  await runtime.generation.onChatChanged();
  runtime.documentLike.textarea.value = raw;
  const planned = await runtime.sendPlanner.handleUserSend(raw);
  assert.equal(planned.status, "resumed", planned.error?.stack);
  await runtime.generation.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage(planned.augmentedUserMessage));
  const prepared = await runtime.generation.onMessageSent(0);
  return { planned, prepared };
}

test("ENA options are strict and default disabled", () => {
  assert.equal(normalizeEnaOptions({}).enabled, false);
  assert.equal(decideEnaSend("hello", {}).reason, "disabled");
  assert.equal(decideEnaSend("/help", { enabled: true }).reason, "slash-command");
  assert.equal(decideEnaSend("hello", { enabled: true }).intercept, true);
  assert.throws(() => normalizeEnaOptions({ enabled: "yes" }), /boolean/);
  assert.throws(() => normalizeEnaOptions({ legacyApiUrl: "x" }), /unknown ENA option/);
});

test("disabled click and Enter pass through without planner side effects", async () => {
  const documentLike = new FakeDocument();
  const host = new StHostAdapter({
    getContext: () => ({ chatId: "chat", chat: [], setExtensionPrompt() {} }),
    documentLike,
    logger: quietLogger,
  });
  let handles = 0;
  const cleanup = host.bindPlannerSend({
    decideUserSend: () => ({ intercept: false, reason: "disabled" }),
    handleUserSend: async () => { handles += 1; },
  });
  documentLike.textarea.value = "normal input";
  const click = documentLike.dispatch("click", documentLike.event(documentLike.button));
  const enter = documentLike.dispatch("keydown", documentLike.event(documentLike.textarea, {
    key: "Enter",
    shiftKey: false,
  }));
  await Promise.resolve();
  assert.equal(click.prevented, false);
  assert.equal(enter.prevented, false);
  assert.equal(handles, 0);
  cleanup();
});

test("enabled click and Enter intercept once, while synchronous replay bypasses recursion", async () => {
  const documentLike = new FakeDocument();
  let sendOnEnter = true;
  const host = new StHostAdapter({
    getContext: () => ({
      chatId: "chat",
      chat: [],
      setExtensionPrompt() {},
      shouldSendOnEnter: () => sendOnEnter,
    }),
    documentLike,
    logger: quietLogger,
  });
  let handles = 0;
  let decisions = 0;
  const coordinator = {
    decideUserSend: (input) => {
      decisions += 1;
      return { intercept: true, reason: "enabled", input };
    },
    async handleUserSend(input, decision) {
      assert.equal(decision.input, input);
      handles += 1;
    },
  };
  const cleanup = host.bindPlannerSend(coordinator);
  documentLike.textarea.value = "normal input";
  const click = documentLike.dispatch("click", documentLike.event(documentLike.button));
  sendOnEnter = false;
  const newline = documentLike.dispatch("keydown", documentLike.event(documentLike.textarea, {
    key: "Enter",
    shiftKey: false,
  }));
  sendOnEnter = true;
  documentLike.stopButton.style.display = "flex";
  const generating = documentLike.dispatch("keydown", documentLike.event(documentLike.textarea, {
    key: "Enter",
    shiftKey: false,
  }));
  documentLike.stopButton.style.display = "none";
  const enter = documentLike.dispatch("keydown", documentLike.event(documentLike.textarea, {
    key: "Enter",
    shiftKey: false,
  }));
  await Promise.resolve();
  assert.equal(click.prevented, true);
  assert.equal(newline.prevented, false);
  assert.equal(generating.prevented, false);
  assert.equal(enter.prevented, true);
  assert.equal(handles, 2);
  assert.equal(decisions, 2);
  host.resumeUserSend("planned");
  await Promise.resolve();
  assert.equal(handles, 2);
  assert.equal(decisions, 2);
  assert.equal(documentLike.clickCount, 1);
  cleanup();
});

test("planner service builds profile context from raw input and filters tagged output", async () => {
  let capturedContext = null;
  let capturedOptions = null;
  let streamed = null;
  const service = new EnaPlannerService({
    getSettings: () => ({ taskProfiles: {} }),
    getHostContext: () => ({
      snapshot: {
        character: {
          name: "Alice",
          raw: { description: "desc", personality: "calm", scenario: "room" },
        },
      },
      prompt: { userPersona: "persona" },
    }),
    buildPrompt: async (_settings, taskType, context) => {
      assert.equal(taskType, "planner");
      assert.equal(context.userMessage, "  raw input  ");
      capturedContext = context;
      return {
        profile: { id: "planner-profile", generation: {} },
        executionMessages: [{ role: "user", content: context.plannerUserInput }],
      };
    },
    buildPayload: (build) => ({
      systemPrompt: "",
      userPrompt: "",
      promptMessages: build.executionMessages,
      additionalMessages: [],
    }),
    complete: async (_system, _user, options) => {
      capturedOptions = options;
      options.onStreamProgress?.({ previewText: "partial", chunkCount: 1 });
      return "<thinking>hidden</thinking><plot>advance</plot>junk<note>steady</note>";
    },
  });
  const result = await service.run({
    rawUserInput: "  raw input  ",
    recallText: "memory",
    history: [{ role: "assistant", speaker: "Alice", text: "last reply" }],
    plannerRecords: [{
      createdAt: 1,
      plotText: "<plot>previous</plot>",
      plotBlocks: ["<plot>previous</plot>"],
    }],
    options: { enabled: true },
    onProgress: (progress) => { streamed = progress; },
  });
  assert.match(capturedContext.plannerCharacterCard, /Alice/);
  assert.match(capturedContext.plannerMemory, /memory/);
  assert.match(capturedContext.plannerPreviousPlots, /previous/);
  assert.match(capturedContext.plannerRecentChat, /last reply/);
  assert.match(capturedContext.plannerUserInput, /raw input/);
  assert.equal(capturedOptions.taskType, "planner");
  assert.deepEqual(streamed, { previewText: "partial", chunkCount: 1 });
  assert.equal(result.filtered, "<plot>advance</plot>\n\n<note>steady</note>");
  assert.deepEqual(result.plotBlocks, ["<plot>advance</plot>"]);
  assert.equal(result.promptProfileId, "planner-profile");
});

test("nonempty planner recall is reused and both records commit with access effects", async () => {
  const reasons = [];
  const runtime = createRuntime({
    recall: async ({ reason, input, state }) => {
      reasons.push(reason);
      const before = state.collections.nodes.get("memory");
      assert.equal(input, "raw input");
      return {
        selectedNodeIds: ["memory"],
        injectionText: "PLANNER MEMORY",
        tokenEstimate: 2,
        changeSet: {
          changes: [{
            collection: "nodes",
            id: "memory",
            before,
            after: { ...before, accessCount: before.accessCount + 1 },
          }],
        },
      };
    },
    plannerRun: async ({ rawUserInput, recallText }) => {
      assert.equal(rawUserInput, "raw input");
      assert.equal(recallText, "PLANNER MEMORY");
      return {
        filtered: "<plot>advance</plot>\n\n<note>steady</note>",
        plotBlocks: ["<plot>advance</plot>"],
        promptProfileId: "planner-profile",
      };
    },
  });
  await runtime.generation.onChatChanged();
  await runtime.store.commit({
    chatKey: "chat-a",
    expectedRevision: 0,
    operation: "seed",
    basisHistoryLength: 0,
    basisHistoryHash: getHistoryPrefixHash([], 0),
    processedThroughAfter: -1,
    changeSet: {
      changes: [{
        collection: "nodes",
        id: "memory",
        before: null,
        after: { id: "memory", accessCount: 0 },
      }],
    },
  });
  runtime.documentLike.textarea.value = "raw input";
  const planned = await runtime.sendPlanner.handleUserSend("raw input");
  await runtime.generation.onGenerationStarted("normal");
  const storedUserText = planned.augmentedUserMessage.replace("raw input", "HOST TRANSFORMED");
  runtime.state.chat.push(userMessage(storedUserText));
  const prepared = await runtime.generation.onMessageSent(0);
  const state = await runtime.store.readConversation("chat-a");
  assert.equal(prepared.source, "planner-reuse", prepared.error?.stack);
  assert.deepEqual(reasons, ["planner"]);
  assert.equal(state.collections.nodes.get("memory").accessCount, 1);
  assert.equal(state.plannerRecords.size, 1);
  assert.equal(state.recallRecords.size, 1);
  const planner = [...state.plannerRecords.values()][0];
  const recall = [...state.recallRecords.values()][0];
  assert.equal(planner.rawUserInput, "raw input");
  assert.equal(planner.augmentedUserMessage, storedUserText);
  assert.equal(planner.recallTurnKey, recall.turnKey);
  assert.equal(recall.recallInput, "raw input");
});

test("failed planner recall still persists planning and main recall uses raw input", async () => {
  const reasons = [];
  const inputs = [];
  const runtime = createRuntime({
    recall: async ({ reason, input }) => {
      reasons.push(reason);
      inputs.push(input);
      if (reason === "planner") throw new Error("planner recall unavailable");
      return { selectedNodeIds: [], injectionText: `FRESH:${input}`, tokenEstimate: 1 };
    },
    plannerRun: async ({ recallText }) => {
      assert.equal(recallText, "");
      return {
        filtered: "<plot>planned without memory</plot>",
        plotBlocks: ["<plot>planned without memory</plot>"],
        promptProfileId: "planner-profile",
      };
    },
  });
  const { prepared } = await createPlannedUser(runtime);
  const state = await runtime.store.readConversation("chat-a");
  assert.equal(prepared.source, "fresh", prepared.error?.stack);
  assert.deepEqual(reasons, ["planner", "fresh-after-planner"]);
  assert.deepEqual(inputs, ["raw input", "raw input"]);
  assert.equal(state.plannerRecords.size, 1);
  assert.equal(state.recallRecords.size, 1);
  assert.equal([...state.plannerRecords.values()][0].recallTurnKey, "");
});

test("empty planner recall does not suppress the main fresh recall", async () => {
  const reasons = [];
  const runtime = createRuntime({
    recall: async ({ reason, input }) => {
      reasons.push(reason);
      if (reason === "planner") {
        return { selectedNodeIds: [], injectionText: "", tokenEstimate: 0 };
      }
      return { selectedNodeIds: ["fresh"], injectionText: `FRESH:${input}`, tokenEstimate: 1 };
    },
    plannerRun: async () => ({
      filtered: "<plot>planned</plot>",
      plotBlocks: ["<plot>planned</plot>"],
      promptProfileId: "planner-profile",
    }),
  });
  const { prepared } = await createPlannedUser(runtime);
  const state = await runtime.store.readConversation("chat-a");
  assert.equal(prepared.source, "fresh");
  assert.deepEqual(reasons, ["planner", "fresh-after-planner"]);
  assert.deepEqual(prepared.selectedNodeIds, ["fresh"]);
  assert.equal(state.plannerRecords.size, 1);
  assert.equal(state.recallRecords.size, 1);
});

test("planner failure sends original input and creates no PlannerRecord", async () => {
  const reasons = [];
  const inputs = [];
  const runtime = createRuntime({
    recall: async ({ reason, input }) => {
      reasons.push(reason);
      inputs.push(input);
      return { selectedNodeIds: [], injectionText: `${reason}:${input}`, tokenEstimate: 1 };
    },
    plannerRun: async () => { throw new Error("planner failed"); },
  });
  await runtime.generation.onChatChanged();
  const originalInput = "  raw input  \n";
  runtime.documentLike.textarea.value = originalInput;
  const result = await runtime.sendPlanner.handleUserSend(originalInput);
  assert.equal(result.status, "fail-open");
  assert.equal(runtime.documentLike.textarea.value, originalInput);
  await runtime.generation.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage(originalInput));
  const prepared = await runtime.generation.onMessageSent(0);
  const state = await runtime.store.readConversation("chat-a");
  assert.equal(prepared.source, "fresh");
  assert.deepEqual(reasons, ["planner", "fresh"]);
  assert.deepEqual(inputs, [originalInput, originalInput]);
  assert.equal(state.plannerRecords.size, 0);
  assert.equal(state.recallRecords.size, 1);
});

test("a planner result never overwrites input edited while planning", async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const runtime = createRuntime({
    recall: async () => ({ injectionText: "", selectedNodeIds: [], tokenEstimate: 0 }),
    plannerRun: async () => {
      await new Promise((resolve) => {
        release = resolve;
        started();
      });
      return {
        filtered: "<plot>late local result</plot>",
        plotBlocks: ["<plot>late local result</plot>"],
        promptProfileId: "planner-profile",
      };
    },
  });
  await runtime.generation.onChatChanged();
  runtime.documentLike.textarea.value = "original";
  const pending = runtime.sendPlanner.handleUserSend("original");
  await waiting;
  runtime.documentLike.textarea.value = "user kept editing";
  release();
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "input-changed");
  assert.equal(runtime.documentLike.textarea.value, "user kept editing");
  assert.equal(runtime.documentLike.clickCount, 0);
  assert.equal(runtime.sendPlanner.isBusy, false);
});

test("reroll reads only RecallRecord and never consumes planner state", async () => {
  let recallCalls = 0;
  const runtime = createRuntime({
    recall: async ({ input }) => {
      recallCalls += 1;
      return { selectedNodeIds: ["m"], injectionText: `MEM:${input}`, tokenEstimate: 1 };
    },
    plannerRun: async () => ({
      filtered: "<plot>advance</plot>",
      plotBlocks: ["<plot>advance</plot>"],
      promptProfileId: "planner-profile",
    }),
  });
  const { prepared } = await createPlannedUser(runtime);
  assert.equal(prepared.source, "planner-reuse");
  runtime.generation.onGenerationFinished();
  const takesBefore = runtime.bridge.takeCalls;
  const plannerBefore = [...(await runtime.store.readConversation("chat-a")).plannerRecords.values()][0];
  await runtime.generation.onGenerationStarted("regenerate");
  const reroll = await runtime.generation.onGenerationAfterCommands();
  const plannerAfter = [...(await runtime.store.readConversation("chat-a")).plannerRecords.values()][0];
  assert.equal(reroll.source, "replay");
  assert.equal(reroll.injectionText, prepared.injectionText);
  assert.equal(runtime.bridge.takeCalls, takesBefore);
  assert.equal(recallCalls, 1);
  assert.deepEqual(plannerAfter, plannerBefore);
});

test("a late planner result cannot resume into another chat", async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const runtime = createRuntime({
    recall: async () => ({ injectionText: "", selectedNodeIds: [], tokenEstimate: 0 }),
    plannerRun: async () => {
      started();
      await new Promise((resolve) => { release = resolve; });
      return {
        filtered: "<plot>late</plot>",
        plotBlocks: ["<plot>late</plot>"],
        promptProfileId: "planner-profile",
      };
    },
  });
  await runtime.generation.onChatChanged();
  runtime.documentLike.textarea.value = "chat a input";
  const pending = runtime.sendPlanner.handleUserSend("chat a input");
  await waiting;
  runtime.state.characters = [{ avatar: "other.png" }];
  runtime.state.chatMetadata = {
    [CHAT_IDENTITY_METADATA_KEY]: identity("chat-b", {
      chatId: "chat-a",
      ownerId: "other.png",
    }),
  };
  runtime.state.chat = [];
  await runtime.generation.onChatChanged();
  release();
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(runtime.documentLike.clickCount, 0);
  assert.equal((await runtime.store.readConversation("chat-a")).plannerRecords.size, 0);
  assert.equal((await runtime.store.readConversation("chat-b")).plannerRecords.size, 0);
});

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`vNext planner: ${passed}/${tests.length} passed`);
