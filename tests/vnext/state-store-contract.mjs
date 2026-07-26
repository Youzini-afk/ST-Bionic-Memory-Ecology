import assert from "node:assert/strict";

import {
  getHistoryPrefixHash,
  snapshotHistory,
} from "../../src/core/history.js";
import { RevisionConflictError } from "../../src/core/state-model.js";

export const semanticMessages = (...pairs) =>
  pairs.map(([role, text], index) => ({ role, text, speaker: `${role}-${index % 2}` }));

export function stateStoreContractCases() {
  return [
    {
      name: "history divergence rolls back the invalid transaction suffix",
      async run(store) {
        const chatKey = "chat-a";
        const originalHistory = await snapshotHistory(semanticMessages(
          ["user", "u1"],
          ["assistant", "a1"],
          ["user", "u2"],
          ["assistant", "a2"],
        ));
        let result = await store.reconcileHistory({
          chatKey,
          expectedRevision: 0,
          history: originalHistory,
        });
        assert.equal(result.head.revision, 1);

        result = await store.commit({
          chatKey,
          expectedRevision: 1,
          operation: "extract",
          basisHistoryLength: 2,
          basisHistoryHash: getHistoryPrefixHash(originalHistory, 2),
          processedThroughAfter: 1,
          changeSet: {
            changes: [
              { collection: "nodes", id: "n1", before: null, after: { id: "n1", text: "a1" } },
            ],
          },
        });
        assert.equal(result.head.revision, 2);

        result = await store.commit({
          chatKey,
          expectedRevision: 2,
          operation: "consolidate",
          basisHistoryLength: 4,
          basisHistoryHash: getHistoryPrefixHash(originalHistory, 4),
          processedThroughAfter: 3,
          changeSet: {
            changes: [
              {
                collection: "nodes",
                id: "n1",
                before: { id: "n1", text: "a1" },
                after: { id: "n1", text: "a1+a2" },
              },
              { collection: "nodes", id: "n2", before: null, after: { id: "n2", text: "a2" } },
            ],
          },
        });
        assert.equal(result.head.revision, 3);

        await assert.rejects(
          store.commit({
            chatKey,
            expectedRevision: 2,
            operation: "stale",
            basisHistoryLength: 4,
            basisHistoryHash: getHistoryPrefixHash(originalHistory, 4),
            processedThroughAfter: 3,
            changeSet: {
              changes: [
                { collection: "nodes", id: "x", before: null, after: { id: "x" } },
              ],
            },
          }),
          RevisionConflictError,
        );

        const rerolledHistory = await snapshotHistory(semanticMessages(
          ["user", "u1"],
          ["assistant", "a1"],
          ["user", "u2"],
          ["assistant", "a2-reroll"],
        ));
        result = await store.reconcileHistory({
          chatKey,
          expectedRevision: 3,
          history: rerolledHistory,
        });
        assert.equal(result.commonPrefixLength, 3);
        assert.deepEqual(result.rolledBackTransactions.map((tx) => tx.operation), ["consolidate"]);
        let state = await store.readConversation(chatKey);
        assert.deepEqual(state.collections.nodes.get("n1"), { id: "n1", text: "a1" });
        assert.equal(state.collections.nodes.has("n2"), false);
        assert.equal(result.head.processedThrough, 1);

        const editedEarlierHistory = await snapshotHistory(semanticMessages(
          ["user", "u1"],
          ["assistant", "a1-edited"],
          ["user", "u2"],
          ["assistant", "a2-reroll"],
        ));
        result = await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history: editedEarlierHistory,
        });
        assert.equal(result.commonPrefixLength, 1);
        assert.deepEqual(result.rolledBackTransactions.map((tx) => tx.operation), ["extract"]);
        state = await store.readConversation(chatKey);
        assert.equal(state.collections.nodes.size, 0);
        assert.equal(result.head.processedThrough, -1);
      },
    },
    {
      name: "an unprocessed history tail leaves graphRevision untouched",
      async run(store) {
        const first = await snapshotHistory(semanticMessages(["user", "one"]));
        const second = await snapshotHistory(
          semanticMessages(["user", "one"], ["assistant", "unprocessed"]),
        );
        let result = await store.reconcileHistory({
          chatKey: "tail",
          expectedRevision: 0,
          history: first,
        });
        const graphRevision = result.head.graphRevision;
        result = await store.reconcileHistory({
          chatKey: "tail",
          expectedRevision: result.head.revision,
          history: second,
        });
        assert.equal(result.head.graphRevision, graphRevision);
        assert.equal(result.rolledBackTransactions.length, 0);
      },
    },
    {
      name: "concurrent writers allow exactly one CAS winner",
      async run(store) {
        const chatKey = "cas";
        const history = await snapshotHistory(semanticMessages(["user", "one"]));
        await store.reconcileHistory({ chatKey, expectedRevision: 0, history });
        const basisHistoryHash = getHistoryPrefixHash(history, 1);
        const command = (id) => ({
          id,
          chatKey,
          expectedRevision: 1,
          operation: "extract",
          basisHistoryLength: 1,
          basisHistoryHash,
          processedThroughAfter: 0,
          changeSet: {
            changes: [{ collection: "nodes", id, before: null, after: { id } }],
          },
        });
        const results = await Promise.allSettled([
          store.commit(command("writer-a")),
          store.commit(command("writer-b")),
        ]);
        assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
        assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
        assert.ok(
          results.find(({ status }) => status === "rejected").reason instanceof RevisionConflictError,
        );
        const state = await store.readConversation(chatKey);
        assert.equal(state.head.revision, 2);
        assert.equal(state.collections.nodes.size, 1);
        assert.equal(state.transactions.length, 1);
      },
    },
  ];
}
