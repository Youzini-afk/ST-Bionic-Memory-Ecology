import assert from "node:assert/strict";
import { RecallAgentToolset } from "../agent/recall-agent-tools.js";
import { RecallAgentService } from "../application/recall-agent-service.js";
import { fingerprintMaterializedMemoryState } from "../domain/memory-changeset.js";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { createMemoryRevision, createTurnEvidence } from "../domain/memory-records.js";
import { createTurnInputFingerprint } from "../domain/turn-artifact.js";
import { DEFAULT_NODE_SCHEMA } from "../graph/schema.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

function seedRepository(chatId) {
  const repository = new InMemoryLedgerRepository(chatId);
  const evidence = createTurnEvidence({
    chatId,
    turnId: "turn:previous",
    userText: "Open the gate.",
    assistantText: "Mira opened the archive gate.",
    assistantFloor: 2,
    createdAt: 2,
  });
  let ledger = appendMemoryLedgerTransaction(repository.ledgers.get(chatId), {
    baseRevision: 0,
    idempotencyKey: "seed:evidence",
    records: [evidence],
    sourceEvidenceIds: [evidence.id],
    now: 2,
  }).ledger;
  const memory = createMemoryRevision({
    chatId,
    memoryId: "memory:gate",
    memoryType: "event",
    fields: { title: "Archive gate", summary: "Mira opened the archive gate." },
    evidenceIds: [evidence.id],
    importance: 8,
    createdAt: 3,
  });
  ledger = appendMemoryLedgerTransaction(ledger, {
    baseRevision: 1,
    idempotencyKey: "seed:memory",
    records: [memory],
    sourceEvidenceIds: [evidence.id],
    now: 3,
  }).ledger;
  repository.ledgers.set(chatId, ledger);
  return { repository, evidence, memory };
}

function candidateBuilder({ graph }) {
  const candidates = graph.nodes
    .filter((node) => !node.archived)
    .map((node, index) => ({
      memoryId: node.id,
      revisionId: node.memoryRevisionId,
      memoryType: node.type,
      fields: node.fields,
      scope: node.scope,
      channels: ["programmatic"],
      rank: index + 1,
    }));
  return Promise.resolve({
    candidateMemoryIds: candidates.map((candidate) => candidate.memoryId),
    initialSelectedMemoryIds: candidates.map((candidate) => candidate.memoryId),
    candidates,
    channels: { programmatic: candidates.length, vectorTail: 0 },
    vectorState: { dirty: false, replayRequiredCount: 0 },
    baseline: {
      selectedMemoryIds: candidates.map((candidate) => candidate.memoryId),
      stats: {},
      retrievalMeta: { source: "test" },
      scopeContext: { enableScopedMemory: false, injectStoryTimeLabel: false },
    },
  });
}

function resultBuilder({ graph, selectedNodeIds = [], schema = [], meta = {} }) {
  const activeNodes = graph.nodes.filter((node) => !node.archived);
  const alwaysInject = new Set(
    schema.filter((type) => type.alwaysInject).map((type) => type.id),
  );
  const selected = new Set(selectedNodeIds);
  const coreNodes = activeNodes.filter((node) => alwaysInject.has(node.type));
  const recallNodes = activeNodes.filter(
    (node) => selected.has(node.id) && !alwaysInject.has(node.type),
  );
  return {
    summaryEntries: [],
    coreNodes,
    recallNodes,
    groupedRecallNodes: {
      state: recallNodes,
      episodic: [],
      reflective: [],
      rule: [],
      other: [],
    },
    scopeBuckets: null,
    selectedNodeIds: [...selected],
    meta,
    stats: {
      totalActive: activeNodes.length,
      summaryCount: 0,
      coreCount: coreNodes.length,
      recallCount: recallNodes.length,
    },
  };
}

