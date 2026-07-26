import assert from "node:assert/strict";

import { createEmptyGraph, createNode } from "../graph/graph.js";
import {
  applyBatchStoryTime,
  classifyStoryTemporalBucket,
  clearManualActiveStorySegment,
  deriveStoryTimeSpanFromNodes,
  resolveActiveStoryContext,
  setManualActiveStorySegment,
  upsertTimelineSegment,
} from "../graph/story-timeline.js";

const graph = createEmptyGraph();

const night = upsertTimelineSegment(
  graph,
  { label: "昨夜冲突", relation: "same", confidence: "high" },
  { source: "extract" },
);
assert.equal(night.created, true);
assert.equal(graph.timelineState.segments.length, 1);

const morningBatch = applyBatchStoryTime(
  graph,
  {
    label: "第二天清晨",
    relation: "after",
    confidence: "high",
    tense: "ongoing",
    advancesActiveTimeline: true,
  },
  "extract",
);
assert.equal(morningBatch.ok, true);
assert.equal(morningBatch.timelineAdvanceApplied, true);
assert.equal(graph.historyState.activeStoryTimeLabel, "第二天清晨");
assert.equal(graph.historyState.lastExtractedStorySegmentId, morningBatch.extractedSegmentId);

const future = upsertTimelineSegment(
  graph,
  {
    label: "明天夜里",
    relation: "after",
    confidence: "medium",
    tense: "future",
  },
  { referenceSegmentId: morningBatch.extractedSegmentId, source: "extract" },
);
assert.equal(graph.timelineState.segments.length, 3);

const currentNode = createNode({
  type: "event",
  fields: { title: "当前事件" },
  seq: 10,
});
currentNode.storyTime = {
  segmentId: morningBatch.extractedSegmentId,
  label: "第二天清晨",
  tense: "ongoing",
  relation: "same",
  anchorLabel: "",
  confidence: "high",
  source: "extract",
};
const flashbackNode = createNode({
  type: "event",
  fields: { title: "旧回忆" },
  seq: 8,
});
flashbackNode.storyTime = {
  segmentId: night.storyTime.segmentId,
  label: "昨夜冲突",
  tense: "flashback",
  relation: "before",
  anchorLabel: "",
  confidence: "high",
  source: "extract",
};
const futureNode = createNode({
  type: "event",
  fields: { title: "未来计划" },
  seq: 12,
});
futureNode.storyTime = future.storyTime;

const currentBucket = classifyStoryTemporalBucket(graph, currentNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
});
assert.equal(currentBucket.bucket, "current");
assert.equal(currentBucket.suppressed, false);

const flashbackBucket = classifyStoryTemporalBucket(graph, flashbackNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
  cueMode: "flashback",
});
assert.equal(flashbackBucket.bucket, "flashback");
assert.equal(flashbackBucket.rescued, true);

const futureBucket = classifyStoryTemporalBucket(graph, futureNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
});
assert.equal(futureBucket.bucket, "future");
assert.equal(futureBucket.suppressed, true);

const span = deriveStoryTimeSpanFromNodes(graph, [flashbackNode, currentNode], "derived");
assert.equal(span.startLabel, "昨夜冲突");
assert.equal(span.endLabel, "第二天清晨");
assert.equal(span.mixed, true);

const manualResult = setManualActiveStorySegment(graph, { label: "昨夜冲突" });
assert.equal(manualResult.ok, true);
assert.equal(resolveActiveStoryContext(graph).activeStoryTimeLabel, "昨夜冲突");

const cleared = clearManualActiveStorySegment(graph);
assert.equal(cleared.ok, true);
assert.equal(resolveActiveStoryContext(graph).activeStoryTimeLabel, "第二天清晨");

console.log("story-timeline tests passed");
