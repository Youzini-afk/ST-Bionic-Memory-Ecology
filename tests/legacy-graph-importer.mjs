import assert from "node:assert/strict";

import { runLegacyGraphImportOnce } from "../sync/legacy-graph-importer.js";

const calls = [];
const opfs = { migrated: true, source: "opfs", snapshot: { meta: { revision: 4 } } };
const opfsPlan = await runLegacyGraphImportOnce({
  chatId: "chat-a",
  importOpfs: async () => {
    calls.push("opfs");
    return opfs;
  },
  importIndexedDb: async () => {
    calls.push("indexeddb");
    return { migrated: true };
  },
  importMetadata: async () => {
    calls.push("metadata");
    return { migrated: true };
  },
});
assert.deepEqual(calls, ["opfs"]);
assert.equal(opfsPlan.result, opfs, "the successful OPFS import must not be hidden by a skip result");

calls.length = 0;
const localFailure = { migrated: false, reason: "migration-local-store-failed" };
const failedPlan = await runLegacyGraphImportOnce({
  importOpfs: async () => ({ migrated: false, reason: "missing" }),
  importIndexedDb: async () => {
    calls.push("indexeddb");
    return localFailure;
  },
  importMetadata: async () => {
    calls.push("metadata");
    return { migrated: true };
  },
});
assert.deepEqual(calls, ["indexeddb"]);
assert.equal(failedPlan.result, localFailure);

console.log("legacy-graph-importer tests passed");