const chatId = "chat:recall-agent";
const { repository, memory } = seedRepository(chatId);
const toolset = new RecallAgentToolset({
  repository,
  now: () => 20,
});
let agentRuns = 0;
const agentRuntime = {
  recoverInterruptedRuns: async () => [],
  run: async (input) => {
    agentRuns += 1;
    const scope = { runId: input.runId };
    const context = await toolset.context({}, scope);
    assert.equal(context.packet.candidateMemoryIds.includes(memory.memoryId), true);
    const published = await toolset.publish(
      { selectedMemoryIds: [memory.memoryId], reason: "The gate is relevant." },
      scope,
    );
    assert.equal(published.published, true);
    return { status: "completed" };
  },
};
const service = new RecallAgentService({
  repository,
  agentRuntime,
  toolset,
  candidateBuilder,
  resultBuilder,
  now: () => 10,
});
const request = {
  chatId,
  turnId: "turn:current",
  userMessage: "What happened at the gate?",
  recentMessages: ["Mira entered the archive."],
  historyFingerprint: "history:current",
  schema: DEFAULT_NODE_SCHEMA,
};
const first = await service.recall(request);
assert.equal(first.published, true);
assert.equal(first.didRecall, true);
assert.equal(first.injectionText.includes("Mira opened the archive gate"), true);
assert.equal(agentRuns, 1);
const second = await service.recall(request);
assert.equal(second.artifactId, first.artifactId);
assert.equal(second.persistedReuse, true);
assert.equal(agentRuns, 1);
const view = materializeMemoryLedger(await repository.load(chatId));
assert.equal(view.turnArtifacts.active.length, 1);

let releaseConcurrent;
const concurrentGate = new Promise((resolve) => {
  releaseConcurrent = resolve;
});
const concurrentToolset = new RecallAgentToolset({
  repository,
  now: () => 30,
});
let concurrentRuns = 0;
const concurrentService = new RecallAgentService({
  repository,
  toolset: concurrentToolset,
  candidateBuilder,
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async (input) => {
      concurrentRuns += 1;
      await concurrentGate;
      return await concurrentToolset.publish(
        { selectedMemoryIds: [memory.memoryId], reason: "concurrent" },
        { runId: input.runId },
      );
    },
  },
  now: () => 30,
});
const concurrentRequest = { ...request, turnId: "turn:concurrent" };
const concurrentFirst = concurrentService.recall(concurrentRequest);
const concurrentSecond = concurrentService.recall(concurrentRequest);
assert.equal(concurrentFirst, concurrentSecond);
releaseConcurrent();
await concurrentFirst;
assert.equal(concurrentRuns, 1);

const fallbackChatId = "chat:recall-fallback";
const fallbackSeed = seedRepository(fallbackChatId);
const fallbackToolset = new RecallAgentToolset({
  repository: fallbackSeed.repository,
  now: () => 40,
});
const fallbackService = new RecallAgentService({
  repository: fallbackSeed.repository,
  toolset: fallbackToolset,
  candidateBuilder,
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async () => {
      throw new Error("provider unavailable");
    },
  },
  now: () => 40,
});
const fallback = await fallbackService.recall({
  ...request,
  chatId: fallbackChatId,
  turnId: "turn:fallback",
});
assert.equal(fallback.published, true);
assert.equal(fallback.didRecall, true);
assert.equal(fallback.selectionMode, "programmatic-fallback");

const candidateFailureChatId = "chat:recall-candidate-failure";
const candidateFailureSeed = seedRepository(candidateFailureChatId);
const candidateFailureToolset = new RecallAgentToolset({
  repository: candidateFailureSeed.repository,
  now: () => 45,
});
const candidateFailureService = new RecallAgentService({
  repository: candidateFailureSeed.repository,
  toolset: candidateFailureToolset,
  candidateBuilder: async () => {
    throw new Error("vector endpoint unavailable");
  },
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async () => {
      throw new Error("provider unavailable");
    },
  },
  now: () => 45,
});
const candidateFailure = await candidateFailureService.recall({
  ...request,
  chatId: candidateFailureChatId,
  turnId: "turn:candidate-failure",
});
assert.equal(candidateFailure.published, true);
assert.equal(candidateFailure.didRecall, true);
assert.equal(candidateFailure.selectionMode, "programmatic-fallback");
assert.equal(candidateFailure.retrievalMeta.degraded, true);
assert.equal(
  materializeMemoryLedger(
    await candidateFailureSeed.repository.load(candidateFailureChatId),
  ).turnArtifacts.active.length,
  1,
);

