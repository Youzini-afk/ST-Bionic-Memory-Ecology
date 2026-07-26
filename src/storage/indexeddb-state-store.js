import {
  applyChangeSet,
  createGraphCollections,
  GRAPH_COLLECTIONS,
} from "../core/change-set.js";
import {
  createConversationHead,
  prepareCommit,
  prepareHistoryReconciliation,
  requireChatKey,
} from "../core/state-model.js";
import {
  isRecallBoundToHistory,
  prepareRecallCreate,
} from "../core/recall-record.js";
import { loadDexie } from "./dexie-loader.js";

export const INDEXED_DB_NAME = "STBME_v9";
export const INDEXED_DB_VERSION = 1;

const schema = Object.freeze({
  heads: "&chatKey",
  graphRecords: "&[chatKey+collection+id], chatKey",
  transactions: "&[chatKey+committedRevision], &id, chatKey",
  recallRecords: "&turnKey, chatKey",
  plannerRecords: "&turnKey, chatKey",
  vectorJobs: "&id, chatKey, [chatKey+status]",
  settings: "&id",
});

function clone(value) {
  return structuredClone(value);
}

function recordKey(chatKey, collection, id) {
  return [chatKey, collection, id];
}

function hydrateCollections(chatKey, records) {
  const collections = createGraphCollections();
  for (const record of records) {
    if (record.chatKey !== chatKey || !GRAPH_COLLECTIONS.includes(record.collection)) {
      throw new TypeError("stored graph record has an invalid namespace");
    }
    collections[record.collection].set(record.id, clone(record.value));
  }
  return collections;
}

export class IndexedDbStateStore {
  #databaseName;
  #dbPromise;
  #now;
  #id;

