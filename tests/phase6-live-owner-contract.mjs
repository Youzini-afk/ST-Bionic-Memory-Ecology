import assert from "node:assert/strict";

import { createBmeMemoryLifecycleRuntime } from "../application/memory-lifecycle-runtime.js";
import { buildConversationEvidenceSnapshot } from "../host/conversation-snapshot.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:phase6-live-owner";
const repository = new InMemoryLedgerRepository(chatId, 1);
let settings = {
  agentContextWindowTokens: 128000,
  agentMaxToolCalls: 500,
  agentMaxRunMs: 8 * 60 * 1000,
};
let stewardFactoryCount = 0;
let recallFactoryCount = 0;
let stewardWakeCount = 0;
let blockStewardWake = false;
let releaseStewardWake = null;
const recallRequests = [];
const projected = [];

const runtime = createBmeMemoryLifecycleRuntime({
  memoryLedgerRepository: repository,
  settingsProvider: () => settings,
  now: (() => {
    let value = 100;
    return () => ++value;
  })(),
  stewardRuntimeFactory({ settings: runtimeSettings, onStatus }) {
    stewardFactoryCount += 1;
    assert.equal(runtimeSettings.maxToolCalls, settings.agentMaxToolCalls);
    const bundleMaxToolCalls = runtimeSettings.maxToolCalls;
    return {
      service: {
        inspect: () => ({ running: false }),
      },
      async wake(requestChatId) {
        stewardWakeCount += 1;
        if (blockStewardWake) {
          await new Promise((resolve) => {
            releaseStewardWake = resolve;
          });
        }
        onStatus?.({ chatId: requestChatId, status: "completed" });
        return [{ bundleMaxToolCalls }];
      },
      dispose() {},
    };
  },
  recallRuntimeFactory({ settings: runtimeSettings }) {
    recallFactoryCount += 1;
    assert.equal(runtimeSettings.maxRunMs, settings.agentMaxRunMs);
    const bundleMaxToolCalls = runtimeSettings.maxToolCalls;
    return {
      service: {
        inspect: () => ({ active: [] }),
      },
      async recall(request) {
        recallRequests.push({ request, bundleMaxToolCalls });
        return {
          artifactId: `artifact:${request.turnId}`,
          chatId: request.chatId,
          turnId: request.turnId,
          inputFingerprint: "input:phase6",
          historyFingerprint: request.historyFingerprint,
          memoryStateFingerprint: "memory:phase6",
          selectedNodeIds: [],
          selectedMemoryIds: [],
          candidateMemoryIds: [],
          injectionText: "",
          empty: true,
          stats: { coreCount: 0, recallCount: 0 },
        };
      },
      dispose() {},
    };
  },
  onProjection(event) {
    projected.push(event);
  },
});

const identity = { chatId, hostChatId: "phase6.jsonl" };
const completedChat = [
  { is_user: true, mes: "Remember the orchard.", send_date: "u1", name: "User" },
  { is_user: false, mes: "The orchard is north.", send_date: "a1", name: "Alice" },
];
const completedSnapshot = buildConversationEvidenceSnapshot(completedChat, {
  chatId,
  hostChatId: identity.hostChatId,
});
const initialized = await runtime.initialize({
  identity,
  conversationSnapshot: completedSnapshot,
  legacySourceReady: true,
  legacyGraph: {
    version: 8,
    nodes: [
      {
        id: "memory:orchard",
        type: "place",
        seq: 1,
        seqRange: [1, 1],
        fields: { name: "orchard" },
        scope: { layer: "objective" },
      },
    ],
    edges: [],
  },
});
assert.equal(initialized.migration.plan.migrated, true);
assert.equal(initialized.projection.graph.nodes.length, 1);
assert.equal(projected.length, 1);

await Promise.all([
  runtime.wakeSteward(chatId, { previousGraph: initialized.projection.graph }),
  runtime.wakeSteward(chatId, { previousGraph: initialized.projection.graph }),
]);
assert.equal(stewardFactoryCount, 1);
assert.equal(recallFactoryCount, 1);
assert.equal(stewardWakeCount, 2, "service-level wake coalescing remains the Steward's responsibility");

const pendingUser = {
  is_user: true,
  mes: "What do I remember now?",
  send_date: "u2",
  name: "User",
};
const pendingSnapshot = buildConversationEvidenceSnapshot(
  [...completedChat, pendingUser],
  { chatId, hostChatId: identity.hostChatId },
);
const pendingRecall = await runtime.recall({
  identity,
  conversationSnapshot: pendingSnapshot,
  userMessage: pendingUser.mes,
  userFloor: 2,
  recentMessages: ["[assistant]: The orchard is north."],
  previousGraph: initialized.projection.graph,
});
assert.equal(pendingRecall.empty, true);
assert.equal(pendingRecall.turnPending, true);
assert.equal(recallRequests.length, 1);

const completedSecondSnapshot = buildConversationEvidenceSnapshot(
  [
    ...completedChat,
    pendingUser,
    { is_user: false, mes: "You remember the orchard.", send_date: "a2", name: "Alice" },
  ],
  { chatId, hostChatId: identity.hostChatId },
);
const completedRecall = await runtime.recall({
  identity,
  conversationSnapshot: completedSecondSnapshot,
  userMessage: pendingUser.mes,
  userFloor: 2,
  previousGraph: initialized.projection.graph,
});
assert.equal(completedRecall.turnId, pendingRecall.turnId);
assert.equal(stewardFactoryCount, 1);
assert.equal(recallFactoryCount, 1);

settings = { ...settings, agentMaxToolCalls: 750 };
await runtime.recall({
  identity,
  conversationSnapshot: completedSecondSnapshot,
  userMessage: pendingUser.mes,
  userFloor: 2,
  previousGraph: initialized.projection.graph,
});
assert.equal(stewardFactoryCount, 2);
assert.equal(recallFactoryCount, 2);

blockStewardWake = true;
const oldSettingsWake = runtime.wakeSteward(chatId, {
  previousGraph: initialized.projection.graph,
});
await Promise.resolve();
settings = { ...settings, agentMaxToolCalls: 900 };
await runtime.recall({
  identity,
  conversationSnapshot: completedSecondSnapshot,
  userMessage: pendingUser.mes,
  userFloor: 2,
  previousGraph: initialized.projection.graph,
});
assert.equal(
  recallRequests.at(-1).bundleMaxToolCalls,
  900,
  "a new Recall must immediately use the new BME model/settings bundle",
);
assert.equal(stewardFactoryCount, 3);
assert.equal(recallFactoryCount, 3);
assert.equal(runtime.inspect(chatId).agentBundleCount, 2);
blockStewardWake = false;
releaseStewardWake();
await oldSettingsWake;
assert.equal(runtime.inspect(chatId).agentBundleCount, 1);

runtime.dispose();
console.log("phase 6 live owner contract tests passed");
