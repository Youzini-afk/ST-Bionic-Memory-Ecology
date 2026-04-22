const STORY_TENSE_VALUES = new Set([
  "past",
  "ongoing",
  "future",
  "flashback",
  "hypothetical",
  "unknown",
]);

const STORY_RELATION_VALUES = new Set([
  "same",
  "after",
  "before",
  "parallel",
  "unknown",
]);

const STORY_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const STORY_SOURCE_VALUES = new Set(["extract", "derived", "manual"]);

export const STORY_TIMELINE_VERSION = 1;
export const STORY_TEMPORAL_BUCKETS = Object.freeze({
  CURRENT: "current",
  ADJACENT_PAST: "adjacentPast",
  DISTANT_PAST: "distantPast",
  FLASHBACK: "flashback",
  FUTURE: "future",
  UNDATED: "undated",
});

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalizeString(value)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeString(value);
    const key = normalizeKey(normalized);
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function buildMatcherKey(label = "", anchorLabel = "", relation = "unknown") {
  return [normalizeKey(label), normalizeKey(anchorLabel), normalizeString(relation)]
    .filter(Boolean)
    .join("::");
}

function buildStorySegmentId() {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) return `tl-${native}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `tl-${Date.now().toString(36)}-${suffix}`;
}

export function createDefaultStoryTime(overrides = {}) {
  return {
    segmentId: normalizeString(overrides.segmentId),
    label: normalizeString(overrides.label),
    tense: normalizeEnum(overrides.tense, STORY_TENSE_VALUES, "unknown"),
    relation: normalizeEnum(
      overrides.relation,
      STORY_RELATION_VALUES,
      "unknown",
    ),
    anchorLabel: normalizeString(overrides.anchorLabel),
    confidence: normalizeEnum(
      overrides.confidence,
      STORY_CONFIDENCE_VALUES,
      "medium",
    ),
    source: normalizeEnum(overrides.source, STORY_SOURCE_VALUES, "derived"),
  };
}

export function createDefaultStoryTimeSpan(overrides = {}) {
  return {
    startSegmentId: normalizeString(overrides.startSegmentId),
    endSegmentId: normalizeString(overrides.endSegmentId),
    startLabel: normalizeString(overrides.startLabel),
    endLabel: normalizeString(overrides.endLabel),
    mixed: overrides.mixed === true,
    source: normalizeEnum(overrides.source, STORY_SOURCE_VALUES, "derived"),
  };
}

export function createDefaultTimelineSegment(overrides = {}) {
  const label = normalizeString(overrides.label);
  const anchorLabel = normalizeString(overrides.anchorLabel);
  const relationToParent = normalizeEnum(
    overrides.relationToParent,
    STORY_RELATION_VALUES,
    "unknown",
  );
  return {
    id: normalizeString(overrides.id) || buildStorySegmentId(),
    label,
    normalizedKey: normalizeKey(overrides.normalizedKey || label),
    matcherKey:
      normalizeString(overrides.matcherKey) ||
      buildMatcherKey(label, anchorLabel, relationToParent),
    order: Number.isFinite(Number(overrides.order))
      ? Math.max(1, Math.trunc(Number(overrides.order)))
      : 1,
    aliases: uniqueStrings(overrides.aliases),
    parentId: normalizeString(overrides.parentId),
    relationToParent,
    anchorLabel,
    confidence: normalizeEnum(
      overrides.confidence,
      STORY_CONFIDENCE_VALUES,
      "medium",
    ),
    source: normalizeEnum(overrides.source, STORY_SOURCE_VALUES, "derived"),
    updatedAt: Number.isFinite(Number(overrides.updatedAt))
      ? Number(overrides.updatedAt)
      : 0,
  };
}

export function createDefaultTimelineState(overrides = {}) {
  return {
    version: STORY_TIMELINE_VERSION,
    segments: Array.isArray(overrides.segments) ? overrides.segments : [],
    nextOrder: Number.isFinite(Number(overrides.nextOrder))
      ? Math.max(1, Math.trunc(Number(overrides.nextOrder)))
      : 1,
    manualActiveSegmentId: normalizeString(overrides.manualActiveSegmentId),
    lastExtractedSegmentId: normalizeString(overrides.lastExtractedSegmentId),
    recentSegmentIds: uniqueStrings(overrides.recentSegmentIds).slice(0, 12),
  };
}

function canReuseNormalizedStoryTime(value = {}, defaults = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (defaults && typeof defaults === "object" && Object.keys(defaults).length > 0)
  ) {
    return false;
  }
  return (
    normalizeString(value.segmentId || "") === String(value.segmentId || "") &&
    normalizeString(value.label || "") === String(value.label || "") &&
    normalizeEnum(value.tense, STORY_TENSE_VALUES, "unknown") === value.tense &&
    normalizeEnum(value.relation, STORY_RELATION_VALUES, "unknown") === value.relation &&
    normalizeString(value.anchorLabel || "") === String(value.anchorLabel || "") &&
    normalizeEnum(value.confidence, STORY_CONFIDENCE_VALUES, "medium") ===
      value.confidence &&
    normalizeEnum(value.source, STORY_SOURCE_VALUES, "derived") === value.source
  );
}

function canReuseNormalizedStoryTimeSpan(value = {}, defaults = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (defaults && typeof defaults === "object" && Object.keys(defaults).length > 0)
  ) {
    return false;
  }
  return (
    normalizeString(value.startSegmentId || "") === String(value.startSegmentId || "") &&
    normalizeString(value.endSegmentId || "") === String(value.endSegmentId || "") &&
    normalizeString(value.startLabel || "") === String(value.startLabel || "") &&
    normalizeString(value.endLabel || "") === String(value.endLabel || "") &&
    (value.mixed === true || value.mixed === false) &&
    normalizeEnum(value.source, STORY_SOURCE_VALUES, "derived") === value.source
  );
}

export function normalizeStoryTime(value = {}, defaults = {}) {
  if (canReuseNormalizedStoryTime(value, defaults)) {
    return value;
  }
  return createDefaultStoryTime({
    ...defaults,
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  });
}

export function normalizeStoryTimeSpan(value = {}, defaults = {}) {
  if (canReuseNormalizedStoryTimeSpan(value, defaults)) {
    return value;
  }
  return createDefaultStoryTimeSpan({
    ...defaults,
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  });
}

export function normalizeTimelineState(state = {}) {
  const normalized = createDefaultTimelineState(state);
  const segments = [];
  const seenIds = new Set();
  for (const rawSegment of Array.isArray(normalized.segments)
    ? normalized.segments
    : []) {
    const segment = createDefaultTimelineSegment(rawSegment);
    if (!segment.label || seenIds.has(segment.id)) continue;
    seenIds.add(segment.id);
    segments.push(segment);
  }
  segments.sort((left, right) => {
    if ((left.order || 0) !== (right.order || 0)) {
      return (left.order || 0) - (right.order || 0);
    }
    return String(left.updatedAt || 0).localeCompare(String(right.updatedAt || 0));
  });
  const nextOrder = Math.max(
    normalized.nextOrder || 1,
    segments.reduce((max, segment) => Math.max(max, Number(segment.order) || 0), 0) +
      1,
  );
  return {
    version: STORY_TIMELINE_VERSION,
    segments,
    nextOrder,
    manualActiveSegmentId: normalized.manualActiveSegmentId,
    lastExtractedSegmentId: normalized.lastExtractedSegmentId,
    recentSegmentIds: uniqueStrings(normalized.recentSegmentIds)
      .filter((segmentId) => segments.some((segment) => segment.id === segmentId))
      .slice(0, 12),
  };
}

export function normalizeNodeStoryTimeline(node, defaults = {}) {
  if (!node || typeof node !== "object") return node;
  node.storyTime = normalizeStoryTime(node.storyTime, defaults.storyTime || {});
  node.storyTimeSpan = normalizeStoryTimeSpan(
    node.storyTimeSpan,
    defaults.storyTimeSpan || {},
  );
  return node;
}

export function normalizeGraphStoryTimeline(graph) {
  if (!graph || typeof graph !== "object") return graph;
  graph.timelineState = normalizeTimelineState(graph.timelineState);
  if (Array.isArray(graph.nodes)) {
    graph.nodes.forEach((node) => normalizeNodeStoryTimeline(node));
  }
  return graph;
}

function pushRecentSegment(timelineState, segmentId = "") {
  const normalizedSegmentId = normalizeString(segmentId);
  if (!normalizedSegmentId) return;
  timelineState.recentSegmentIds = [
    normalizedSegmentId,
    ...timelineState.recentSegmentIds.filter((value) => value !== normalizedSegmentId),
  ].slice(0, 12);
}

function getTimelineState(graphOrState) {
  return graphOrState?.timelineState && typeof graphOrState.timelineState === "object"
    ? graphOrState.timelineState
    : graphOrState;
}

export function getTimelineSegmentById(graphOrState, segmentId = "") {
  const timelineState = getTimelineState(graphOrState);
  const normalizedSegmentId = normalizeString(segmentId);
  if (!normalizedSegmentId) return null;
  return (
    (Array.isArray(timelineState?.segments) ? timelineState.segments : []).find(
      (segment) => segment.id === normalizedSegmentId,
    ) || null
  );
}

export function findTimelineSegmentByLabel(graphOrState, label = "") {
  const timelineState = getTimelineState(graphOrState);
  const normalizedLabelKey = normalizeKey(label);
  if (!normalizedLabelKey) return null;
  return (
    (Array.isArray(timelineState?.segments) ? timelineState.segments : []).find(
      (segment) =>
        segment.normalizedKey === normalizedLabelKey ||
        (Array.isArray(segment.aliases) &&
          segment.aliases.some((alias) => normalizeKey(alias) === normalizedLabelKey)),
    ) || null
  );
}

function getTimelineSegmentOrder(graphOrState, segmentId = "") {
  return Number(getTimelineSegmentById(graphOrState, segmentId)?.order || 0) || null;
}

function shiftSegmentOrders(timelineState, minOrder, delta = 1) {
  for (const segment of timelineState.segments || []) {
    if ((Number(segment.order) || 0) >= minOrder) {
      segment.order = Math.max(1, (Number(segment.order) || 1) + delta);
    }
  }
}

function createStoryTimeMatcher(storyTime = {}) {
  return buildMatcherKey(
    storyTime.label,
    storyTime.anchorLabel,
    storyTime.relation || "unknown",
  );
}

export function resolveTimelineSegment(graphOrState, storyTime = {}) {
  const timelineState = getTimelineState(graphOrState);
  const normalizedStoryTime = normalizeStoryTime(storyTime);
  if (!normalizedStoryTime.segmentId && !normalizedStoryTime.label) {
    return null;
  }

  if (normalizedStoryTime.segmentId) {
    const byId = getTimelineSegmentById(timelineState, normalizedStoryTime.segmentId);
    if (byId) return byId;
  }

  const matcherKey = createStoryTimeMatcher(normalizedStoryTime);
  const segments = Array.isArray(timelineState?.segments) ? timelineState.segments : [];
  if (matcherKey) {
    const byMatcher = segments.find((segment) => segment.matcherKey === matcherKey);
    if (byMatcher) return byMatcher;
  }

  return findTimelineSegmentByLabel(timelineState, normalizedStoryTime.label);
}

export function upsertTimelineSegment(
  graph,
  storyTime = {},
  { referenceSegmentId = "", source = "extract" } = {},
) {
  if (!graph || typeof graph !== "object") {
    return {
      segment: null,
      storyTime: createDefaultStoryTime(storyTime),
      created: false,
      reused: false,
    };
  }

  graph.timelineState = normalizeTimelineState(graph.timelineState);
  const timelineState = graph.timelineState;
  const normalizedStoryTime = normalizeStoryTime(storyTime, { source });
  if (!normalizedStoryTime.label && !normalizedStoryTime.segmentId) {
    return {
      segment: null,
      storyTime: normalizedStoryTime,
      created: false,
      reused: false,
    };
  }

  const existing = resolveTimelineSegment(timelineState, normalizedStoryTime);
  if (existing) {
    if (normalizedStoryTime.label && existing.label !== normalizedStoryTime.label) {
      existing.aliases = uniqueStrings([
        ...(existing.aliases || []),
        normalizedStoryTime.label,
      ]);
    }
    existing.updatedAt = Date.now();
    pushRecentSegment(timelineState, existing.id);
    return {
      segment: existing,
      storyTime: normalizeStoryTime({
        ...normalizedStoryTime,
        segmentId: existing.id,
        label: existing.label || normalizedStoryTime.label,
      }),
      created: false,
      reused: true,
    };
  }

  const referenceSegment = getTimelineSegmentById(timelineState, referenceSegmentId);
  const relation = normalizedStoryTime.relation || "unknown";
  let desiredOrder = Number(timelineState.nextOrder || 1) || 1;

  if (referenceSegment) {
    if (relation === "same" || relation === "parallel") {
      desiredOrder = Number(referenceSegment.order || desiredOrder) || desiredOrder;
    } else if (relation === "after") {
      desiredOrder = (Number(referenceSegment.order || 0) || 0) + 1;
      shiftSegmentOrders(timelineState, desiredOrder, 1);
    } else if (relation === "before") {
      desiredOrder = Math.max(1, Number(referenceSegment.order || 1) || 1);
      shiftSegmentOrders(timelineState, desiredOrder, 1);
    }
  }

  const createdSegment = createDefaultTimelineSegment({
    label: normalizedStoryTime.label || normalizedStoryTime.anchorLabel || "未命名时间段",
    order: desiredOrder,
    aliases: [normalizedStoryTime.label],
    parentId:
      relation === "after" ||
      relation === "before" ||
      relation === "same" ||
      relation === "parallel"
        ? normalizeString(referenceSegment?.id)
        : "",
    relationToParent: relation,
    anchorLabel: normalizedStoryTime.anchorLabel,
    confidence: normalizedStoryTime.confidence,
    source,
    updatedAt: Date.now(),
  });

  timelineState.segments.push(createdSegment);
  timelineState.segments.sort((left, right) => (left.order || 0) - (right.order || 0));
  timelineState.nextOrder = Math.max(
    Number(timelineState.nextOrder || 1),
    ...timelineState.segments.map((segment) => Number(segment.order || 0) + 1),
  );
  pushRecentSegment(timelineState, createdSegment.id);
  return {
    segment: createdSegment,
    storyTime: normalizeStoryTime({
      ...normalizedStoryTime,
      segmentId: createdSegment.id,
      label: createdSegment.label,
      source,
    }),
    created: true,
    reused: false,
  };
}

export function createSpanFromStoryTime(storyTime = {}, source = "derived") {
  const normalizedStoryTime = normalizeStoryTime(storyTime, { source });
  if (!normalizedStoryTime.segmentId && !normalizedStoryTime.label) {
    return createDefaultStoryTimeSpan({ source });
  }
  return createDefaultStoryTimeSpan({
    startSegmentId: normalizedStoryTime.segmentId,
    endSegmentId: normalizedStoryTime.segmentId,
    startLabel: normalizedStoryTime.label,
    endLabel: normalizedStoryTime.label,
    mixed: false,
    source,
  });
}

export function deriveStoryTimeSpanFromNodes(graph, nodes = [], source = "derived") {
  const safeNodes = (Array.isArray(nodes) ? nodes : []).filter(Boolean);
  if (safeNodes.length === 0) {
    return createDefaultStoryTimeSpan({ source });
  }

  const points = [];
  for (const node of safeNodes) {
    const storyTime = normalizeStoryTime(node?.storyTime);
    const storyTimeSpan = normalizeStoryTimeSpan(node?.storyTimeSpan);
    if (storyTime.segmentId || storyTime.label) {
      points.push({
        type: "point",
        segmentId: storyTime.segmentId,
        label: storyTime.label,
        order: getTimelineSegmentOrder(graph, storyTime.segmentId),
        seq: Number(node?.seq ?? 0) || 0,
      });
    }
    if (storyTimeSpan.startSegmentId || storyTimeSpan.startLabel) {
      points.push({
        type: "span-start",
        segmentId: storyTimeSpan.startSegmentId,
        label: storyTimeSpan.startLabel,
        order: getTimelineSegmentOrder(graph, storyTimeSpan.startSegmentId),
        seq: Number(node?.seq ?? 0) || 0,
      });
    }
    if (storyTimeSpan.endSegmentId || storyTimeSpan.endLabel) {
      points.push({
        type: "span-end",
        segmentId: storyTimeSpan.endSegmentId,
        label: storyTimeSpan.endLabel,
        order: getTimelineSegmentOrder(graph, storyTimeSpan.endSegmentId),
        seq: Number(node?.seq ?? 0) || 0,
      });
    }
  }

  if (points.length === 0) {
    return createDefaultStoryTimeSpan({ source });
  }

  points.sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(right.order)
      ? right.order
      : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (left.seq || 0) - (right.seq || 0);
  });

  const first = points[0];
  const last = points[points.length - 1];
  const uniqueLabels = new Set(points.map((point) => normalizeKey(point.label)).filter(Boolean));
  const uniqueSegments = new Set(
    points.map((point) => normalizeString(point.segmentId)).filter(Boolean),
  );

  return createDefaultStoryTimeSpan({
    startSegmentId: first.segmentId,
    endSegmentId: last.segmentId,
    startLabel: first.label,
    endLabel: last.label,
    mixed: uniqueLabels.size > 1 || uniqueSegments.size > 1,
    source,
  });
}

function resolveSegmentFromHistory(graph) {
  const historyState = graph?.historyState || {};
  const activeSegmentId = normalizeString(historyState.activeStorySegmentId);
  if (activeSegmentId) {
    const byId = getTimelineSegmentById(graph, activeSegmentId);
    if (byId) return { segment: byId, source: normalizeString(historyState.activeStoryTimeSource) || "history" };
  }
  const activeLabel = normalizeString(historyState.activeStoryTimeLabel);
  if (activeLabel) {
    const byLabel = findTimelineSegmentByLabel(graph, activeLabel);
    if (byLabel) return { segment: byLabel, source: normalizeString(historyState.activeStoryTimeSource) || "history" };
  }
  const extractedSegmentId = normalizeString(historyState.lastExtractedStorySegmentId);
  if (extractedSegmentId) {
    const byExtracted = getTimelineSegmentById(graph, extractedSegmentId);
    if (byExtracted) return { segment: byExtracted, source: "extract" };
  }
  return null;
}

export function resolveActiveStoryContext(graph, preferred = {}) {
  const timelineState = normalizeTimelineState(graph?.timelineState);
  const preferredSegmentId = normalizeString(preferred.segmentId);
  const preferredLabel = normalizeString(preferred.label);
  if (timelineState.manualActiveSegmentId) {
    const manualSegment = getTimelineSegmentById(timelineState, timelineState.manualActiveSegmentId);
    if (manualSegment) {
      return {
        activeSegmentId: manualSegment.id,
        activeStoryTimeLabel: manualSegment.label,
        source: "manual",
        segment: manualSegment,
        resolved: true,
      };
    }
  }
  if (preferredSegmentId) {
    const preferredSegment = getTimelineSegmentById(timelineState, preferredSegmentId);
    if (preferredSegment) {
      return {
        activeSegmentId: preferredSegment.id,
        activeStoryTimeLabel: preferredSegment.label,
        source: "runtime",
        segment: preferredSegment,
        resolved: true,
      };
    }
  }
  if (preferredLabel) {
    const preferredSegment = findTimelineSegmentByLabel(timelineState, preferredLabel);
    if (preferredSegment) {
      return {
        activeSegmentId: preferredSegment.id,
        activeStoryTimeLabel: preferredSegment.label,
        source: "runtime",
        segment: preferredSegment,
        resolved: true,
      };
    }
  }
  const historyMatch = resolveSegmentFromHistory(graph);
  if (historyMatch?.segment) {
    return {
      activeSegmentId: historyMatch.segment.id,
      activeStoryTimeLabel: historyMatch.segment.label,
      source: historyMatch.source,
      segment: historyMatch.segment,
      resolved: true,
    };
  }
  const recentSegmentId = timelineState.recentSegmentIds.find((segmentId) =>
    Boolean(getTimelineSegmentById(timelineState, segmentId)),
  );
  if (recentSegmentId) {
    const recentSegment = getTimelineSegmentById(timelineState, recentSegmentId);
    return {
      activeSegmentId: recentSegment.id,
      activeStoryTimeLabel: recentSegment.label,
      source: "recent",
      segment: recentSegment,
      resolved: true,
    };
  }
  return {
    activeSegmentId: "",
    activeStoryTimeLabel: "",
    source: "",
    segment: null,
    resolved: false,
  };
}

export function applyBatchStoryTime(graph, batchStoryTime = {}, source = "extract") {
  if (!graph || typeof graph !== "object") {
    return {
      ok: false,
      activeSegmentId: "",
      activeStoryTimeLabel: "",
      timelineAdvanceApplied: false,
      extractedSegmentId: "",
    };
  }

  graph.timelineState = normalizeTimelineState(graph.timelineState);
  graph.historyState ||= {};
  const normalizedBatch = normalizeStoryTime(batchStoryTime, { source });
  if (!normalizedBatch.label && !normalizedBatch.segmentId) {
    return {
      ok: false,
      activeSegmentId: normalizeString(graph.historyState.activeStorySegmentId),
      activeStoryTimeLabel: normalizeString(graph.historyState.activeStoryTimeLabel),
      timelineAdvanceApplied: false,
      extractedSegmentId: "",
    };
  }

  const activeContext = resolveActiveStoryContext(graph);
  const upserted = upsertTimelineSegment(graph, normalizedBatch, {
    referenceSegmentId: activeContext.activeSegmentId,
    source,
  });
  const storyTime = upserted.storyTime;
  const shouldAdvance =
    batchStoryTime?.advancesActiveTimeline === true &&
    !["future", "hypothetical", "flashback"].includes(storyTime.tense);

  graph.timelineState.lastExtractedSegmentId = storyTime.segmentId || "";
  pushRecentSegment(graph.timelineState, storyTime.segmentId);
  graph.historyState.lastExtractedStorySegmentId = storyTime.segmentId || "";

  if (shouldAdvance) {
    graph.historyState.activeStorySegmentId = storyTime.segmentId || "";
    graph.historyState.activeStoryTimeLabel = storyTime.label || "";
    graph.historyState.activeStoryTimeSource = source;
  } else if (
    !normalizeString(graph.historyState.activeStorySegmentId) &&
    storyTime.segmentId
  ) {
    graph.historyState.activeStorySegmentId = storyTime.segmentId;
    graph.historyState.activeStoryTimeLabel = storyTime.label || "";
    graph.historyState.activeStoryTimeSource = source;
  }

  return {
    ok: true,
    activeSegmentId: normalizeString(graph.historyState.activeStorySegmentId),
    activeStoryTimeLabel: normalizeString(graph.historyState.activeStoryTimeLabel),
    timelineAdvanceApplied: shouldAdvance,
    extractedSegmentId: storyTime.segmentId || "",
    storyTime,
  };
}

export function isStoryTimeCompatible(leftNode, rightNode) {
  const leftStoryTime = normalizeStoryTime(leftNode?.storyTime);
  const rightStoryTime = normalizeStoryTime(rightNode?.storyTime);
  const leftSpan = normalizeStoryTimeSpan(leftNode?.storyTimeSpan);
  const rightSpan = normalizeStoryTimeSpan(rightNode?.storyTimeSpan);

  const leftIds = [
    leftStoryTime.segmentId,
    leftSpan.startSegmentId,
    leftSpan.endSegmentId,
  ].filter(Boolean);
  const rightIds = [
    rightStoryTime.segmentId,
    rightSpan.startSegmentId,
    rightSpan.endSegmentId,
  ].filter(Boolean);

  if (leftIds.length === 0 || rightIds.length === 0) {
    return { compatible: true, reason: "undated" };
  }
  const overlaps = leftIds.some((segmentId) => rightIds.includes(segmentId));
  if (overlaps) {
    return { compatible: true, reason: "overlap" };
  }
  return { compatible: false, reason: "different-story-segment" };
}

export function describeStoryTime(storyTime = {}) {
  const normalized = normalizeStoryTime(storyTime);
  if (!normalized.label) return "";
  const parts = [normalized.label];
  if (normalized.tense && normalized.tense !== "unknown") {
    parts.push(normalized.tense);
  }
  return parts.join(" · ");
}

export function describeStoryTimeSpan(storyTimeSpan = {}) {
  const normalized = normalizeStoryTimeSpan(storyTimeSpan);
  if (!normalized.startLabel && !normalized.endLabel) return "";
  if (
    normalized.startLabel &&
    normalized.endLabel &&
    normalized.startLabel !== normalized.endLabel
  ) {
    return `${normalized.startLabel} -> ${normalized.endLabel}`;
  }
  return normalized.startLabel || normalized.endLabel || "";
}

export function describeNodeStoryTime(node = {}) {
  return (
    describeStoryTime(node.storyTime) ||
    describeStoryTimeSpan(node.storyTimeSpan) ||
    ""
  );
}

export function resolveStoryCueMode(userMessage = "", recentMessages = []) {
  const text = [userMessage, ...(Array.isArray(recentMessages) ? recentMessages : [])]
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join("\n");
  if (!text) return "";
  if (/(曾经|以前|当年|从前|回忆|过去|背景|来历|小时候|往事)/i.test(text)) {
    return "flashback";
  }
  if (/(未来|以后|之后会|将要|明天|预告|计划|打算|准备|承诺)/i.test(text)) {
    return "future";
  }
  return "";
}

export function classifyStoryTemporalBucket(
  graph,
  node,
  { activeSegmentId = "", cueMode = "" } = {},
) {
  const storyTime = normalizeStoryTime(node?.storyTime);
  const storyTimeSpan = normalizeStoryTimeSpan(node?.storyTimeSpan);
  const activeOrder = getTimelineSegmentOrder(graph, activeSegmentId);
  const pointOrder = getTimelineSegmentOrder(graph, storyTime.segmentId);
  const spanStartOrder = getTimelineSegmentOrder(graph, storyTimeSpan.startSegmentId);
  const spanEndOrder = getTimelineSegmentOrder(graph, storyTimeSpan.endSegmentId);
  const hasStoryTime = Boolean(
    storyTime.segmentId ||
      storyTime.label ||
      storyTimeSpan.startSegmentId ||
      storyTimeSpan.startLabel ||
      storyTimeSpan.endSegmentId ||
      storyTimeSpan.endLabel,
  );

  if (!hasStoryTime) {
    return {
      bucket: STORY_TEMPORAL_BUCKETS.UNDATED,
      weight: 0.88,
      suppressed: false,
      rescued: false,
      reason: "undated",
    };
  }

  if (storyTime.tense === "future" || storyTime.tense === "hypothetical") {
    const allowFutureCue = cueMode === "future";
    return {
      bucket: STORY_TEMPORAL_BUCKETS.FUTURE,
      weight: allowFutureCue ? 0.72 : 0.2,
      suppressed: !allowFutureCue,
      rescued: false,
      reason: allowFutureCue ? "future-cue" : "future-suppressed",
    };
  }

  if (!Number.isFinite(activeOrder)) {
    return {
      bucket: STORY_TEMPORAL_BUCKETS.UNDATED,
      weight: 0.92,
      suppressed: false,
      rescued: false,
      reason: "no-active-story-time",
    };
  }

  const effectiveStart = Number.isFinite(spanStartOrder) ? spanStartOrder : pointOrder;
  const effectiveEnd = Number.isFinite(spanEndOrder) ? spanEndOrder : pointOrder;

  if (Number.isFinite(effectiveStart) && Number.isFinite(effectiveEnd)) {
    if (activeOrder >= effectiveStart && activeOrder <= effectiveEnd) {
      return {
        bucket: STORY_TEMPORAL_BUCKETS.CURRENT,
        weight: 1.15,
        suppressed: false,
        rescued: false,
        reason: "span-current",
      };
    }
    if (effectiveEnd < activeOrder) {
      const distance = activeOrder - effectiveEnd;
      if (storyTime.tense === "flashback" || cueMode === "flashback") {
        return {
          bucket: STORY_TEMPORAL_BUCKETS.FLASHBACK,
          weight: cueMode === "flashback" ? 1.02 : 0.72,
          suppressed: false,
          rescued: cueMode === "flashback",
          reason: cueMode === "flashback" ? "flashback-rescued" : "flashback",
        };
      }
      return {
        bucket:
          distance <= 2
            ? STORY_TEMPORAL_BUCKETS.ADJACENT_PAST
            : STORY_TEMPORAL_BUCKETS.DISTANT_PAST,
        weight: distance <= 2 ? 1.0 : 0.64,
        suppressed: false,
        rescued: false,
        reason: distance <= 2 ? "adjacent-past" : "distant-past",
      };
    }
    if (effectiveStart > activeOrder) {
      const allowFutureCue = cueMode === "future";
      return {
        bucket: STORY_TEMPORAL_BUCKETS.FUTURE,
        weight: allowFutureCue ? 0.74 : 0.22,
        suppressed: !allowFutureCue,
        rescued: false,
        reason: allowFutureCue ? "future-cue" : "future-suppressed",
      };
    }
  }

  return {
    bucket: STORY_TEMPORAL_BUCKETS.UNDATED,
    weight: 0.9,
    suppressed: false,
    rescued: false,
    reason: "temporal-unknown",
  };
}

export function setManualActiveStorySegment(
  graph,
  { segmentId = "", label = "" } = {},
) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, reason: "missing-graph", activeStorySegmentId: "", activeStoryTimeLabel: "" };
  }
  graph.timelineState = normalizeTimelineState(graph.timelineState);
  graph.historyState ||= {};

  let segment = null;
  if (segmentId) {
    segment = getTimelineSegmentById(graph, segmentId);
  }
  if (!segment && label) {
    segment = findTimelineSegmentByLabel(graph, label);
  }
  if (!segment && label) {
    const upserted = upsertTimelineSegment(
      graph,
      { label, relation: "same", confidence: "low", source: "manual" },
      { source: "manual" },
    );
    segment = upserted.segment;
  }

  graph.timelineState.manualActiveSegmentId = segment?.id || "";
  graph.historyState.activeStorySegmentId = segment?.id || "";
  graph.historyState.activeStoryTimeLabel = segment?.label || "";
  graph.historyState.activeStoryTimeSource = segment ? "manual" : "";
  if (segment?.id) {
    pushRecentSegment(graph.timelineState, segment.id);
  }

  return {
    ok: true,
    activeStorySegmentId: graph.historyState.activeStorySegmentId || "",
    activeStoryTimeLabel: graph.historyState.activeStoryTimeLabel || "",
  };
}

export function clearManualActiveStorySegment(graph) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, reason: "missing-graph" };
  }
  graph.timelineState = normalizeTimelineState(graph.timelineState);
  graph.historyState ||= {};
  graph.timelineState.manualActiveSegmentId = "";
  const fallback = resolveSegmentFromHistory({
    ...graph,
    historyState: {
      ...(graph.historyState || {}),
      activeStorySegmentId: "",
      activeStoryTimeLabel: "",
      activeStoryTimeSource: "",
    },
  });
  graph.historyState.activeStorySegmentId = fallback?.segment?.id || "";
  graph.historyState.activeStoryTimeLabel = fallback?.segment?.label || "";
  graph.historyState.activeStoryTimeSource = fallback?.source || "";
  return {
    ok: true,
    activeStorySegmentId: graph.historyState.activeStorySegmentId || "",
    activeStoryTimeLabel: graph.historyState.activeStoryTimeLabel || "",
  };
}

export function setNodeStoryTimeManual(graph, nodeId = "", storyTime = {}) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, reason: "missing-graph" };
  }
  const node = Array.isArray(graph.nodes)
    ? graph.nodes.find((candidate) => candidate?.id === normalizeString(nodeId))
    : null;
  if (!node) {
    return { ok: false, reason: "node-not-found" };
  }

  const normalizedStoryTime = normalizeStoryTime(storyTime, {
    source: "manual",
    confidence: "medium",
  });
  if (!normalizedStoryTime.label && !normalizedStoryTime.segmentId) {
    node.storyTime = createDefaultStoryTime();
    node.storyTimeSpan = createDefaultStoryTimeSpan();
    return { ok: true, nodeId: node.id, storyTime: node.storyTime };
  }

  const activeSegmentId = normalizeString(graph?.historyState?.activeStorySegmentId);
  const upserted = upsertTimelineSegment(graph, normalizedStoryTime, {
    referenceSegmentId: activeSegmentId,
    source: "manual",
  });
  node.storyTime = upserted.storyTime;
  node.storyTimeSpan = createDefaultStoryTimeSpan();
  return { ok: true, nodeId: node.id, storyTime: node.storyTime };
}
