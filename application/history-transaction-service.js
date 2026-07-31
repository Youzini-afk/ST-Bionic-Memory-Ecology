import { planHistoryReconciliation } from "../domain/history-reconciliation.js";

export class HistoryTransactionService {
  constructor({ ledgerRepository } = {}) {
    if (!ledgerRepository || typeof ledgerRepository.transact !== "function") {
      throw new TypeError("HistoryTransactionService requires ledgerRepository");
    }
    this.ledgerRepository = ledgerRepository;
  }

  async reconcile(
    identity,
    conversationSnapshot,
    { mutationId = "", reason = "history-reconciled", now = Date.now() } = {},
  ) {
    const chatId = String(identity?.chatId || conversationSnapshot?.chatId || "").trim();
    if (!chatId) throw new TypeError("history reconciliation requires stable chatId");
    const snapshotChatId = String(conversationSnapshot?.chatId || "").trim();
    if (snapshotChatId && snapshotChatId !== chatId) {
      throw new TypeError(
        `history snapshot belongs to another chat: ${snapshotChatId}`,
      );
    }
    let latestPlan = null;
    const committed = await this.ledgerRepository.transact(chatId, (ledger) => {
      latestPlan = planHistoryReconciliation(ledger, {
        turns: conversationSnapshot?.turns || [],
        mutationId,
        reason,
        historyFingerprint: conversationSnapshot?.historyFingerprint || "",
        now,
      });
      return latestPlan.transaction;
    });
    return {
      ...committed,
      plan: latestPlan,
      identity: { ...identity, chatId },
      originChatId: chatId,
    };
  }
}
