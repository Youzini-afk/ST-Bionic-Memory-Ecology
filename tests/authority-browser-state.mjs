import assert from "node:assert/strict";

import {
  clearAuthorityOfflineQueue,
  enqueueAuthorityOfflineMutation,
  getAuthorityBrowserStateSnapshot,
  getAuthorityBrowserStoragePolicy,
  normalizeAuthorityBrowserState,
  recordAuthorityAcceptedRevision,
} from "../sync/authority-browser-state.js";
import { defaultSettings } from "../runtime/settings-defaults.js";

const policy = getAuthorityBrowserStoragePolicy(defaultSettings);
assert.equal(policy.mode, "minimal");
assert.equal(policy.offlineWritePolicy, "queue-local-dirty");
assert.equal(policy.maxBytes, 1048576);
assert.equal(policy.maxItems, 128);
assert.equal(policy.maxAgeMs, 3600000);

const normalized = normalizeAuthorityBrowserState(
  {
    serverRevision: 7,
    serverIntegrity: "abc",
    offlineQueue: [
      {
        id: "old",
        createdAt: 0,
        bytes: 10,
        payload: { a: 1 },
      },
      {
        id: "fresh",
        createdAt: 9000,
        bytes: 20,
        payload: { b: 2 },
      },
    ],
  },
  {
    ...defaultSettings,
    authorityOfflineQueueMaxAgeMs: 1000,
  },
  10000,
);
assert.equal(normalized.serverRevision, 7);
assert.equal(normalized.serverIntegrity, "abc");
assert.equal(normalized.offlineQueueItems, 1);
assert.equal(normalized.offlineQueueBytes, 20);
assert.equal(normalized.offlineQueue[0].id, "fresh");

const acceptedRevision = recordAuthorityAcceptedRevision(
  normalized,
  {
    revision: 11,
    integrity: "server-integrity",
  },
  defaultSettings,
  12000,
);
assert.equal(acceptedRevision.serverRevision, 11);
assert.equal(acceptedRevision.serverIntegrity, "server-integrity");
assert.equal(acceptedRevision.lastCommitAt, 12000);
assert.equal(acceptedRevision.offlineQueueItems, 1);

const enqueueResult = enqueueAuthorityOfflineMutation(
  acceptedRevision,
  {
    id: "mutation-1",
    kind: "commitDelta",
    payload: { upsertNodes: [{ id: "n1" }] },
  },
  {
    ...defaultSettings,
    authorityOfflineQueueMaxItems: 3,
  },
  13000,
);
assert.equal(enqueueResult.accepted, true);
assert.equal(enqueueResult.state.offlineQueueItems, 2);
assert.equal(enqueueResult.state.offlineQueueOverflow, false);

const itemOverflow = enqueueAuthorityOfflineMutation(
  enqueueResult.state,
  {
    id: "mutation-overflow",
    payload: { upsertNodes: [{ id: "n2" }] },
  },
  {
    ...defaultSettings,
    authorityOfflineQueueMaxItems: 1,
  },
  14000,
);
assert.equal(itemOverflow.accepted, false);
assert.equal(itemOverflow.reason, "max-items-exceeded");
assert.equal(itemOverflow.state.offlineQueueItems, 2);
assert.equal(itemOverflow.state.offlineQueueOverflow, true);

const byteOverflow = enqueueAuthorityOfflineMutation(
  {},
  {
    id: "large-mutation",
    payload: { text: "x".repeat(64) },
  },
  {
    ...defaultSettings,
    authorityOfflineQueueMaxBytes: 8,
  },
  15000,
);
assert.equal(byteOverflow.accepted, false);
assert.equal(byteOverflow.reason, "max-bytes-exceeded");
assert.equal(byteOverflow.state.offlineQueueItems, 0);
assert.equal(byteOverflow.state.offlineQueueOverflow, true);

const disabled = enqueueAuthorityOfflineMutation(
  {},
  {
    id: "disabled-mutation",
    payload: { a: 1 },
  },
  {
    ...defaultSettings,
    authorityBrowserCacheMode: "off",
  },
  16000,
);
assert.equal(disabled.accepted, false);
assert.equal(disabled.reason, "offline-queue-disabled");

const cleared = clearAuthorityOfflineQueue(enqueueResult.state, defaultSettings, 17000);
assert.equal(cleared.offlineQueueItems, 0);
assert.equal(cleared.offlineQueueBytes, 0);
assert.equal(cleared.offlineQueueOverflow, false);

const snapshot = getAuthorityBrowserStateSnapshot(acceptedRevision, defaultSettings, 18000);
assert.equal(snapshot.serverRevision, 11);
assert.equal(snapshot.serverIntegrity, "server-integrity");
assert.equal(snapshot.offlineQueueItems, 1);
assert.equal("offlineQueue" in snapshot, false);

console.log("authority-browser-state tests passed");
