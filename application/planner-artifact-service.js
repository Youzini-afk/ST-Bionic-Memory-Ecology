import { MEMORY_RECORD_KIND, TURN_ARTIFACT_KIND } from "../domain/memory-contract.js";
import { cloneDomainValue } from "../domain/memory-id.js";
import {
  findReusableTurnArtifact,
  planTurnArtifactCommit,
  turnArtifactToPlannerResult,
} from "../domain/turn-artifact.js";

export class PlannerArtifactService {
  constructor({ repository, now = () => Date.now() } = {}) {
    if (!repository || typeof repository.load !== "function" || typeof repository.transact !== "function") {
      throw new TypeError("PlannerArtifactService requires a memory ledger repository");
    }
    this.repository = repository;
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  async reuse({ chatId, turnId, inputFingerprint, historyFingerprint = "" } = {}) {
    const ledger = await this.repository.load(chatId, { fresh: true });
    const artifact = findReusableTurnArtifact(ledger, {
      turnId,
      artifactKind: TURN_ARTIFACT_KIND.PLANNER,
      inputFingerprint,
      historyFingerprint,
    });
    return artifact ? turnArtifactToPlannerResult(artifact) : null;
  }

  async publish({
    chatId,
    turnId,
    inputFingerprint,
    historyFingerprint = "",
    expectedMemoryStateFingerprint = "",
    recallArtifactId = "",
    selectedMemoryIds = [],
    candidateMemoryIds = [],
    plotText = "",
    plotBlocks = [],
    source = "ena-planner",
    result = {},
  } = {}) {
    if (!String(recallArtifactId || "").trim()) {
      throw new TypeError("Planner artifact requires its Recall artifact");
    }
    let planned = null;
    const persisted = await this.repository.transact(chatId, (ledger) => {
      const expected = String(expectedMemoryStateFingerprint || "").trim();
      if (!expected) {
        throw new TypeError("Planner artifact requires the Recall memory-state fingerprint");
      }
      planned = planTurnArtifactCommit(ledger, {
        turnId,
        artifactKind: TURN_ARTIFACT_KIND.PLANNER,
        inputFingerprint,
        historyFingerprint,
        expectedMemoryStateFingerprint: expected,
        selectedMemoryIds,
        candidateMemoryIds,
        sourceArtifactIds: recallArtifactId ? [recallArtifactId] : [],
        contentText: String(plotText || "").trim(),
        injectionText: "",
        source,
        result: {
          ...cloneDomainValue(result, {}),
          plotText: String(plotText || "").trim(),
          plotBlocks: (plotBlocks || []).map((block) => String(block || "")).filter(Boolean),
          recallArtifactId: String(recallArtifactId || ""),
        },
        now: this.now(),
      });
      return planned.transaction;
    });
    const artifact =
      (persisted.appendedRecords || []).find(
        (record) => record.kind === MEMORY_RECORD_KIND.TURN_ARTIFACT,
      ) || planned?.artifact;
    return {
      ...turnArtifactToPlannerResult(artifact),
      published: true,
      persistedReuse: planned?.reused === true || persisted.replayed === true,
    };
  }
}
