import { forkMemoryLedger } from "../domain/memory-branch.js";

export class BranchTransactionService {
  constructor({ ledgerRepository } = {}) {
    if (
      !ledgerRepository ||
      typeof ledgerRepository.load !== "function" ||
      typeof ledgerRepository.transact !== "function"
    ) {
      throw new TypeError("BranchTransactionService requires ledgerRepository");
    }
    this.ledgerRepository = ledgerRepository;
  }

  async fork(sourceIdentity, targetIdentity, options = {}) {
    const sourceChatId = String(sourceIdentity?.chatId || "").trim();
    const targetChatId = String(targetIdentity?.chatId || "").trim();
    if (!sourceChatId || !targetChatId) {
      throw new TypeError("branch transaction requires source and target chat identities");
    }
    const sourceLedger = await this.ledgerRepository.load(sourceChatId, { fresh: true });
    const planned = forkMemoryLedger(sourceLedger, {
      targetChatId,
      targetHostChatId: targetIdentity?.hostChatId || "",
      cutoffFloor: options.cutoffFloor ?? targetIdentity?.branchCutoff,
      includedTurnIds: options.includedTurnIds || [],
      branchId: options.branchId || "",
      now: options.now ?? Date.now(),
    });
    if (!planned.transaction) {
      return { ...planned, sourceLedger, persisted: false };
    }
    const committed = await this.ledgerRepository.transact(
      targetChatId,
      planned.transaction,
    );
    return {
      ...planned,
      ...committed,
      sourceLedger,
      originChatId: sourceChatId,
      targetChatId,
      persisted: true,
    };
  }
}
