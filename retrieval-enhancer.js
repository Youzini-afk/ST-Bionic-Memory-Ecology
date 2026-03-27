import { embedText, searchSimilar } from "./embedding.js";
import { getNode } from "./graph.js";
import { isDirectVectorConfig } from "./vector-index.js";

const COOCCURRENCE_EXCLUDED_TYPES = new Set([
  "event",
  "synopsis",
  "reflection",
]);

const cooccurrenceCache = new WeakMap();

export function splitIntentSegments(
  text,
  { maxSegments = 4, minLength = 3 } = {},
) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const segments = raw
    .split(/[，,。.；;！!？?\n]+|(?:顺便|另外|还有|对了|然后|而且|并且|同时)/)
    .map((item) => item.trim())
    .filter((item) => item.length >= minLength);

  return uniqueStrings(segments).slice(0, Math.max(1, maxSegments));
}

export function mergeVectorResults(resultGroups = [], limit = Infinity) {
  const merged = new Map();
  let rawHitCount = 0;

  for (const group of resultGroups) {
    for (const item of Array.isArray(group) ? group : []) {
      if (!item?.nodeId) continue;
      rawHitCount += 1;
      const score = Number(item.score) || 0;
      const existing = merged.get(item.nodeId);
      if (!existing || score > existing.score) {
        merged.set(item.nodeId, { ...item, score });
      }
    }
  }

  const results = [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.nodeId).localeCompare(String(b.nodeId));
    })
    .slice(0, Number.isFinite(limit) ? limit : merged.size);

  return {
    rawHitCount,
    results,
  };
}

export function isEligibleAnchorNode(node) {
  if (!node || node.archived) return false;
  if (COOCCURRENCE_EXCLUDED_TYPES.has(node.type)) return false;
  return getAnchorTerms(node).length > 0;
}

export function getAnchorTerms(node) {
  return [node?.fields?.name, node?.fields?.title]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
}

export function collectSupplementalAnchorNodeIds(
  graph,
  vectorResults = [],
  primaryAnchorIds = [],
  maxCount = 5,
) {
  const selected = [];
  const seen = new Set(primaryAnchorIds || []);

  for (const result of vectorResults) {
    if (selected.length >= maxCount) break;
    const node = getNode(graph, result?.nodeId);
    if (!isEligibleAnchorNode(node) || seen.has(node.id)) continue;
    seen.add(node.id);
    selected.push(node.id);
  }

  return selected;
}

export function createCooccurrenceIndex(
  graph,
  {
    maxAnchorsPerBatch = 10,
    eligibleNodes = null,
  } = {},
) {
  const nodes = Array.isArray(eligibleNodes)
    ? eligibleNodes.filter(isEligibleAnchorNode)
    : [];
  const eligibleNodeKey = nodes.map((node) => node.id).sort().join("|");
  const cacheKey = [
    graph?.batchJournal?.length || 0,
    graph?.nodes?.length || 0,
    graph?.historyState?.lastProcessedAssistantFloor ?? -1,
    maxAnchorsPerBatch,
    eligibleNodeKey,
  ].join(":");
  const cached = cooccurrenceCache.get(graph);
  if (cached?.key === cacheKey) {
    return cached.value;
  }

  const index = new Map();
  let pairCount = 0;
  let batchCount = 0;
  let source = "seqRange";

  if (nodes.length >= 2 && Array.isArray(graph?.batchJournal)) {
    for (const journal of graph.batchJournal) {
      const range = Array.isArray(journal?.processedRange)
        ? journal.processedRange
        : null;
      if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
        continue;
      }

      const batchNodes = nodes
        .filter((node) => rangesOverlap(node.seqRange, range))
        .sort(compareBySeqDesc)
        .slice(0, Math.max(2, maxAnchorsPerBatch));
      if (batchNodes.length < 2) continue;

      batchCount += 1;
      pairCount += appendPairs(index, batchNodes, 1);
    }
  }

  if (batchCount === 0) {
    source = "seqRange";
    pairCount = 0;
    index.clear();

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const overlap = rangeOverlapSize(nodes[i].seqRange, nodes[j].seqRange);
        if (overlap <= 0) continue;
        addCooccurrence(index, nodes[i].id, nodes[j].id, overlap);
        addCooccurrence(index, nodes[j].id, nodes[i].id, overlap);
        pairCount += 1;
      }
    }
  } else {
    source = "batchJournal";
  }

  const result = {
    map: normalizeCooccurrenceMap(index),
    source,
    batchCount,
    pairCount,
  };
  cooccurrenceCache.set(graph, { key: cacheKey, value: result });
  return result;
}

