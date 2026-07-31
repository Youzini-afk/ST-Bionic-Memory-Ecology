import {
  deriveBranchGraphFromSourceGraph,
  inheritHostBranchGraph,
  isSameHostLineage,
} from "./host-branch-inheritance.js";

function normalizeIdentifier(value = "") {
  return String(value ?? "").trim();
}

export function createHostBranchInheritanceController(deps = {}) {
  const inFlightByChatId = new Map();
  const getContext = () => deps.getContext?.() || {};
  const getRepository = () => deps.getRepository?.() || null;
  const resolveCurrentIdentity = () => deps.resolveCurrentIdentity?.() || null;

  async function ensure(identity = resolveCurrentIdentity(), sourceGraph = null) {
    const targetChatId = normalizeIdentifier(identity?.chatId);
    if (!targetChatId || !identity?.hostLineage?.parentConversationId) {
      return { inherited: false, skipped: true, reason: "not-host-branch" };
    }
    const existing = inFlightByChatId.get(targetChatId);
    if (existing) return await existing;

    const task = inheritHostBranchGraph({
      identity,
      currentChat: getContext()?.chat || [],
      sourceGraph,
      isCurrent: () => {
        const currentIdentity = resolveCurrentIdentity();
        return (
          currentIdentity?.chatId === targetChatId &&
          isSameHostLineage(currentIdentity?.hostLineage, identity.hostLineage)
        );
      },
      isSourceGraphCompatible(graph, sourceChatId, parentLineage) {
        if (!graph) return false;
        const graphLineage = graph?.historyState?.hostLineage;
        if (graphLineage?.conversationId && graphLineage?.branchId) {
          return isSameHostLineage(graphLineage, parentLineage);
        }
        return normalizeIdentifier(deps.getGraphOwnedChatId?.(graph)) === sourceChatId;
      },
      async isTargetEmpty(chatId) {
        const targetDb = await getRepository()?.getStoreForChat?.(chatId);
        if (!targetDb || typeof targetDb.isEmpty !== "function") {
          throw new Error("Host branch target store unavailable");
        }
        const status = await targetDb.isEmpty();
        return status?.empty === true;
      },
      async loadSourceGraph(sourceChatId) {
        const sourceDb = await getRepository()?.getStoreForChat?.(sourceChatId);
        if (!sourceDb || typeof sourceDb.exportSnapshot !== "function") return null;
        const snapshot = await sourceDb.exportSnapshot({
          includeTombstones: true,
          allowCrossLineageRead: true,
        });
        return deps.buildGraphFromSnapshot?.(snapshot, { chatId: sourceChatId }) || null;
      },
      deriveBranchGraph: deriveBranchGraphFromSourceGraph,
      async persistBranchGraph(branchGraph, branchContext) {
        const targetDb = await getRepository()?.getStoreForChat?.(
          branchContext.targetChatId,
        );
        if (!targetDb || typeof targetDb.importSnapshot !== "function") {
          return { accepted: false, saved: false, reason: "target-store-unavailable" };
        }
        const lineage = branchContext.lineage;
        const snapshot = deps.buildSnapshotFromGraph?.(branchGraph, {
          chatId: branchContext.targetChatId,
          revision: 1,
          meta: {
            hostConversationId: lineage.conversationId,
            hostBranchId: lineage.branchId,
            hostRevision: lineage.hostRevision,
            hostCommitEventId: lineage.commitEventId || "",
            hostCommitTransactionId: lineage.commitTransactionId || "",
            branchParentConversationId: branchContext.parentLineage.conversationId,
            branchParentBranchId: branchContext.parentLineage.branchId,
            branchParentRevision: branchContext.parentLineage.hostRevision,
            branchParentPersistenceChatId: branchContext.sourceChatId,
            branchInheritedAt: new Date().toISOString(),
          },
        });
        if (!snapshot) {
          return { accepted: false, saved: false, reason: "branch-snapshot-unavailable" };
        }

        const authorityTarget = deps.isAuthorityStore?.(targetDb) === true;
        let imported = null;
        if (authorityTarget && typeof targetDb.commitDelta === "function") {
          const runtimeMetaPatch = {
            ...(snapshot.meta || {}),
            ...(snapshot.state || {}),
          };
          for (const key of [
            "revision",
            "lastModified",
            "lastMutationReason",
            "syncDirty",
            "syncDirtyReason",
            "nodeCount",
            "edgeCount",
            "tombstoneCount",
          ]) {
            delete runtimeMetaPatch[key];
          }
          imported = await targetDb.commitDelta(
            {
              upsertNodes: snapshot.nodes || [],
              upsertEdges: snapshot.edges || [],
              tombstones: snapshot.tombstones || [],
              deleteNodeIds: [],
              deleteEdgeIds: [],
              runtimeMetaPatch,
            },
            {
              baseRevision: 0,
              reason: "host-branch-inherited",
              markSyncDirty: true,
              vectorDirtyHint: true,
              hostContext: deps.captureHostContext?.() || null,
              idempotencyKey: [
                "host-branch-inherit",
                lineage.conversationId,
                lineage.branchId,
                branchContext.sourceChatId,
              ].join(":"),
            },
          );
        } else {
          imported = await targetDb.importSnapshot(snapshot, {
            mode: "replace",
            expectedRevision: 0,
            markSyncDirty: true,
          });
        }
        const persistedSnapshot = await targetDb.exportSnapshot({
          includeTombstones: true,
        });
        if (!authorityTarget) {
          deps.cacheLocalSnapshot?.(branchContext.targetChatId, persistedSnapshot);
        }
        return {
          accepted: true,
          saved: true,
          revision: Number(imported?.revision || persistedSnapshot?.meta?.revision || 0),
          storageTier: String(
            persistedSnapshot?.meta?.storagePrimary ||
              persistedSnapshot?.meta?.storageMode ||
              "local",
          ),
        };
      },
      async rememberIdentityAlias(persistenceChatId, lineage, committed = {}) {
        deps.rememberIdentityAlias?.({
          integrity: identity.integrity,
          hostChatId: identity.hostChatId,
          persistenceChatId,
          hostConversationId: lineage.conversationId,
          hostBranchId: lineage.branchId,
        });
        if (committed.stillCurrent && committed.persistence?.saved !== false) {
          deps.persistCommitMarker?.(getContext(), {
            reason: "host-branch-inherited",
            revision: Number(committed.persistence?.revision || 0),
            storageTier: String(committed.persistence?.storageTier || "local"),
            accepted: true,
            graph: committed.branchGraph,
            chatId: persistenceChatId,
            immediate: true,
          });
        }
      },
    });

    inFlightByChatId.set(targetChatId, task);
    try {
      return await task;
    } catch (error) {
      (deps.logger || console).warn?.(
        "[ST-BME] Host branch memory inheritance deferred:",
        error,
      );
      return {
        inherited: false,
        skipped: false,
        reason: "host-branch-inheritance-failed",
        targetChatId,
        error: error?.message || String(error),
      };
    } finally {
      if (inFlightByChatId.get(targetChatId) === task) {
        inFlightByChatId.delete(targetChatId);
      }
    }
  }

  return Object.freeze({ ensure });
}
