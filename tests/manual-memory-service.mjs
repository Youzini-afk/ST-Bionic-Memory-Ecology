import assert from "node:assert/strict";

import { ManualMemoryService } from "../application/manual-memory-service.js";
import {
  createEvidenceActivation,
  createEvidenceInvalidation,
  createMemoryRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:manual-memory";
const repository = new InMemoryLedgerRepository(chatId, 1);
const evidence = createTurnEvidence({
  chatId,
  turnId: "turn:manual",
  userText: "Where?",
  assistantText: "At the river.",
  createdAt: 2,
});
const memory = createMemoryRevision({
  chatId,
  memoryId: "memory:place",
  memoryType: "place",
  fields: { name: "river", detail: "old" },
  evidenceIds: [evidence.id],
  createdAt: 2,
});
await repository.transact(chatId, {
  baseRevision: 0,
  idempotencyKey: "seed-manual-memory",
  records: [evidence, memory],
  sourceEvidenceIds: [evidence.id],
  now: 2,
});

let now = 10;
const service = new ManualMemoryService({ repository, now: () => now++ });
const edited = await service.revise(chatId, memory.memoryId, {
  fields: { detail: "edited" },
  importance: 9,
});
assert.equal(edited.revision.parentRevisionId, memory.id);
let view = materializeMemoryLedger(await repository.load(chatId));
assert.deepEqual(view.memories.byMemoryId.get(memory.memoryId).fields, {
  name: "river",
  detail: "edited",
});
assert.equal(view.memories.byMemoryId.get(memory.memoryId).importance, 9);

await service.archive(chatId, memory.memoryId);
view = materializeMemoryLedger(await repository.load(chatId));
assert.equal(view.memories.byMemoryId.has(memory.memoryId), false);
assert.equal(view.memories.heads.get(memory.memoryId).status, "archived");

const importChatId = "chat:manual-graph-import";
const importRepository = new InMemoryLedgerRepository(importChatId, 20);
let importNow = 30;
const importService = new ManualMemoryService({
  repository: importRepository,
  now: () => importNow++,
});
await assert.rejects(
  () => importService.replaceWithGraphSnapshot(importChatId, {
    nodes: [{ id: "memory:invalid", type: "" }],
    edges: [],
  }),
  /without id or type/,
);
assert.equal((await importRepository.load(importChatId)).revision, 0);
const firstImport = await importService.replaceWithGraphSnapshot(importChatId, {
  nodes: [
    {
      id: "memory:a",
      type: "event",
      fields: { summary: "A" },
      scope: { layer: "objective" },
      seqRange: [1, 1],
    },
    {
      id: "memory:b",
      type: "fact",
      fields: { summary: "B" },
      scope: { layer: "objective" },
      seqRange: [3, 3],
    },
  ],
  edges: [
    {
      id: "relation:a-b",
      fromId: "memory:a",
      toId: "memory:b",
      relation: "leads-to",
      strength: 0.8,
    },
  ],
});
assert.equal(firstImport.diagnostics.importedMemoryCount, 2);
assert.equal(firstImport.diagnostics.importedRelationCount, 1);
view = materializeMemoryLedger(await importRepository.load(importChatId));
assert.equal(view.memories.active.length, 2);
assert.equal(view.relations.active.length, 1);

const secondImport = await importService.replaceWithGraphSnapshot(importChatId, {
  nodes: [
    {
      id: "memory:b",
      type: "fact",
      fields: { summary: "B revised" },
      scope: { layer: "objective" },
      seqRange: [3, 4],
    },
  ],
  edges: [],
});
assert.equal(secondImport.diagnostics.archivedMemoryCount, 1);
assert.equal(secondImport.diagnostics.archivedRelationCount, 1);
view = materializeMemoryLedger(await importRepository.load(importChatId));
assert.deepEqual(view.memories.active.map((item) => item.memoryId), ["memory:b"]);
assert.equal(view.memories.byMemoryId.get("memory:b").fields.summary, "B revised");
assert.equal(view.relations.active.length, 0);

const archived = await importService.archiveMany(importChatId, ["memory:b"], {
  reason: "test-range-archive",
});
assert.deepEqual(archived.archivedMemoryIds, ["memory:b"]);
view = materializeMemoryLedger(await importRepository.load(importChatId));
assert.equal(view.memories.active.length, 0);

const inactiveChatId = "chat:manual-archive-inactive";
const inactiveRepository = new InMemoryLedgerRepository(inactiveChatId, 40);
const inactiveEvidence = createTurnEvidence({
  chatId: inactiveChatId,
  turnId: "turn:inactive",
  userText: "Remember",
  assistantText: "Temporarily unavailable",
  createdAt: 41,
});
const inactiveMemory = createMemoryRevision({
  chatId: inactiveChatId,
  memoryId: "memory:inactive",
  memoryType: "fact",
  fields: { summary: "Temporarily unavailable" },
  evidenceIds: [inactiveEvidence.id],
  createdAt: 41,
});
await inactiveRepository.transact(inactiveChatId, {
  baseRevision: 0,
  idempotencyKey: "seed-inactive-memory",
  records: [inactiveEvidence, inactiveMemory],
  sourceEvidenceIds: [inactiveEvidence.id],
  now: 41,
});
let inactiveLedger = await inactiveRepository.load(inactiveChatId);
const invalidation = createEvidenceInvalidation({
  chatId: inactiveChatId,
  evidenceId: inactiveEvidence.id,
  mutationId: "mutation:inactive",
  createdAt: 42,
});
await inactiveRepository.transact(inactiveChatId, {
  baseRevision: inactiveLedger.revision,
  idempotencyKey: "invalidate-inactive-memory",
  records: [invalidation],
  readRecordIds: [inactiveEvidence.id],
  sourceEvidenceIds: [inactiveEvidence.id],
  now: 42,
});
assert.equal(
  materializeMemoryLedger(await inactiveRepository.load(inactiveChatId)).memories.active.length,
  0,
);
const inactiveService = new ManualMemoryService({
  repository: inactiveRepository,
  now: () => 43,
});
const archivedInactive = await inactiveService.archiveAll(inactiveChatId);
assert.deepEqual(archivedInactive.archivedMemoryIds, ["memory:inactive"]);
inactiveLedger = await inactiveRepository.load(inactiveChatId);
const activation = createEvidenceActivation({
  chatId: inactiveChatId,
  evidenceId: inactiveEvidence.id,
  mutationId: "mutation:reactivate",
  createdAt: 44,
});
await inactiveRepository.transact(inactiveChatId, {
  baseRevision: inactiveLedger.revision,
  idempotencyKey: "reactivate-inactive-memory",
  records: [activation],
  readRecordIds: [inactiveEvidence.id],
  sourceEvidenceIds: [inactiveEvidence.id],
  now: 44,
});
view = materializeMemoryLedger(await inactiveRepository.load(inactiveChatId));
assert.equal(view.memories.active.length, 0);
assert.equal(view.memories.heads.get("memory:inactive").status, "archived");

console.log("manual memory service tests passed");
