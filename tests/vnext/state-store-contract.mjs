import assert from "node:assert/strict";

import {
  buildTurnKey,
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
      name: "recall records are immutable and follow their bound user prefix",
      async run(store) {
        const chatKey = "recall";
        const history = await snapshotHistory(semanticMessages(["user", "one"]));
        let result = await store.reconcileHistory({
          chatKey,
          expectedRevision: 0,
          history,
        });
        const turnKey = await buildTurnKey(chatKey, getHistoryPrefixHash(history, 1));
        const record = {
          turnKey,
          chatKey,
          boundUserMessageHash: history[0].messageHash,
          historyPrefixHash: history[0].prefixHash,
          recallInput: "one",
          selectedNodeIds: ["memory-1"],
          injectionText: "remembered exactly",
          tokenEstimate: 3,
          graphRevision: result.head.graphRevision,
        };
        await assert.rejects(store.createTurnRecords({
          chatKey,
          expectedRevision: result.head.revision,
          recallRecord: { ...record, turnKey: "forged" },
        }), /turnKey does not match/);
        result = await store.createTurnRecords({
          chatKey,
          expectedRevision: result.head.revision,
          recallRecord: record,
        });
        assert.equal(result.recall.created, true);
        assert.equal(result.head.revision, 2);
        assert.deepEqual((await store.readRecall(chatKey, turnKey)).selectedNodeIds, ["memory-1"]);

        const duplicate = await store.createTurnRecords({
          chatKey,
          expectedRevision: result.head.revision,
          recallRecord: record,
        });
        assert.equal(duplicate.recall.created, false);
        assert.equal(duplicate.head.revision, result.head.revision);

        const edited = await snapshotHistory(semanticMessages(["user", "changed"]));
        await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history: edited,
        });
        assert.equal(await store.readRecall(chatKey, turnKey), null);
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
    {
      name: "concurrent turn-record writers allow exactly one CAS winner",
      async run(store) {
        const chatKey = "turn-cas";
        const history = await snapshotHistory(semanticMessages(["user", "one"]));
        const reconciled = await store.reconcileHistory({
          chatKey,
          expectedRevision: 0,
          history,
        });
        const turnKey = await buildTurnKey(chatKey, history[0].prefixHash);
        const command = (injectionText) => ({
          chatKey,
          expectedRevision: reconciled.head.revision,
          recallRecord: {
            turnKey,
            chatKey,
            boundUserMessageHash: history[0].messageHash,
            historyPrefixHash: history[0].prefixHash,
            recallInput: "one",
            selectedNodeIds: [],
            injectionText,
            tokenEstimate: 1,
            graphRevision: reconciled.head.graphRevision,
          },
        });
        const results = await Promise.allSettled([
          store.createTurnRecords(command("writer-a")),
          store.createTurnRecords(command("writer-b")),
        ]);
        assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
        assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
        assert.ok(
          results.find(({ status }) => status === "rejected").reason instanceof RevisionConflictError,
        );
        assert.equal((await store.readConversation(chatKey)).recallRecords.size, 1);
      },
    },
    {
      name: "planner and recall bind atomically and disappear with their user prefix",
      async run(store) {
        const chatKey = "planned";
        const history = await snapshotHistory(semanticMessages(["user", "raw\n\n<plot>go</plot>"]));
        let result = await store.commit({
          chatKey,
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
        result = await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history,
        });
        const turnKey = await buildTurnKey(chatKey, history[0].prefixHash);
        const plannerRecord = {
          turnKey,
          chatKey,
          boundUserMessageHash: history[0].messageHash,
          historyPrefixHash: history[0].prefixHash,
          rawUserInput: "raw",
          augmentedUserMessage: "raw\n\n<plot>go</plot>",
          plotText: "<plot>go</plot>",
          plotBlocks: ["<plot>go</plot>"],
          promptProfileId: "planner-default",
          recallTurnKey: turnKey,
        };
        const recallRecord = {
          turnKey,
          chatKey,
          boundUserMessageHash: history[0].messageHash,
          historyPrefixHash: history[0].prefixHash,
          recallInput: "raw",
          selectedNodeIds: ["memory"],
          injectionText: "remember",
          tokenEstimate: 1,
          graphRevision: result.head.graphRevision + 1,
        };
        result = await store.createTurnRecords({
          chatKey,
          expectedRevision: result.head.revision,
          basisHistoryLength: 1,
          basisHistoryHash: history[0].prefixHash,
          changeSet: {
            changes: [{
              collection: "nodes",
              id: "memory",
              before: { id: "memory", accessCount: 0 },
              after: { id: "memory", accessCount: 1 },
            }],
          },
          plannerRecord,
          recallRecord,
        });
        assert.equal(result.transaction.operation, "recall-access");
        assert.equal(result.planner.created, true);
        assert.equal(result.recall.created, true);
        let state = await store.readConversation(chatKey);
        assert.equal(state.collections.nodes.get("memory").accessCount, 1);
        assert.equal((await store.readPlanner(chatKey, turnKey)).recallTurnKey, turnKey);
        assert.equal((await store.readRecall(chatKey, turnKey)).injectionText, "remember");

        const edited = await snapshotHistory(semanticMessages(["user", "edited"]));
        await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history: edited,
        });
        state = await store.readConversation(chatKey);
        assert.equal(state.collections.nodes.get("memory").accessCount, 0);
        assert.equal(await store.readPlanner(chatKey, turnKey), null);
        assert.equal(await store.readRecall(chatKey, turnKey), null);
      },
    },
    {
      name: "a planner conflict aborts accompanying recall effects",
      async run(store) {
        const chatKey = "planned-conflict";
        const history = await snapshotHistory(semanticMessages(["user", "raw\n\n<plot>one</plot>"]));
        let result = await store.commit({
          chatKey,
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
        result = await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history,
        });
        const turnKey = await buildTurnKey(chatKey, history[0].prefixHash);
        const plannerRecord = {
          turnKey,
          chatKey,
          boundUserMessageHash: history[0].messageHash,
          historyPrefixHash: history[0].prefixHash,
          rawUserInput: "raw",
          augmentedUserMessage: "raw\n\n<plot>one</plot>",
          plotText: "<plot>one</plot>",
          plotBlocks: ["<plot>one</plot>"],
          promptProfileId: "planner-default",
          recallTurnKey: "",
        };
        result = await store.createTurnRecords({
          chatKey,
          expectedRevision: result.head.revision,
          plannerRecord,
        });
        const revisionBefore = result.head.revision;
        await assert.rejects(store.createTurnRecords({
          chatKey,
          expectedRevision: revisionBefore,
          basisHistoryLength: 1,
          basisHistoryHash: history[0].prefixHash,
          changeSet: {
            changes: [{
              collection: "nodes",
              id: "memory",
              before: { id: "memory", accessCount: 0 },
              after: { id: "memory", accessCount: 1 },
            }],
          },
          plannerRecord: {
            ...plannerRecord,
            plotText: "<plot>conflict</plot>",
            plotBlocks: ["<plot>conflict</plot>"],
            recallTurnKey: turnKey,
          },
          recallRecord: {
            turnKey,
            chatKey,
            boundUserMessageHash: history[0].messageHash,
            historyPrefixHash: history[0].prefixHash,
            recallInput: "raw",
            selectedNodeIds: ["memory"],
            injectionText: "remember",
            tokenEstimate: 1,
            graphRevision: result.head.graphRevision + 1,
          },
        }), /planner record already exists/);
        const state = await store.readConversation(chatKey);
        assert.equal(state.head.revision, revisionBefore);
        assert.equal(state.collections.nodes.get("memory").accessCount, 0);
        assert.equal(state.transactions.filter(({ operation }) => operation === "recall-access").length, 0);
        assert.equal(await store.readRecall(chatKey, turnKey), null);
        assert.equal((await store.readPlanner(chatKey, turnKey)).plotText, "<plot>one</plot>");
      },
    },
    {
      name: "vector jobs are committed with graph changes and rollback repair",
      async run(store) {
        const chatKey = "vectors";
        const history = await snapshotHistory(semanticMessages(
          ["user", "one"],
          ["assistant", "answer"],
        ));
        let result = await store.reconcileHistory({ chatKey, expectedRevision: 0, history });
        result = await store.commit({
          chatKey,
          expectedRevision: result.head.revision,
          operation: "extract",
          basisHistoryLength: 2,
          basisHistoryHash: getHistoryPrefixHash(history, 2),
          processedThroughAfter: 1,
          vectorModelScope: "backend:model-a",
          enqueueVectorJob: true,
          changeSet: {
            changes: [{ collection: "nodes", id: "v1", before: null, after: { id: "v1" } }],
          },
        });
        assert.equal(result.vectorJob.status, "pending");
        assert.equal((await store.listVectorJobs(chatKey)).length, 1);

        const edited = await snapshotHistory(semanticMessages(
          ["user", "one"],
          ["assistant", "changed"],
        ));
        result = await store.reconcileHistory({
          chatKey,
          expectedRevision: result.head.revision,
          history: edited,
        });
        assert.equal(result.vectorJob.reason, "history-rollback");
        assert.equal((await store.readConversation(chatKey)).collections.nodes.has("v1"), false);
        const pending = await store.listVectorJobs(chatKey);
        assert.equal(pending.length, 2);
        await store.settleVectorJobs({
          chatKey,
          ids: pending.map(({ id }) => id),
          status: "completed",
          outcome: "synced",
        });
        assert.equal((await store.listVectorJobs(chatKey)).length, 0);
        assert.equal((await store.listVectorJobs(chatKey, { status: "completed" })).length, 2);
      },
    },
  ];
}
