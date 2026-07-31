import { MEMORY_RECORD_KIND } from "./memory-contract.js";
import { cloneDomainValue, stableStringify } from "./memory-id.js";
import { buildMemoryLedgerIndex } from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import { fingerprintMaterializedMemoryState } from "./memory-changeset.js";

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const terms = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const expanded = new Set(terms);
  for (const term of terms) {
    if (/\p{Script=Han}/u.test(term) && Array.from(term).length > 1) {
      const characters = Array.from(term);
      for (let index = 0; index < characters.length - 1; index += 1) {
        expanded.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return [...expanded];
}

function lexicalScore(query, terms, text) {
  if (!query) return 0;
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  let score = normalized.includes(query) ? 1 : 0;
  if (terms.length > 0) {
    const matched = terms.filter((term) => normalized.includes(term)).length;
    score = Math.max(score, matched / terms.length);
  }
  return Math.max(0, Math.min(1, score));
}

function normalizeLimit(value, fallback = 20) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function parseCursor(cursor, fingerprint) {
  const normalized = String(cursor || "").trim();
  if (!normalized) return 0;
  const [cursorFingerprint, rawOffset] = normalized.split(":");
  const offset = Number(rawOffset);
  if (cursorFingerprint !== fingerprint || !Number.isInteger(offset) || offset < 0) {
    throw new Error("memory query cursor is stale or invalid");
  }
  return offset;
}

function createCursor(fingerprint, offset, total) {
  return offset < total ? `${fingerprint}:${offset}` : "";
}

function memorySearchDocument(revision) {
  return stableStringify({
    memoryId: revision.memoryId,
    memoryType: revision.memoryType,
    layer: revision.layer,
    fields: revision.fields,
    scope: revision.scope,
    storyTime: revision.storyTime,
    reason: revision.reason,
  });
}

export function createMemoryCatalogSnapshot(ledger) {
  const view = materializeMemoryLedger(ledger);
  return {
    chatId: ledger.chatId,
    ledgerRevision: ledger.revision,
    stateFingerprint: fingerprintMaterializedMemoryState(view),
    view,
    stats: {
      activeEvidence: view.evidence.activeEvidence.length,
      invalidEvidence: view.evidence.invalidEvidence.length,
      activeMemories: view.memories.active.length,
      inactiveMemories: view.memories.inactive.length,
      activeRelations: view.relations.active.length,
      inactiveRelations: view.relations.inactive.length,
      pendingInbox: view.inbox.pending.length,
    },
  };
}

export function searchMemoryCatalog(
  ledger,
  {
    query = "",
    memoryTypes = [],
    layers = [],
    ownerIds = [],
    limit = 20,
    cursor = "",
    semanticMatches = [],
  } = {},
) {
  const snapshot = createMemoryCatalogSnapshot(ledger);
  const normalizedQuery = normalizeText(query);
  const terms = queryTerms(normalizedQuery);
  const typeSet = new Set((memoryTypes || []).map((value) => String(value || "").trim()).filter(Boolean));
  const layerSet = new Set((layers || []).map((value) => String(value || "").trim()).filter(Boolean));
  const ownerSet = new Set((ownerIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const semanticByMemoryId = new Map(
    (Array.isArray(semanticMatches) ? semanticMatches : [])
      .map((match) => [String(match?.memoryId || match?.id || ""), Number(match?.score)])
      .filter(([memoryId, score]) => memoryId && Number.isFinite(score)),
  );
  const ranked = snapshot.view.memories.active
    .filter((revision) => typeSet.size === 0 || typeSet.has(revision.memoryType))
    .filter((revision) => layerSet.size === 0 || layerSet.has(revision.layer))
    .filter((revision) => {
      if (ownerSet.size === 0) return true;
      const ownerId = String(
        revision.scope?.ownerId || revision.scope?.characterId || "",
      );
      return ownerSet.has(ownerId);
    })
    .map((revision) => {
      const lexical = lexicalScore(normalizedQuery, terms, memorySearchDocument(revision));
      const semantic = Math.max(0, Math.min(1, semanticByMemoryId.get(revision.memoryId) || 0));
      const importance = Math.max(0, Math.min(1, Number(revision.importance || 0) / 10));
      const score = normalizedQuery
        ? semantic * 0.55 + lexical * 0.35 + importance * 0.1
        : importance * 0.7 + Math.min(0.3, Number(revision.ledgerRevision || 0) / Math.max(1, ledger.revision) * 0.3);
      return { revision, score, lexicalScore: lexical, semanticScore: semantic };
    })
    .filter((entry) => !normalizedQuery || entry.score > 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      const revisionDelta = Number(right.revision.ledgerRevision) - Number(left.revision.ledgerRevision);
      return revisionDelta || left.revision.memoryId.localeCompare(right.revision.memoryId, "en");
    });
  const offset = parseCursor(cursor, snapshot.stateFingerprint);
  const pageSize = normalizeLimit(limit);
  const page = ranked.slice(offset, offset + pageSize);
  return {
    chatId: ledger.chatId,
    ledgerRevision: ledger.revision,
    stateFingerprint: snapshot.stateFingerprint,
    total: ranked.length,
    nextCursor: createCursor(snapshot.stateFingerprint, offset + page.length, ranked.length),
    items: page.map((entry) => ({
      memoryId: entry.revision.memoryId,
      revisionId: entry.revision.id,
      memoryType: entry.revision.memoryType,
      layer: entry.revision.layer,
      status: entry.revision.status,
      fields: cloneDomainValue(entry.revision.fields, {}),
      scope: cloneDomainValue(entry.revision.scope, {}),
      storyTime: cloneDomainValue(entry.revision.storyTime, {}),
      evidenceIds: [...(entry.revision.evidenceIds || [])],
      dependencyRevisionIds: [...(entry.revision.dependencyRevisionIds || [])],
      importance: entry.revision.importance,
      confidence: entry.revision.confidence,
      score: Number(entry.score.toFixed(6)),
      lexicalScore: Number(entry.lexicalScore.toFixed(6)),
      semanticScore: Number(entry.semanticScore.toFixed(6)),
    })),
  };
}

export function inspectMemoryRecords(
  ledger,
  { memoryIds = [], includeHistory = true, includeEvidence = false } = {},
) {
  const requested = new Set((memoryIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const index = buildMemoryLedgerIndex(ledger);
  const snapshot = createMemoryCatalogSnapshot(ledger);
  const revisions = index.recordsByKind.get(MEMORY_RECORD_KIND.MEMORY_REVISION) || [];
  const selected = revisions.filter((revision) => requested.has(revision.memoryId));
  const evidenceIds = new Set(selected.flatMap((revision) => revision.evidenceIds || []));
  return {
    chatId: ledger.chatId,
    ledgerRevision: ledger.revision,
    stateFingerprint: snapshot.stateFingerprint,
    memories: [...requested].map((memoryId) => {
      const history = selected
        .filter((revision) => revision.memoryId === memoryId)
        .sort((left, right) => Number(left.ledgerRevision) - Number(right.ledgerRevision));
      const head = snapshot.view.memories.heads.get(memoryId) || null;
      return {
        memoryId,
        head: head ? cloneDomainValue(head, head) : null,
        history: includeHistory ? cloneDomainValue(history, []) : [],
      };
    }),
    evidence: includeEvidence
      ? [...evidenceIds]
          .map((evidenceId) => index.recordsById.get(evidenceId))
          .filter((record) => record?.kind === MEMORY_RECORD_KIND.EVIDENCE)
          .map((record) => cloneDomainValue(record, record))
      : [],
  };
}

export function inspectMemoryNeighbors(
  ledger,
  { memoryId, direction = "both", relations = [] } = {},
) {
  const snapshot = createMemoryCatalogSnapshot(ledger);
  const relationSet = new Set((relations || []).map((value) => String(value || "").trim()).filter(Boolean));
  const normalizedDirection = ["in", "out", "both"].includes(direction) ? direction : "both";
  const edges = snapshot.view.relations.active.filter((revision) => {
    if (relationSet.size > 0 && !relationSet.has(revision.relation)) return false;
    return (
      (normalizedDirection !== "in" && revision.fromMemoryId === memoryId) ||
      (normalizedDirection !== "out" && revision.toMemoryId === memoryId)
    );
  });
  const neighborIds = new Set(
    edges.map((edge) =>
      edge.fromMemoryId === memoryId ? edge.toMemoryId : edge.fromMemoryId,
    ),
  );
  return {
    chatId: ledger.chatId,
    ledgerRevision: ledger.revision,
    stateFingerprint: snapshot.stateFingerprint,
    relations: cloneDomainValue(edges, []),
    neighbors: [...neighborIds]
      .map((id) => snapshot.view.memories.heads.get(id))
      .filter(Boolean)
      .map((revision) => cloneDomainValue(revision, revision)),
  };
}
