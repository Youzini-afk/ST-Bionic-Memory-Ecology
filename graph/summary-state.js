import {
  createDefaultStoryTimeSpan,
  normalizeStoryTimeSpan,
} from "./story-timeline.js";

export const SUMMARY_STATE_VERSION = 1;
const ACTIVE_STATUS = "active";
const FOLDED_STATUS = "folded";
const SUMMARY_KINDS = new Set(["small", "rollup"]);

function summaryId() {
  return `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStringArray(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function normalizeNumberRange(range, fallback = [-1, -1]) {
  if (!Array.isArray(range) || range.length < 2) {
    return [...fallback];
  }
  const start = Number.isFinite(Number(range[0])) ? Number(range[0]) : fallback[0];
  const end = Number.isFinite(Number(range[1])) ? Number(range[1]) : fallback[1];
  return [start, end];
}

export function createDefaultSummaryState(state = {}) {
  const source =
    state && typeof state === "object" && !Array.isArray(state) ? state : {};
  return {
    version: SUMMARY_STATE_VERSION,
    enabled: source.enabled !== false,
    entries: Array.isArray(source.entries)
      ? source.entries.map((entry, index) =>
          normalizeSummaryEntry(entry, {
            fallbackId: `summary-entry-${index + 1}`,
          }),
        )
      : [],
    activeEntryIds: normalizeStringArray(source.activeEntryIds),
    lastSummarizedExtractionCount: Number.isFinite(
      Number(source.lastSummarizedExtractionCount),
    )
      ? Math.max(0, Number(source.lastSummarizedExtractionCount))
      : 0,
    lastSummarizedAssistantFloor: Number.isFinite(
      Number(source.lastSummarizedAssistantFloor),
    )
      ? Number(source.lastSummarizedAssistantFloor)
      : -1,
  };
}

export function normalizeSummaryEntry(entry = {}, options = {}) {
  const fallbackId = String(options?.fallbackId || "").trim() || summaryId();
  const source =
    entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const status = String(source.status || ACTIVE_STATUS).trim().toLowerCase();
  const kind = String(source.kind || "small").trim().toLowerCase();
  return {
    id: String(source.id || fallbackId),
    level: Number.isFinite(Number(source.level))
      ? Math.max(0, Number(source.level))
      : 0,
    kind: SUMMARY_KINDS.has(kind) ? kind : "small",
    status: status === FOLDED_STATUS ? FOLDED_STATUS : ACTIVE_STATUS,
    text: String(source.text || "").trim(),
    sourceTask: String(source.sourceTask || "synopsis").trim() || "synopsis",
    extractionRange: normalizeNumberRange(source.extractionRange),
    messageRange: normalizeNumberRange(source.messageRange),
    dialogueRange: normalizeNumberRange(source.dialogueRange),
    sourceBatchIds: normalizeStringArray(source.sourceBatchIds),
    sourceSummaryIds: normalizeStringArray(source.sourceSummaryIds),
    sourceNodeIds: normalizeStringArray(source.sourceNodeIds),
    storyTimeSpan: normalizeStoryTimeSpan(
      source.storyTimeSpan,
      createDefaultStoryTimeSpan(),
    ),
    regionHints: normalizeStringArray(source.regionHints),
    ownerHints: normalizeStringArray(source.ownerHints),
    createdAt: Number.isFinite(Number(source.createdAt))
      ? Number(source.createdAt)
      : Date.now(),
    updatedAt: Number.isFinite(Number(source.updatedAt))
      ? Number(source.updatedAt)
      : Date.now(),
  };
}

export function normalizeGraphSummaryState(graph) {
  if (!graph || typeof graph !== "object") {
    return graph;
  }
  const normalized = createDefaultSummaryState(graph.summaryState);
  const entryMap = new Map();
  for (const entry of normalized.entries) {
    if (!entry?.id) continue;
    entryMap.set(entry.id, entry);
  }
  normalized.entries = [...entryMap.values()];
  normalized.activeEntryIds = normalizeStringArray(normalized.activeEntryIds)
    .filter((entryId) => {
      const entry = entryMap.get(entryId);
      return Boolean(entry) && entry.status === ACTIVE_STATUS;
    });
  graph.summaryState = normalized;
  return graph;
}

export function getSummaryEntry(graph, entryId = "") {
  normalizeGraphSummaryState(graph);
  const normalizedEntryId = String(entryId || "").trim();
  if (!normalizedEntryId) return null;
  return (
    (Array.isArray(graph?.summaryState?.entries)
      ? graph.summaryState.entries
      : []
    ).find((entry) => entry.id === normalizedEntryId) || null
  );
}

export function getActiveSummaryEntries(graph) {
  normalizeGraphSummaryState(graph);
  const entries = Array.isArray(graph?.summaryState?.entries)
    ? graph.summaryState.entries
    : [];
  const activeIds = new Set(graph?.summaryState?.activeEntryIds || []);
  return entries
    .filter((entry) => entry.status === ACTIVE_STATUS && activeIds.has(entry.id))
    .sort(compareSummaryEntriesForDisplay);
}

export function compareSummaryEntriesForDisplay(left, right) {
  const leftMessageRange = normalizeNumberRange(left?.messageRange);
  const rightMessageRange = normalizeNumberRange(right?.messageRange);
  if (leftMessageRange[0] !== rightMessageRange[0]) {
    return leftMessageRange[0] - rightMessageRange[0];
  }
  if (leftMessageRange[1] !== rightMessageRange[1]) {
    return leftMessageRange[1] - rightMessageRange[1];
  }
  if (left?.level !== right?.level) {
    return Number(left?.level || 0) - Number(right?.level || 0);
  }
  if (left?.createdAt !== right?.createdAt) {
    return Number(left?.createdAt || 0) - Number(right?.createdAt || 0);
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

export function createSummaryEntry(data = {}) {
  return normalizeSummaryEntry(
    {
      ...data,
      id: data?.id || summaryId(),
      createdAt: data?.createdAt || Date.now(),
      updatedAt: data?.updatedAt || Date.now(),
    },
    {
      fallbackId: summaryId(),
    },
  );
}

export function appendSummaryEntry(graph, entryLike = {}) {
  normalizeGraphSummaryState(graph);
  const entry = createSummaryEntry(entryLike);
  graph.summaryState.entries.push(entry);
  if (!graph.summaryState.activeEntryIds.includes(entry.id)) {
    graph.summaryState.activeEntryIds.push(entry.id);
  }
  return entry;
}

export function markSummaryEntriesFolded(graph, entryIds = []) {
  normalizeGraphSummaryState(graph);
  const targetIds = new Set(normalizeStringArray(entryIds));
  if (targetIds.size === 0) return 0;

  let changed = 0;
  for (const entry of graph.summaryState.entries) {
    if (!targetIds.has(entry.id)) continue;
    if (entry.status !== FOLDED_STATUS) {
      entry.status = FOLDED_STATUS;
      entry.updatedAt = Date.now();
      changed += 1;
    }
  }
  graph.summaryState.activeEntryIds = graph.summaryState.activeEntryIds
    .filter((entryId) => !targetIds.has(entryId));
  return changed;
}

export function resetSummaryState(graph, state = null) {
  if (!graph || typeof graph !== "object") return graph;
  graph.summaryState = createDefaultSummaryState(state || {});
  return graph.summaryState;
}

export function getSummaryEntriesByStatus(graph, status = ACTIVE_STATUS) {
  normalizeGraphSummaryState(graph);
  const normalizedStatus = String(status || ACTIVE_STATUS).trim().toLowerCase();
  return (Array.isArray(graph?.summaryState?.entries)
    ? graph.summaryState.entries
    : []
  )
    .filter((entry) => String(entry?.status || ACTIVE_STATUS) === normalizedStatus)
    .sort(compareSummaryEntriesForDisplay);
}