export function applyCooccurrenceBoost(
  baseScores,
  anchorWeights,
  cooccurrenceIndex,
  { scale = 0.1, maxNeighbors = 10 } = {},
) {
  const nextScores = new Map(baseScores || []);
  const boostedNodes = [];
  const map = cooccurrenceIndex?.map instanceof Map
    ? cooccurrenceIndex.map
    : new Map();

  for (const [anchorId, anchorScore] of anchorWeights.entries()) {
    const neighbors = map.get(anchorId) || [];
    const capped = neighbors.slice(0, Math.max(1, maxNeighbors));

    for (const item of capped) {
      const bonus =
        Math.max(0, Number(anchorScore) || 0) *
        Math.log(1 + Math.max(0, Number(item.count) || 0)) *
        Math.max(0, Number(scale) || 0);
      if (!bonus) continue;

      nextScores.set(item.nodeId, (nextScores.get(item.nodeId) || 0) + bonus);
      boostedNodes.push({
        anchorId,
        nodeId: item.nodeId,
        count: item.count,
        bonus,
      });
    }
  }

  return {
    scores: nextScores,
    boostedNodes,
  };
}

export function dppGreedySelect(
  candidateVecs = [],
  candidateScores = [],
  k,
  qualityWeight = 1,
) {
  const total = Math.min(candidateVecs.length, candidateScores.length);
  const target = Math.max(0, Math.min(k, total));
  if (target >= total) {
    return Array.from({ length: total }, (_, index) => index);
  }

  const normalized = candidateVecs.map((vector) => normalizeVector(vector));
  const q = candidateScores.map((score) =>
    Math.pow(Math.max(Number(score) || 0, 1e-10), Math.max(0, qualityWeight)),
  );
  const diag = q.map((value) => value * value + 1e-8);
  const chol = Array.from({ length: target }, () =>
    Array(total).fill(0),
  );
  const selected = [];

  for (let j = 0; j < target; j++) {
    let bestIndex = -1;
    let bestValue = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < total; i++) {
      if (selected.includes(i)) continue;
      if (diag[i] > bestValue) {
        bestValue = diag[i];
        bestIndex = i;
      }
    }

    if (bestIndex === -1) break;
    selected.push(bestIndex);

    if (j === target - 1 || diag[bestIndex] < 1e-10) {
      continue;
    }

    const row = normalized.map(
      (vector, index) => q[bestIndex] * dot(normalized[bestIndex], vector) * q[index],
    );
    const next = [...row];
    for (let i = 0; i < j; i++) {
      const pivot = chol[i][bestIndex];
      for (let index = 0; index < total; index++) {
        next[index] -= pivot * chol[i][index];
      }
    }

    const inv = 1 / Math.sqrt(diag[bestIndex]);
    for (let index = 0; index < total; index++) {
      chol[j][index] = next[index] * inv;
      diag[index] = Math.max(0, diag[index] - chol[j][index] ** 2);
    }
  }

  return selected;
}

export function applyDiversitySampling(
  candidates = [],
  { k, qualityWeight = 1 } = {},
) {
  const target = Math.max(1, Math.floor(Number(k) || 0));
  if (candidates.length <= target) {
    return {
      applied: false,
      reason: "candidate-pool-too-small",
      selected: candidates.slice(0, target),
      beforeCount: candidates.length,
      afterCount: Math.min(candidates.length, target),
    };
  }

  if (
    candidates.some(
      (item) =>
        !Array.isArray(item?.node?.embedding) || item.node.embedding.length === 0,
    )
  ) {
    return {
      applied: false,
      reason: "candidate-embeddings-missing",
      selected: candidates.slice(0, target),
      beforeCount: candidates.length,
      afterCount: Math.min(candidates.length, target),
    };
  }

  const indexes = dppGreedySelect(
    candidates.map((item) => item.node.embedding),
    candidates.map((item) => item.finalScore),
    target,
    qualityWeight,
  );

  const selected = indexes
    .map((index) => candidates[index])
    .filter(Boolean);

  if (selected.length !== target) {
    return {
      applied: false,
      reason: "dpp-selection-incomplete",
      selected: candidates.slice(0, target),
      beforeCount: candidates.length,
      afterCount: Math.min(candidates.length, target),
    };
  }

  return {
    applied: true,
    reason: "",
    selected,
    beforeCount: candidates.length,
    afterCount: selected.length,
  };
}

