// ST-BME identity resolver core.
//
// Phase 1 keeps this module pure: callers provide context-like objects,
// graph-owned metadata, alias callbacks, and persistence state snapshots.
// The module separates active identity, graph-owner identity, queued/runtime
// fallback identity, marker identity, and equivalence checks so later phases
// can stop promoting recovery evidence into the active chat identity.

export function normalizeIdentityValue(value = "") {
  return String(value ?? "").trim();
}

export function hasLikelySelectedChatContextCore(context = null) {
  if (!context || typeof context !== "object") return false;
  const metadata = context.chatMetadata;
  const hasMeaningfulChatMetadata = Boolean(
    metadata &&
      typeof metadata === "object" &&
      Object.keys(metadata).some((key) => metadata[key] != null && metadata[key] !== ""),
  );
  const hasChatMessages = Array.isArray(context.chat) && context.chat.length > 0;
  const hasCharacterId =
    context.characterId !== undefined &&
    context.characterId !== null &&
    String(context.characterId).trim() !== "";
  const hasGroupId =
    context.groupId !== undefined &&
    context.groupId !== null &&
    String(context.groupId).trim() !== "";
  return hasMeaningfulChatMetadata || hasChatMessages || hasCharacterId || hasGroupId;
}

export function resolveActiveHostChatIdCore({
  context = null,
  readGlobalCurrentChatId = null,
} = {}) {
  const candidates = [
    context?.chatId,
    typeof context?.getCurrentChatId === "function" ? context.getCurrentChatId() : "",
    typeof readGlobalCurrentChatId === "function" ? readGlobalCurrentChatId() : "",
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  return candidates.map((candidate) => normalizeIdentityValue(candidate)).find(Boolean) || "";
}

export function getContextIntegrityCore(context = null) {
  return normalizeIdentityValue(context?.chatMetadata?.integrity);
}

export function resolveActiveChatIdentityCore({
  context = null,
  hostChatId = "",
  integrity = "",
  resolveAliasByHostChatId = null,
  hasLikelySelectedChat = null,
} = {}) {
  const normalizedHostChatId = normalizeIdentityValue(hostChatId);
  const normalizedIntegrity = normalizeIdentityValue(integrity);
  const aliasedChatId =
    !normalizedIntegrity &&
    normalizedHostChatId &&
    typeof resolveAliasByHostChatId === "function"
      ? normalizeIdentityValue(resolveAliasByHostChatId(normalizedHostChatId))
      : "";
  const chatId = normalizedIntegrity || aliasedChatId || normalizedHostChatId;
  const hasLikely =
    typeof hasLikelySelectedChat === "function"
      ? hasLikelySelectedChat(context)
      : hasLikelySelectedChatContextCore(context);

  return {
    chatId,
    hostChatId: normalizedHostChatId,
    integrity: normalizedIntegrity,
    identitySource: normalizedIntegrity
      ? "integrity"
      : aliasedChatId
        ? "alias"
        : normalizedHostChatId
          ? "host-chat-id"
          : "",
    hasLikelySelectedChat: hasLikely,
  };
}

export function resolveCurrentChatIdentityCore({
  context = null,
  readGlobalCurrentChatId = null,
  resolveAliasByHostChatId = null,
  resolveIntegrity = null,
  hasLikelySelectedChat = null,
} = {}) {
  const hostChatId = resolveActiveHostChatIdCore({ context, readGlobalCurrentChatId });
  const integrity =
    typeof resolveIntegrity === "function"
      ? normalizeIdentityValue(resolveIntegrity(context))
      : getContextIntegrityCore(context) ||
        normalizeIdentityValue(
          context?.chatMetadata?.chat_id || context?.chatMetadata?.chatId || "",
        );
  return resolveActiveChatIdentityCore({
    context,
    hostChatId,
    integrity,
    resolveAliasByHostChatId,
    hasLikelySelectedChat,
  });
}

export function resolveGraphOwnerIdentityCore({ graph = null, graphMeta = null } = {}) {
  const ownedCandidates = [graph?.historyState?.chatId, graphMeta?.chatId];
  const chatId = ownedCandidates.map((candidate) => normalizeIdentityValue(candidate)).find(Boolean) || "";
  return {
    chatId,
    source: normalizeIdentityValue(graph?.historyState?.chatId)
      ? "history-state"
      : normalizeIdentityValue(graphMeta?.chatId)
        ? "graph-meta"
        : "",
    integrity: normalizeIdentityValue(graphMeta?.integrity),
  };
}

export function resolveRuntimeGraphFallbackIdentityCore({
  graph = null,
  graphMeta = null,
  persistenceState = null,
} = {}) {
  const fallbackCandidates = [
    graph?.historyState?.chatId,
    graphMeta?.chatId,
    persistenceState?.chatId,
    persistenceState?.queuedPersistChatId,
    persistenceState?.commitMarker?.chatId,
  ];
  const chatId = fallbackCandidates.map((candidate) => normalizeIdentityValue(candidate)).find(Boolean) || "";
  return {
    chatId,
    source: chatId ? "runtime-fallback" : "",
  };
}

export function resolvePersistenceChatIdCore({
  explicitChatId = "",
  activeIdentity = null,
  graph = null,
  graphMeta = null,
  currentGraph = null,
  currentGraphMeta = null,
  persistenceState = null,
  context = null,
} = {}) {
  const directChatId = normalizeIdentityValue(explicitChatId);
  if (directChatId) return directChatId;

  const resolvedChatId = normalizeIdentityValue(activeIdentity?.chatId);
  if (resolvedChatId) return resolvedChatId;

  const fallbackCandidates = [
    graph?.historyState?.chatId,
    graphMeta?.chatId,
    currentGraph?.historyState?.chatId,
    currentGraphMeta?.chatId,
    persistenceState?.chatId,
    persistenceState?.queuedPersistChatId,
    persistenceState?.commitMarker?.chatId,
    context?.chatMetadata?.integrity,
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  return fallbackCandidates.map((candidate) => normalizeIdentityValue(candidate)).find(Boolean) || "";
}

export function getKnownChatIdsForIdentityCore({ identity = null, aliasCandidates = [] } = {}) {
  const knownChatIds = new Set();
  const addKnownChatId = (value) => {
    const normalized = normalizeIdentityValue(value);
    if (normalized) knownChatIds.add(normalized);
  };
  addKnownChatId(identity?.chatId);
  addKnownChatId(identity?.hostChatId);
  addKnownChatId(identity?.integrity);
  for (const aliasCandidate of Array.isArray(aliasCandidates) ? aliasCandidates : []) {
    addKnownChatId(aliasCandidate);
  }
  return knownChatIds;
}

export function doesChatIdMatchIdentityCore(candidateChatId, { identity = null, aliasCandidates = [] } = {}) {
  const normalizedCandidate = normalizeIdentityValue(candidateChatId);
  if (!normalizedCandidate || !identity || typeof identity !== "object") return false;
  return getKnownChatIdsForIdentityCore({ identity, aliasCandidates }).has(normalizedCandidate);
}

export function areChatIdsEquivalentForIdentityCore(
  candidateChatId,
  referenceChatId,
  { identity = null, aliasCandidates = [] } = {},
) {
  const normalizedCandidate = normalizeIdentityValue(candidateChatId);
  const normalizedReference = normalizeIdentityValue(referenceChatId);
  if (!normalizedCandidate || !normalizedReference) {
    return normalizedCandidate === normalizedReference;
  }
  if (normalizedCandidate === normalizedReference) return true;
  return (
    doesChatIdMatchIdentityCore(normalizedCandidate, { identity, aliasCandidates }) &&
    doesChatIdMatchIdentityCore(normalizedReference, { identity, aliasCandidates })
  );
}

export function canMutateRuntimeGraphForIdentityCore({
  graph = null,
  activeIdentity = null,
  graphOwnedChatId = "",
  persistenceState = null,
  aliasCandidates = [],
  loadedStates = ["loaded", "empty-confirmed"],
  allowNoChatState = false,
  noChatState = "no-chat",
} = {}) {
  if (
    !graph ||
    typeof graph !== "object" ||
    !graph.historyState ||
    typeof graph.historyState !== "object" ||
    Array.isArray(graph.historyState)
  ) {
    return false;
  }

  const ownedChatId = normalizeIdentityValue(graphOwnedChatId);
  if (!ownedChatId) return false;

  const liveChatId = normalizeIdentityValue(activeIdentity?.chatId);
  if (liveChatId) {
    return (
      areChatIdsEquivalentForIdentityCore(ownedChatId, liveChatId, {
        identity: activeIdentity,
        aliasCandidates,
      }) ||
      areChatIdsEquivalentForIdentityCore(liveChatId, ownedChatId, {
        identity: activeIdentity,
        aliasCandidates,
      })
    );
  }

  const stateChatId = normalizeIdentityValue(persistenceState?.chatId);
  if (!stateChatId || stateChatId !== ownedChatId) return false;

  const markerChatId = normalizeIdentityValue(persistenceState?.commitMarker?.chatId);
  if (markerChatId && markerChatId !== ownedChatId) return false;

  const loadState = String(persistenceState?.loadState || "");
  if (
    loadedStates.includes(loadState) ||
    persistenceState?.dbReady === true
  ) {
    return true;
  }

  return allowNoChatState === true && loadState === noChatState;
}

export function planRuntimeGraphIdentityRepairCore({
  graph = null,
  graphOwnedChatId = "",
  stateChatId = "",
  activeIdentity = null,
  markerChatId = "",
  aliasCandidates = [],
} = {}) {
  if (
    !graph ||
    typeof graph !== "object" ||
    Array.isArray(graph) ||
    !graph.historyState ||
    typeof graph.historyState !== "object" ||
    Array.isArray(graph.historyState)
  ) {
    return { shouldRepair: false, reason: "missing-runtime-graph" };
  }

  const ownedChatId = normalizeIdentityValue(graphOwnedChatId);
  if (ownedChatId) {
    return { shouldRepair: false, reason: "graph-identity-present", chatId: ownedChatId };
  }

  const normalizedStateChatId = normalizeIdentityValue(stateChatId);
  if (!normalizedStateChatId) {
    return { shouldRepair: false, reason: "missing-persistence-chat-id" };
  }

  const liveChatId = normalizeIdentityValue(activeIdentity?.chatId);
  if (
    liveChatId &&
    !areChatIdsEquivalentForIdentityCore(normalizedStateChatId, liveChatId, {
      identity: activeIdentity,
      aliasCandidates,
    }) &&
    !areChatIdsEquivalentForIdentityCore(liveChatId, normalizedStateChatId, {
      identity: activeIdentity,
      aliasCandidates,
    })
  ) {
    return {
      shouldRepair: false,
      reason: "live-chat-mismatch",
      chatId: normalizedStateChatId,
      liveChatId,
    };
  }

  const normalizedMarkerChatId = normalizeIdentityValue(markerChatId);
  if (normalizedMarkerChatId && normalizedMarkerChatId !== normalizedStateChatId) {
    return {
      shouldRepair: false,
      reason: "commit-marker-chat-mismatch",
      chatId: normalizedStateChatId,
      markerChatId: normalizedMarkerChatId,
    };
  }

  return { shouldRepair: true, reason: "repair", chatId: normalizedStateChatId };
}
