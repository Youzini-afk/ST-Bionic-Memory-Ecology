import assert from "node:assert/strict";

import {
  LEGACY_GRAPH_MIGRATION_ID,
  planLegacyGraphMigration,
} from "../application/legacy-ledger-migration.js";
import { createEmptyMemoryLedger, MEMORY_RECORD_KIND } from "../domain/memory-contract.js";
import { planHistoryReconciliation } from "../domain/history-reconciliation.js";
import { appendMemoryLedgerTransaction, assertMemoryLedger } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { buildConversationEvidenceSnapshot } from "../host/conversation-snapshot.js";

const chatId = "chat:legacy-ledger";
const conversationSnapshot = buildConversationEvidenceSnapshot(
  [
    { is_user: true, mes: "Where is the key?", name: "User", send_date: "u1" },
    { is_user: false, mes: "The key is in the blue drawer.", name: "Alice", send_date: "a1" },
  ],
  { chatId, hostChatId: "host-chat" },
);
const legacyGraph = {
  version: 8,
  nodes: [
    {
      id: "memory-key",
      type: "event",
      seq: 1,
      seqRange: [1, 1],
      fields: { summary: "The key is in the blue drawer." },
      scope: { layer: "objective" },
      importance: 8,
      embedding: [0.1, 0.2],
      accessCount: 99,
    },
    {
      id: "memory-unmatched",
      type: "fact",
      seq: 99,
      seqRange: [99, 99],
      fields: { summary: "A legacy fact whose dialogue is no longer present." },
      scope: { layer: "objective" },
      importance: 6,
    },
  ],
  edges: [
    {
      id: "edge-key-fact",
      fromId: "memory-key",
      toId: "memory-unmatched",
      relation: "supports",
      strength: 0.75,
    },
  ],
  vectorIndexState: { dirty: false, nodeToHash: { "memory-key": "secret" } },
  batchJournal: [{ id: "must-not-import" }],
};

let ledger = createEmptyMemoryLedger({ chatId, now: 100 });
const plan = planLegacyGraphMigration(ledger, {
  legacyGraph,
  conversationSnapshot,
  legacySourceReady: true,
  now: 200,
});
assert.equal(plan.migrated, true);
assert.equal(plan.diagnostics.importedMemoryCount, 2);
assert.equal(plan.diagnostics.importedRelationCount, 1);
assert.deepEqual(plan.diagnostics.unmatchedLegacyNodeIds, ["memory-unmatched"]);
assert.equal(plan.records.at(-1).kind, MEMORY_RECORD_KIND.MIGRATION);
assert.equal(plan.records.at(-1).migrationId, LEGACY_GRAPH_MIGRATION_ID);

ledger = appendMemoryLedgerTransaction(ledger, plan.transaction).ledger;
assertMemoryLedger(ledger);
let view = materializeMemoryLedger(ledger);
assert.deepEqual(
  [...view.memories.byMemoryId.keys()].sort(),
  ["memory-key", "memory-unmatched"],
);
assert.equal(view.relations.active.length, 1);
assert.equal(
  ledger.records.some((record) => record?.embedding || record?.vectorIndexState || record?.batchJournal),
  false,
);

const evidence = ledger.records.filter((record) => record.kind === MEMORY_RECORD_KIND.EVIDENCE);
assert.equal(evidence.length, 2);
assert.equal(evidence.find((record) => record.metadata?.legacyNodeId === "memory-unmatched")?.metadata?.historyManaged, false);
assert.equal(evidence.find((record) => record.metadata?.historyManaged === true)?.source?.assistantFloor, 1);

const repeated = planLegacyGraphMigration(ledger, {
  legacyGraph: { version: 999, nodes: [], edges: [] },
  conversationSnapshot: { chatId, turns: [] },
  legacySourceReady: true,
  now: 999,
});
assert.equal(repeated.alreadyMigrated, true);
assert.equal(repeated.transaction, null);

const deferredChatId = "chat:deferred";
const deferredLedger = createEmptyMemoryLedger({ chatId: deferredChatId, now: 100 });
const deferred = planLegacyGraphMigration(deferredLedger, {
  legacyGraph: {},
  conversationSnapshot: { chatId: deferredChatId, turns: [] },
  legacySourceReady: false,
  now: 101,
});
assert.equal(deferred.migrationDeferred, true);
assert.equal(deferred.transaction, null);
const resumed = planLegacyGraphMigration(deferredLedger, {
  legacyGraph: {
    version: 8,
    nodes: [
      {
        id: "late-memory",
        type: "fact",
        seq: 0,
        fields: { summary: "loaded later" },
      },
    ],
    edges: [],
  },
  conversationSnapshot: { chatId: deferredChatId, turns: [] },
  legacySourceReady: true,
  now: 102,
});
assert.equal(resumed.migrated, true);
assert.equal(resumed.diagnostics.importedMemoryCount, 1);

const removal = planHistoryReconciliation(ledger, {
  turns: [],
  historyFingerprint: "history-now-empty",
  mutationId: "delete-history",
  now: 300,
});
ledger = appendMemoryLedgerTransaction(ledger, removal.transaction).ledger;
view = materializeMemoryLedger(ledger);
assert.equal(view.memories.byMemoryId.has("memory-key"), false);
assert.equal(view.memories.byMemoryId.has("memory-unmatched"), true);
assert.equal(view.relations.active.length, 0);

console.log("legacy ledger migration tests passed");
