import {
  ChangeConflictError,
  GRAPH_COLLECTIONS,
} from "../core/change-set.js";
import { PlannerConflictError } from "../core/planner-record.js";
import {
  GraphRevisionConflictError,
  RecallConflictError,
} from "../core/recall-record.js";
import {
  HistoryBasisConflictError,
  RevisionConflictError,
  requireChatKey,
} from "../core/state-model.js";

export const BME_AUTHORITY_MODULE_ID = "third-party.st-bme";

const clone = (value) => structuredClone(value);

function requireTurnKey(value) {
  const turnKey = String(value || "").trim();
  if (!turnKey) throw new TypeError("turnKey is required");
  return turnKey;
}

function hydrateEntries(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`Authority ${label} must be an array`);
  return new Map(value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !String(entry[0] || "").trim()) {
      throw new TypeError(`Authority ${label}[${index}] is invalid`);
    }
    return [String(entry[0]), clone(entry[1])];
  }));
}

function hydrateConversation(value, chatKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Authority conversation response is invalid");
  }
  if (value.head?.chatKey !== chatKey) {
    throw new TypeError("Authority conversation response has the wrong chatKey");
  }
  const collections = {};
  for (const name of GRAPH_COLLECTIONS) {
    collections[name] = hydrateEntries(value.collections?.[name], `collections.${name}`);
  }
  if (!Array.isArray(value.transactions)) {
    throw new TypeError("Authority transactions must be an array");
  }
  return {
    head: clone(value.head),
    collections,
    transactions: clone(value.transactions),
    recallRecords: hydrateEntries(value.recallRecords, "recallRecords"),
    plannerRecords: hydrateEntries(value.plannerRecords, "plannerRecords"),
    vectorJobs: hydrateEntries(value.vectorJobs, "vectorJobs"),
  };
}

function stateError(error = {}) {
  const details = error.details && typeof error.details === "object" ? error.details : {};
  const message = String(error.message || "Authority StateStore command failed");
  switch (String(error.code || "")) {
    case "revision_conflict":
      return new RevisionConflictError(
        details.chatKey,
        details.expectedRevision,
        details.actualRevision,
      );
    case "history_basis_conflict":
      return new HistoryBasisConflictError(
        details.chatKey,
        details.historyLength,
        details.historyHash,
      );
    case "change_conflict":
      return new ChangeConflictError(message, details);
    case "graph_revision_conflict":
      return new GraphRevisionConflictError(
        details.chatKey,
        details.expectedGraphRevision,
        details.actualGraphRevision,
      );
    case "recall_conflict":
      return new RecallConflictError(details.turnKey);
    case "planner_conflict":
      return new PlannerConflictError(details.turnKey);
    case "range_error":
      return new RangeError(message);
    default:
      return new TypeError(message);
  }
}

export class AuthorityStateStore {
  #client;
  #id;
  #timeoutMs;

  constructor({ client, id = () => crypto.randomUUID(), timeoutMs } = {}) {
    if (!client?.requestModuleTransaction) {
      throw new TypeError("Authority module client is required");
    }
    this.#client = client;
    this.#id = id;
    this.#timeoutMs = timeoutMs;
  }

  async readConversation(chatKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    return hydrateConversation(
      await this.#read({ kind: "conversation", chatKey }),
      chatKey,
    );
  }

  async commit(command = {}) {
    const next = clone(command);
    next.chatKey = requireChatKey(next.chatKey);
    if (!String(next.id || "").trim()) next.id = this.#nextId();
    return await this.#command("commit", next);
  }

  async readRecall(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    return await this.#read({ kind: "recall", chatKey, turnKey: requireTurnKey(turnKeyInput) });
  }

  async readPlanner(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    return await this.#read({ kind: "planner", chatKey, turnKey: requireTurnKey(turnKeyInput) });
  }

  async createTurnRecords(command = {}) {
    return await this.#command("createTurnRecords", command);
  }

  async reconcileHistory(command = {}) {
    return await this.#command("reconcileHistory", command);
  }

  async listVectorJobs(chatKeyInput, { status = "pending" } = {}) {
    const chatKey = requireChatKey(chatKeyInput);
    const value = await this.#read({
      kind: "vectorJobs",
      chatKey,
      status: String(status || "").trim(),
    });
    if (!Array.isArray(value)) throw new TypeError("Authority vector jobs response is invalid");
    return clone(value);
  }

  async settleVectorJobs(command = {}) {
    return await this.#command("settleVectorJobs", command);
  }

  async #read(input) {
    const response = await this.#client.requestModuleTransaction(
      BME_AUTHORITY_MODULE_ID,
      "state.read",
      input,
      this.#requestOptions(),
    );
    return clone(this.#unwrap(response));
  }

  async #command(operation, command) {
    const next = clone(command);
    next.chatKey = requireChatKey(next.chatKey);
    const idempotencyKey = `state:${operation}:${this.#nextId()}`;
    const response = await this.#client.requestModuleTransaction(
      BME_AUTHORITY_MODULE_ID,
      "state.command",
      { operation, command: next },
      { ...this.#requestOptions(), idempotencyKey },
    );
    return clone(this.#unwrap(response));
  }

  #unwrap(response) {
    const payload = response?.result ?? response;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Authority StateStore response is invalid");
    }
    if (payload.ok === false) throw stateError(payload.error);
    if (payload.ok !== true || !Object.hasOwn(payload, "value")) {
      throw new TypeError("Authority StateStore response is incomplete");
    }
    return payload.value;
  }

  #nextId() {
    const value = String(this.#id() || "").trim();
    if (!value) throw new TypeError("Authority StateStore id generator returned an empty value");
    return value;
  }

  #requestOptions() {
    return this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs };
  }
}