export function nmfQueryAnalysis(
  queryVec,
  entityVecs,
  { nTopics = 15, maxIter = 100, tolerance = 1e-4 } = {},
) {
  const vectors = normalizeMatrix(entityVecs);
  const query = vectorAbs(queryVec);
  if (vectors.length < 2 || query.length === 0) {
    return {
      semanticDepth: 0,
      topicCoverage: 0,
      novelty: 1,
      topTopics: [],
    };
  }

  const k = Math.min(Math.max(1, Math.floor(nTopics)), vectors.length);
  const matrix = vectors.map((vector) => vectorAbs(vector));
  const { h } = nmfMultiplicativeUpdate(matrix, k, maxIter, tolerance);
  const rawScores = h.map((topic) => dot(query, topic));
  const topics = softmax(rawScores);

  const entropy = -topics.reduce((sum, value) => {
    return value > 1e-10 ? sum + value * Math.log(value) : sum;
  }, 0);
  const maxEntropy = k > 1 ? Math.log(k) : 1;
  const semanticDepth = 1 - entropy / maxEntropy;
  const topicCoverage = topics.filter((value) => value > 0.5 / k).length;
  const reconstruction = Array(query.length).fill(0);

  for (let topicIndex = 0; topicIndex < topics.length; topicIndex++) {
    const weight = topics[topicIndex];
    for (let dim = 0; dim < reconstruction.length; dim++) {
      reconstruction[dim] += weight * h[topicIndex][dim];
    }
  }

  const novelty =
    l2Norm(subtractVectors(query, reconstruction)) / Math.max(l2Norm(query), 1e-10);

  return {
    semanticDepth,
    topicCoverage,
    novelty,
    topTopics: topics,
  };
}

export function sparseCodeResidual(
  queryVec,
  entityVecs,
  { lambda = 0.1, maxIter = 80 } = {},
) {
  const query = normalizeVector(queryVec, false);
  const entities = normalizeMatrix(entityVecs);
  const total = entities.length;
  if (total === 0 || query.length === 0) {
    return {
      alpha: [],
      residual: [...query],
      residualNorm: l2Norm(query),
    };
  }

  const gram = Array.from({ length: total }, () => Array(total).fill(0));
  const etq = Array(total).fill(0);

  for (let i = 0; i < total; i++) {
    etq[i] = dot(entities[i], query);
    for (let j = i; j < total; j++) {
      const value = dot(entities[i], entities[j]);
      gram[i][j] = value;
      gram[j][i] = value;
    }
  }

  let lipschitz = 0;
  for (let i = 0; i < total; i++) {
    const rowSum = gram[i].reduce((sum, value) => sum + Math.abs(value), 0);
    lipschitz = Math.max(lipschitz, rowSum);
  }
  if (lipschitz < 1e-10) {
    return {
      alpha: Array(total).fill(0),
      residual: [...query],
      residualNorm: l2Norm(query),
    };
  }

  const step = 1 / lipschitz;
  let alpha = Array(total).fill(0);
  let y = [...alpha];
  let t = 1;

  for (let iteration = 0; iteration < maxIter; iteration++) {
    const grad = matVecMul(gram, y).map((value, index) => value - etq[index]);
    const nextAlpha = softThreshold(
      y.map((value, index) => value - step * grad[index]),
      lambda * step,
    );
    const nextT = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const momentum = (t - 1) / nextT;
    y = nextAlpha.map(
      (value, index) => value + momentum * (value - alpha[index]),
    );
    alpha = nextAlpha;
    t = nextT;
  }

  const reconstruction = Array(query.length).fill(0);
  for (let i = 0; i < total; i++) {
    if (Math.abs(alpha[i]) < 1e-10) continue;
    for (let dim = 0; dim < query.length; dim++) {
      reconstruction[dim] += alpha[i] * entities[i][dim];
    }
  }

  const residual = subtractVectors(query, reconstruction);
  return {
    alpha,
    residual,
    residualNorm: l2Norm(residual),
  };
}

