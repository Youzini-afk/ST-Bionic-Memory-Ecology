import { snapshotHistory } from "./history.js";

export class LeaseExpiredError extends Error {
  constructor(chatKey) {
    super(`conversation lease expired for ${chatKey}`);
    this.name = "LeaseExpiredError";
    this.chatKey = chatKey;
  }
}

function requireChatKey(value) {
  const chatKey = String(value || "").trim();
  if (!chatKey) throw new TypeError("chatKey is required");
  return chatKey;
}

export class ConversationEngine {
  #store;
  #active = null;
  #epoch = 0;
  #queues = new Map();

  constructor({ store } = {}) {
    if (
      !store?.readConversation ||
      !store?.commit ||
      !store?.reconcileHistory ||
      !store?.readRecall ||
      !store?.createTurnRecords
    ) {
      throw new TypeError("store must implement the v9 state operations");
    }
    this.#store = store;
  }

  activate(chatKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    this.#active?.controller.abort(new LeaseExpiredError(this.#active.chatKey));
    const session = {
      chatKey,
      epoch: ++this.#epoch,
      controller: new AbortController(),
    };
    this.#active = session;
    return this.#lease(session);
  }

  deactivate() {
    const previous = this.#active;
    previous?.controller.abort(new LeaseExpiredError(previous.chatKey));
    this.#active = null;
  }

  getActiveLease() {
    return this.#active ? this.#lease(this.#active) : null;
  }

  isLeaseActive(lease) {
    return Boolean(
      lease &&
        this.#active &&
        lease.chatKey === this.#active.chatKey &&
        lease.sessionEpoch === this.#active.epoch &&
        !this.#active.controller.signal.aborted,
    );
  }

  assertLeaseActive(lease) {
    if (!this.isLeaseActive(lease)) {
      throw new LeaseExpiredError(String(lease?.chatKey || ""));
    }
  }

  async read(lease, { requiresActive = true } = {}) {
    if (requiresActive) this.assertLeaseActive(lease);
    const state = await this.#store.readConversation(requireChatKey(lease?.chatKey));
    if (requiresActive) this.assertLeaseActive(lease);
    return state;
  }

  async reconcile(lease, messages, { requiresActive = true } = {}) {
    const history = await snapshotHistory(messages);
    return this.enqueue(
      lease,
      async () => {
        const state = await this.#store.readConversation(lease.chatKey);
        return this.#store.reconcileHistory({
          chatKey: lease.chatKey,
          expectedRevision: state.head.revision,
          history,
        });
      },
      { requiresActive },
    );
  }

  async commit(lease, command, { requiresActive = true } = {}) {
    return this.enqueue(
      lease,
      () => this.#store.commit({ ...command, chatKey: lease.chatKey }),
      { requiresActive },
    );
  }

  async readRecall(lease, turnKey, { requiresActive = true } = {}) {
    if (requiresActive) this.assertLeaseActive(lease);
    const record = await this.#store.readRecall(requireChatKey(lease?.chatKey), turnKey);
    if (requiresActive) this.assertLeaseActive(lease);
    return record;
  }

  async createTurnRecords(lease, command = {}, { requiresActive = true } = {}) {
    return this.enqueue(
      lease,
      () => this.#store.createTurnRecords({
        chatKey: lease.chatKey,
        expectedRevision: command.expectedRevision,
        basisHistoryLength: command.basisHistoryLength,
        basisHistoryHash: command.basisHistoryHash,
        changeSet: command.changeSet,
        plannerRecord: command.plannerRecord || null,
        recallRecord: command.recallRecord || null,
      }),
      { requiresActive },
    );
  }

  enqueue(lease, task, { requiresActive = true } = {}) {
    const chatKey = requireChatKey(lease?.chatKey);
    if (typeof task !== "function") throw new TypeError("task must be a function");

    const previous = this.#queues.get(chatKey) || Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        if (requiresActive) this.assertLeaseActive(lease);
        const result = await task({
          lease,
          signal: lease.signal,
          assertActive: () => this.assertLeaseActive(lease),
        });
        if (requiresActive) this.assertLeaseActive(lease);
        return result;
      });
    const tail = pending.catch(() => undefined);
    this.#queues.set(chatKey, tail);
    tail.finally(() => {
      if (this.#queues.get(chatKey) === tail) this.#queues.delete(chatKey);
    });
    return pending;
  }

  #lease(session) {
    return Object.freeze({
      chatKey: session.chatKey,
      sessionEpoch: session.epoch,
      signal: session.controller.signal,
    });
  }
}