const cancelledChatId = "chat:recall-cancelled";
const cancelledSeed = seedRepository(cancelledChatId);
const cancelledToolset = new RecallAgentToolset({
  repository: cancelledSeed.repository,
  now: () => 47,
});
const cancellation = Object.assign(new Error("recall cancelled"), {
  name: "AbortError",
});
const controller = new AbortController();
controller.abort(cancellation);
const cancelledService = new RecallAgentService({
  repository: cancelledSeed.repository,
  toolset: cancelledToolset,
  candidateBuilder,
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async () => {
      throw cancellation;
    },
  },
  now: () => 47,
});
await assert.rejects(
  cancelledService.recall({
    ...request,
    chatId: cancelledChatId,
    turnId: "turn:cancelled",
    signal: controller.signal,
  }),
  /recall cancelled/,
);
assert.equal(
  materializeMemoryLedger(
    await cancelledSeed.repository.load(cancelledChatId),
  ).turnArtifacts.active.length,
  0,
  "cancellation must not publish a fallback artifact",
);

const publishRaceChatId = "chat:recall-publish-cancelled";
const publishRaceSeed = seedRepository(publishRaceChatId);
const originalPublishRaceTransact =
  publishRaceSeed.repository.transact.bind(publishRaceSeed.repository);
let announceTransactionStarted;
const transactionStarted = new Promise((resolve) => {
  announceTransactionStarted = resolve;
});
let releaseTransaction;
const transactionGate = new Promise((resolve) => {
  releaseTransaction = resolve;
});
publishRaceSeed.repository.transact = async (...args) => {
  announceTransactionStarted();
  await transactionGate;
  return await originalPublishRaceTransact(...args);
};
const publishRaceToolset = new RecallAgentToolset({
  repository: publishRaceSeed.repository,
  now: () => 48,
});
const publishRaceService = new RecallAgentService({
  repository: publishRaceSeed.repository,
  toolset: publishRaceToolset,
  candidateBuilder,
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async (input) =>
      await publishRaceToolset.publish(
        {
          selectedMemoryIds: [publishRaceSeed.memory.memoryId],
          reason: "publish race",
        },
        { runId: input.runId, signal: input.signal },
      ),
  },
  now: () => 48,
});
const publishRaceController = new AbortController();
const publishRacePromise = publishRaceService.recall({
  ...request,
  chatId: publishRaceChatId,
  turnId: "turn:publish-cancelled",
  signal: publishRaceController.signal,
});
await transactionStarted;
const publishCancellation = Object.assign(
  new Error("cancelled before durable publish"),
  { name: "AbortError" },
);
publishRaceController.abort(publishCancellation);
releaseTransaction();
await assert.rejects(publishRacePromise, /cancelled before durable publish/);
assert.equal(
  materializeMemoryLedger(
    await publishRaceSeed.repository.load(publishRaceChatId),
  ).turnArtifacts.active.length,
  0,
  "abort before the serialized commit point must prevent artifact persistence",
);

const emptyChatId = "chat:recall-empty";
const emptyRepository = new InMemoryLedgerRepository(emptyChatId);
const emptyToolset = new RecallAgentToolset({
  repository: emptyRepository,
  now: () => 50,
});
let emptyAgentRuns = 0;
const emptyService = new RecallAgentService({
  repository: emptyRepository,
  toolset: emptyToolset,
  candidateBuilder,
  resultBuilder,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async () => {
      emptyAgentRuns += 1;
    },
  },
  now: () => 50,
});
const emptyRequest = {
  chatId: emptyChatId,
  turnId: "turn:first",
  userMessage: "Hello",
  historyFingerprint: "history:first",
  schema: DEFAULT_NODE_SCHEMA,
};
const empty = await emptyService.recall(emptyRequest);
assert.equal(empty.published, true);
assert.equal(empty.empty, true);
assert.equal(empty.didRecall, false);
assert.equal(emptyAgentRuns, 0);
const emptyInputFingerprint = createTurnInputFingerprint(emptyRequest);
const emptyLedger = await emptyRepository.load(emptyChatId);
assert.equal(
  materializeMemoryLedger(emptyLedger).turnArtifacts.get(
    "turn:first",
    "recall",
    emptyInputFingerprint,
  )?.status,
  "empty",
);
assert.equal(fingerprintMaterializedMemoryState(emptyLedger).length > 0, true);

const separateChatId = "chat:recall-separate";
emptyRepository.ledgers.set(
  separateChatId,
  createEmptyMemoryLedger({ chatId: separateChatId, now: 1 }),
);
assert.equal(
  materializeMemoryLedger(await emptyRepository.load(separateChatId)).turnArtifacts.active.length,
  0,
);

console.log("recall agent service tests passed");