export async function runResidualRecall({
  queryText,
  graph,
  embeddingConfig,
  basisNodes = [],
  candidateNodes = [],
  basisLimit = 24,
  nTopics = 15,
  noveltyThreshold = 0.4,
  residualThreshold = 0.3,
  residualTopK = 5,
  signal,
}) {
  if (!isDirectVectorConfig(embeddingConfig)) {
    return {
      triggered: false,
      hits: [],
      skipReason: "residual-direct-mode-required",
    };
  }

  const filteredBasis = basisNodes
    .filter(
      (node) =>
        Array.isArray(node?.embedding) && node.embedding.length > 0,
    )
    .slice(0, Math.max(2, basisLimit));
  if (filteredBasis.length < 2) {
    return {
      triggered: false,
      hits: [],
      skipReason: "residual-basis-insufficient",
    };
  }

  const queryVec = await embedText(queryText, embeddingConfig, { signal });
  if (!queryVec || queryVec.length === 0) {
    return {
      triggered: false,
      hits: [],
      skipReason: "residual-query-embedding-missing",
    };
  }

  const nmfResult = nmfQueryAnalysis(queryVec, filteredBasis.map((node) => node.embedding), {
    nTopics,
  });
  if (!Number.isFinite(nmfResult.novelty) || nmfResult.novelty < noveltyThreshold) {
    return {
      triggered: false,
      hits: [],
      nmf: nmfResult,
      skipReason: "residual-novelty-below-threshold",
    };
  }

  const sparse = sparseCodeResidual(queryVec, filteredBasis.map((node) => node.embedding));
  if (!Number.isFinite(sparse.residualNorm) || sparse.residualNorm <= residualThreshold) {
    return {
      triggered: false,
      hits: [],
      nmf: nmfResult,
      sparse,
      skipReason: "residual-norm-below-threshold",
    };
  }

  const searchableCandidates = (candidateNodes || [])
    .filter(
      (node) =>
        Array.isArray(node?.embedding) &&
        node.embedding.length > 0 &&
        !filteredBasis.some((basisNode) => basisNode.id === node.id),
    )
    .map((node) => ({
      nodeId: node.id,
      embedding: node.embedding,
    }));

  if (searchableCandidates.length === 0) {
    return {
      triggered: true,
      hits: [],
      nmf: nmfResult,
      sparse,
      skipReason: "residual-search-space-empty",
    };
  }

  const hits = searchSimilar(sparse.residual, searchableCandidates, residualTopK)
    .map((item) => ({
      ...item,
      node: getNode(graph, item.nodeId),
    }))
    .filter((item) => item.node);

  return {
    triggered: true,
    hits,
    nmf: nmfResult,
    sparse,
    skipReason: hits.length > 0 ? "" : "residual-no-hit",
  };
}

function uniqueStrings(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeCooccurrenceMap(index) {
  const normalized = new Map();
  for (const [nodeId, neighborMap] of index.entries()) {
    normalized.set(
      nodeId,
      [...neighborMap.entries()]
        .map(([neighborId, count]) => ({ nodeId: neighborId, count }))
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return String(a.nodeId).localeCompare(String(b.nodeId));
        }),
    );
  }
  return normalized;
}

function appendPairs(index, nodes, increment) {
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      addCooccurrence(index, nodes[i].id, nodes[j].id, increment);
      addCooccurrence(index, nodes[j].id, nodes[i].id, increment);
      count += 1;
    }
  }
  return count;
}

function addCooccurrence(index, fromId, toId, increment) {
  if (!index.has(fromId)) {
    index.set(fromId, new Map());
  }
  const map = index.get(fromId);
  map.set(toId, (map.get(toId) || 0) + increment);
}

function rangesOverlap(a, b) {
  return rangeOverlapSize(a, b) > 0;
}

function rangeOverlapSize(a, b) {
  const rangeA = normalizeRange(a);
  const rangeB = normalizeRange(b);
  if (!rangeA || !rangeB) return 0;
  const start = Math.max(rangeA[0], rangeB[0]);
  const end = Math.min(rangeA[1], rangeB[1]);
  return end >= start ? end - start + 1 : 0;
}

function normalizeRange(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

function compareBySeqDesc(a, b) {
  const seqA = a?.seqRange?.[1] ?? a?.seq ?? 0;
  const seqB = b?.seqRange?.[1] ?? b?.seq ?? 0;
  if (seqB !== seqA) return seqB - seqA;
  return (b.importance || 0) - (a.importance || 0);
}

function vectorAbs(vector = []) {
  return vector.map((value) => Math.abs(Number(value) || 0));
}

function normalizeVector(vector = [], useUnitNorm = true) {
  const normalized = vector.map((value) => Number(value) || 0);
  if (!useUnitNorm) return normalized;
  const norm = l2Norm(normalized);
  if (norm < 1e-10) return normalized.map(() => 0);
  return normalized.map((value) => value / norm);
}

function normalizeMatrix(vectors = []) {
  return vectors
    .filter((vector) => Array.isArray(vector) && vector.length > 0)
    .map((vector) => normalizeVector(vector));
}

function dot(a = [], b = []) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index++) {
    sum += (Number(a[index]) || 0) * (Number(b[index]) || 0);
  }
  return sum;
}