  constructor({
    databaseName = INDEXED_DB_NAME,
    dexieClass = null,
    now = Date.now,
    id = () => crypto.randomUUID(),
  } = {}) {
    this.#databaseName = String(databaseName || "").trim();
    if (!this.#databaseName) throw new TypeError("databaseName is required");
    this.#now = now;
    this.#id = id;
    this.#dbPromise = this.#open(dexieClass);
  }

  get databaseName() {
    return this.#databaseName;
  }

  async readConversation(chatKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const db = await this.#dbPromise;
    return db.transaction(
      "r",
      db.table("heads"),
      db.table("graphRecords"),
      db.table("transactions"),
      db.table("recallRecords"),
      async () => {
        const head = (await db.table("heads").get(chatKey)) || createConversationHead(chatKey);
        const records = await db.table("graphRecords").where("chatKey").equals(chatKey).toArray();
        const transactions = await db
          .table("transactions")
          .where("chatKey")
          .equals(chatKey)
          .sortBy("committedRevision");
        const recallRecords = await db
          .table("recallRecords")
          .where("chatKey")
          .equals(chatKey)
          .toArray();
        return {
          head: clone(head),
          collections: hydrateCollections(chatKey, records),
          transactions: clone(transactions),
          recallRecords: new Map(
            recallRecords.map((record) => [record.turnKey, clone(record)]),
          ),
        };
      },
    );
  }

  async commit(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const db = await this.#dbPromise;
    let response;
    await db.transaction(
      "rw",
      db.table("heads"),
      db.table("graphRecords"),
      db.table("transactions"),
      async () => {
        const head = (await db.table("heads").get(chatKey)) || createConversationHead(chatKey);
        const plan = prepareCommit(head, command, { now: this.#now, id: this.#id });
        const keys = plan.changeSet.changes.map(({ collection, id }) =>
          recordKey(chatKey, collection, id));
        const stored = await db.table("graphRecords").bulkGet(keys);
        const collections = createGraphCollections();
        stored.forEach((record, index) => {
          if (!record) return;
          const change = plan.changeSet.changes[index];
          collections[change.collection].set(change.id, clone(record.value));
        });
        applyChangeSet(collections, plan.changeSet, "forward");

        const puts = plan.changeSet.changes
          .filter(({ after }) => after !== null)
          .map(({ collection, id, after }) => ({
            chatKey,
            collection,
            id,
            value: clone(after),
          }));
        const deletes = plan.changeSet.changes
          .filter(({ after }) => after === null)
          .map(({ collection, id }) => recordKey(chatKey, collection, id));
        if (puts.length > 0) await db.table("graphRecords").bulkPut(puts);
        if (deletes.length > 0) await db.table("graphRecords").bulkDelete(deletes);
        await db.table("transactions").add(clone(plan.transaction));
        await db.table("heads").put(clone(plan.nextHead));
        response = {
          head: clone(plan.nextHead),
          transaction: clone(plan.transaction),
        };
      },
    );
    return response;
  }

  async readRecall(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const turnKey = String(turnKeyInput || "").trim();
    if (!turnKey) throw new TypeError("turnKey is required");
    const db = await this.#dbPromise;
    const record = await db.table("recallRecords").get(turnKey);
    return record?.chatKey === chatKey ? clone(record) : null;
  }

  async createRecall(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const turnKey = String(command.record?.turnKey || "").trim();
    const db = await this.#dbPromise;
    let response;
    await db.transaction(
      "rw",
      db.table("heads"),
      db.table("recallRecords"),
      async () => {
        const head = (await db.table("heads").get(chatKey)) || createConversationHead(chatKey);
        const existing = turnKey ? await db.table("recallRecords").get(turnKey) : null;
        const plan = prepareRecallCreate(head, existing, command, { now: this.#now });
        if (plan.created) {
          await db.table("recallRecords").add(clone(plan.record));
          await db.table("heads").put(clone(plan.nextHead));
        }
        response = {
          created: plan.created,
          head: clone(plan.nextHead),
          record: clone(plan.record),
        };
      },
    );
    return response;
  }

  async reconcileHistory(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const db = await this.#dbPromise;
    let response;
    await db.transaction(
      "rw",
      db.table("heads"),
      db.table("graphRecords"),
      db.table("transactions"),
      db.table("recallRecords"),
      async () => {
        const head = (await db.table("heads").get(chatKey)) || createConversationHead(chatKey);
        const transactions = await db
          .table("transactions")
          .where("chatKey")
          .equals(chatKey)
          .sortBy("committedRevision");
        const plan = prepareHistoryReconciliation(head, transactions, command, {
          now: this.#now,
        });
        response = {
          changed: plan.changed,
          commonPrefixLength: plan.commonPrefixLength,
          rolledBackTransactions: clone(plan.rolledBackTransactions),
          head: clone(plan.nextHead),
        };
        if (!plan.changed) return;

        const touched = new Map();
        for (const transaction of plan.rolledBackTransactions) {
          for (const change of transaction.changes) {
            touched.set(`${change.collection}\0${change.id}`, change);
          }
        }
        const touchedChanges = [...touched.values()];
        const keys = touchedChanges.map(({ collection, id }) =>
          recordKey(chatKey, collection, id));
        const stored = await db.table("graphRecords").bulkGet(keys);
        const collections = createGraphCollections();
        stored.forEach((record, index) => {
          if (!record) return;
          const change = touchedChanges[index];
          collections[change.collection].set(change.id, clone(record.value));
        });
        for (let index = plan.rolledBackTransactions.length - 1; index >= 0; index -= 1) {
          applyChangeSet(collections, plan.rolledBackTransactions[index], "rollback");
        }

        const puts = touchedChanges
          .filter(({ collection, id }) => collections[collection].has(id))
          .map(({ collection, id }) => ({
            chatKey,
            collection,
            id,
            value: clone(collections[collection].get(id)),
          }));
        const deletes = touchedChanges
          .filter(({ collection, id }) => !collections[collection].has(id))
          .map(({ collection, id }) => recordKey(chatKey, collection, id));
        if (puts.length > 0) await db.table("graphRecords").bulkPut(puts);
        if (deletes.length > 0) await db.table("graphRecords").bulkDelete(deletes);
        if (plan.rolledBackTransactions.length > 0) {
          await db.table("transactions").bulkDelete(
            plan.rolledBackTransactions.map(({ committedRevision }) =>
              [chatKey, committedRevision]),
          );
        }
        const recallRecords = await db
          .table("recallRecords")
          .where("chatKey")
          .equals(chatKey)
          .toArray();
        const invalidRecallKeys = recallRecords
          .filter((record) => !isRecallBoundToHistory(record, plan.history))
          .map(({ turnKey }) => turnKey);
        if (invalidRecallKeys.length > 0) {
          await db.table("recallRecords").bulkDelete(invalidRecallKeys);
        }
        await db.table("heads").put(clone(plan.nextHead));
      },
    );
    return response;
  }

  async close() {
    const db = await this.#dbPromise;
    db.close();
  }

  async #open(dexieClass) {
    const Dexie = await loadDexie(dexieClass);
    const db = new Dexie(this.#databaseName);
    db.version(INDEXED_DB_VERSION).stores(schema);
    await db.open();
    return db;
  }
}
