function normalizeServerScore(item = {}) {
  for (const [field, source] of [
    ["score", "server-score"],
    ["similarity", "server-similarity"],
    ["rankScore", "server-rank-score"],
  ]) {
    const rawValue = item?.[field];
    if (rawValue === null || rawValue === undefined) continue;
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
      return { score: Math.max(0, Math.min(1, numeric)), source };
    }
  }
  const distance = Number(item?.distance);
  if (item?.distance !== null && item?.distance !== undefined && Number.isFinite(distance)) {
    return {
      score: 1 / (1 + Math.max(0, distance)),
      source: "server-distance",
    };
  }
  return null;
}

export function parseBackendVectorQueryResponse(
  data,
  { nodeIdByHash = {}, allowedIds = null, topK = 10 } = {},
) {
  const hashes = Array.isArray(data?.hashes) ? data.hashes : [];
  const parallelScores = Array.isArray(data?.scores) ? data.scores : [];
  const richItems = [data?.results, data?.items, data?.matches]
    .find((items) => Array.isArray(items)) || [];
  const scoreByHash = new Map();
  for (const [index, rawHash] of hashes.entries()) {
    const normalized = normalizeServerScore({ score: parallelScores[index] });
    if (normalized) scoreByHash.set(String(rawHash), normalized);
  }
  for (const item of richItems) {
    const rawHash = item?.hash ?? item?.metadata?.hash ?? item?.item?.metadata?.hash;
    const normalized = normalizeServerScore(item);
    if (rawHash !== undefined && normalized) {
      scoreByHash.set(String(rawHash), normalized);
    }
  }
  for (const item of Array.isArray(data?.metadata) ? data.metadata : []) {
    const rawHash = item?.hash ?? item?.metadata?.hash;
    const normalized = normalizeServerScore(item);
    if (rawHash !== undefined && normalized) {
      scoreByHash.set(String(rawHash), normalized);
    }
  }
  const orderedHashes = hashes.length > 0
    ? hashes
    : richItems.map(
        (item) => item?.hash ?? item?.metadata?.hash ?? item?.item?.metadata?.hash,
      );
  const allowed = allowedIds instanceof Set
    ? allowedIds
    : Array.isArray(allowedIds)
      ? new Set(allowedIds)
      : null;
  const deduped = new Map();
  for (const [index, rawHash] of orderedHashes.entries()) {
    if (rawHash === undefined || rawHash === null) continue;
    const nodeId = nodeIdByHash[rawHash] ?? nodeIdByHash[String(rawHash)];
    if (!nodeId || (allowed && !allowed.has(nodeId))) continue;
    const serverScore = scoreByHash.get(String(rawHash));
    const score = serverScore
      ? serverScore.score
      : Math.max(0.01, 1 - index / Math.max(1, orderedHashes.length));
    const current = deduped.get(nodeId);
    if (!current || score > current.score) {
      deduped.set(nodeId, {
        nodeId,
        score,
        scoreSource: serverScore?.source || "rank-fallback",
      });
    }
  }
  const results = [...deduped.values()];
  if (results.some((entry) => entry.scoreSource.startsWith("server-"))) {
    results.sort(
      (left, right) =>
        right.score - left.score || left.nodeId.localeCompare(right.nodeId, "en"),
    );
  }
  return {
    results: results.slice(0, Math.max(1, Math.floor(Number(topK) || 1))),
    scoreSource:
      results.length === 0
        ? "none"
        : results.every((entry) => entry.scoreSource.startsWith("server-"))
          ? "server"
          : results.some((entry) => entry.scoreSource.startsWith("server-"))
            ? "mixed"
            : "rank-fallback",
    hashCount: orderedHashes.length,
  };
}