function l2Norm(vector = []) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function subtractVectors(a = [], b = []) {
  const length = Math.max(a.length, b.length);
  const result = Array(length).fill(0);
  for (let index = 0; index < length; index++) {
    result[index] = (Number(a[index]) || 0) - (Number(b[index]) || 0);
  }
  return result;
}

function matVecMul(matrix = [], vector = []) {
  return matrix.map((row) => dot(row, vector));
}

function softThreshold(vector = [], threshold = 0) {
  return vector.map((value) => {
    const absValue = Math.abs(value);
    if (absValue <= threshold) return 0;
    return Math.sign(value) * (absValue - threshold);
  });
}

function softmax(values = []) {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return exp.map((value) => value / total);
}

function nmfMultiplicativeUpdate(matrix, k, maxIter, tolerance) {
  const m = matrix.length;
  const d = matrix[0]?.length || 0;
  const mean =
    matrix.reduce((sum, row) => sum + row.reduce((acc, value) => acc + value, 0), 0) /
      Math.max(1, m * d) || 0.01;
  const avg = Math.max(Math.sqrt(mean / Math.max(1, k)), 0.01);
  const rand = createDeterministicRandom(42);
  const w = Array.from({ length: m }, () =>
    Array.from({ length: k }, () => Math.abs(avg + avg * 0.5 * (rand() - 0.5)) + 1e-6),
  );
  const h = Array.from({ length: k }, () =>
    Array.from({ length: d }, () => Math.abs(avg + avg * 0.5 * (rand() - 0.5)) + 1e-6),
  );
  const eps = 1e-10;

  for (let iteration = 0; iteration < maxIter; iteration++) {
    const wtV = Array.from({ length: k }, () => Array(d).fill(0));
    const wtW = Array.from({ length: k }, () => Array(k).fill(0));

    for (let i = 0; i < k; i++) {
      for (let dim = 0; dim < d; dim++) {
        let sum = 0;
        for (let row = 0; row < m; row++) {
          sum += w[row][i] * matrix[row][dim];
        }
        wtV[i][dim] = sum;
      }
      for (let j = 0; j < k; j++) {
        let sum = 0;
        for (let row = 0; row < m; row++) {
          sum += w[row][i] * w[row][j];
        }
        wtW[i][j] = sum;
      }
    }

    for (let i = 0; i < k; i++) {
      for (let dim = 0; dim < d; dim++) {
        let denominator = 0;
        for (let topic = 0; topic < k; topic++) {
          denominator += wtW[i][topic] * h[topic][dim];
        }
        h[i][dim] *= wtV[i][dim] / (denominator + eps);
      }
    }

    const vHt = Array.from({ length: m }, () => Array(k).fill(0));
    const hHt = Array.from({ length: k }, () => Array(k).fill(0));

    for (let row = 0; row < m; row++) {
      for (let topic = 0; topic < k; topic++) {
        let sum = 0;
        for (let dim = 0; dim < d; dim++) {
          sum += matrix[row][dim] * h[topic][dim];
        }
        vHt[row][topic] = sum;
      }
    }

    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        let sum = 0;
        for (let dim = 0; dim < d; dim++) {
          sum += h[i][dim] * h[j][dim];
        }
        hHt[i][j] = sum;
      }
    }

    for (let row = 0; row < m; row++) {
      for (let topic = 0; topic < k; topic++) {
        let denominator = 0;
        for (let inner = 0; inner < k; inner++) {
          denominator += w[row][inner] * hHt[inner][topic];
        }
        w[row][topic] *= vHt[row][topic] / (denominator + eps);
      }
    }

    if (iteration % 10 === 9) {
      let residualSq = 0;
      let matrixSq = 0;
      for (let row = 0; row < m; row++) {
        for (let dim = 0; dim < d; dim++) {
          let reconstructed = 0;
          for (let topic = 0; topic < k; topic++) {
            reconstructed += w[row][topic] * h[topic][dim];
          }
          const diff = matrix[row][dim] - reconstructed;
          residualSq += diff * diff;
          matrixSq += matrix[row][dim] * matrix[row][dim];
        }
      }

      if (matrixSq > 0 && Math.sqrt(residualSq / matrixSq) < tolerance) {
        break;
      }
    }
  }

  return { w, h };
}

function createDeterministicRandom(seed) {
  let current = seed >>> 0;
  return () => {
    current = (1664525 * current + 1013904223) >>> 0;
    return current / 0xffffffff;
  };
}
