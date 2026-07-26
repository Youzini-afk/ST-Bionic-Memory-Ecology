import assert from "node:assert/strict";
import { formatInjection } from "../retrieval/injector.js";
import { DEFAULT_NODE_SCHEMA } from "../graph/schema.js";

const coreEvent = {
  id: "event-1",
  type: "event",
  scope: {
    layer: "objective",
    regionPrimary: "钟楼",
  },
  fields: {
    summary: "艾琳在钟楼发现了地下入口",
    participants: "艾琳",
    status: "resolved",
  },
  storyTime: {
    segmentId: "tl-1",
    label: "第二天清晨",
    tense: "ongoing",
    relation: "same",
    anchorLabel: "",
    confidence: "high",
    source: "extract",
  },
};

const recalledCharacter = {
  id: "char-1",
  type: "pov_memory",
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerId: "艾琳",
    ownerName: "艾琳",
    regionPrimary: "钟楼",
  },
  fields: {
    summary: "艾琳觉得地下室入口说明钟楼里有人长期活动",
    belief: "这里藏着失踪案线索",
    emotion: "警觉",
    attitude: "必须立刻下去查看",
  },
  storyTime: {
    segmentId: "tl-1",
    label: "第二天清晨",
    tense: "ongoing",
    relation: "same",
    anchorLabel: "",
    confidence: "high",
    source: "extract",
  },
};

const recalledReflection = {
  id: "user-pov-1",
  type: "pov_memory",
  scope: {
    layer: "pov",
    ownerType: "user",
    ownerId: "玩家",
    ownerName: "玩家",
  },
  fields: {
    summary: "玩家已经把钟楼和失踪案牢牢绑定起来了",
    belief: "钟楼地下室肯定有更深的秘密",
    emotion: "紧张",
    attitude: "希望艾琳谨慎推进",
  },
};

const recalledSynopsis = {
  id: "synopsis-1",
  type: "synopsis",
  scope: {
    layer: "objective",
  },
  fields: {
    summary: "昨夜冲突后，艾琳在第二天清晨重新回到钟楼，并发现地下入口与失踪案有直接联系。",
  },
  storyTimeSpan: {
    startSegmentId: "tl-0",
    endSegmentId: "tl-1",
    startLabel: "昨夜冲突之后",
    endLabel: "第二天清晨",
    mixed: true,
    source: "derived",
  },
};

const activeSummaryEntry = {
  id: "summary-l0-1",
  level: 0,
  kind: "small",
  status: "active",
  text: "艾琳刚在钟楼重新站稳脚跟，并确认地下入口和失踪案直接相关，局面从调查转向即将下探。",
  sourceTask: "synopsis",
  extractionRange: [1, 3],
  messageRange: [2, 7],
  sourceBatchIds: ["batch-1", "batch-2", "batch-3"],
  sourceSummaryIds: [],
  sourceNodeIds: ["event-1"],
  storyTimeSpan: {
    startSegmentId: "tl-0",
    endSegmentId: "tl-1",
    startLabel: "昨夜冲突之后",
    endLabel: "第二天清晨",
    mixed: true,
    source: "derived",
  },
  regionHints: ["钟楼"],
  ownerHints: ["艾琳"],
};

const text = formatInjection(
  {
    summaryEntries: [activeSummaryEntry],
    coreNodes: [coreEvent],
    recallNodes: [recalledCharacter, recalledReflection],
    scopeBuckets: {
      characterPov: [recalledCharacter],
      characterPovByOwner: {
        "character:艾琳": [recalledCharacter],
      },
      characterPovOwnerOrder: ["character:艾琳"],
      userPov: [recalledReflection],
      objectiveCurrentRegion: [coreEvent],
      objectiveGlobal: [recalledSynopsis],
    },
    meta: {
      retrieval: {
        sceneOwnerCandidates: [
          { ownerKey: "character:艾琳", ownerName: "艾琳" },
        ],
      },
    },
  },
  DEFAULT_NODE_SCHEMA,
);

assert.match(text, /\[Memory - Character POV: 艾琳\]/);
assert.match(text, /\[Summary - Active Frontier\]/);
assert.match(text, /\[Summary L0 \/ 楼 2 ~ 7\]/);
assert.match(text, /\[Memory - User POV \/ Not Character Facts\]/);
assert.match(text, /不等于角色已知事实/);
assert.match(text, /\[Memory - Objective \/ Current Region\]/);
assert.match(text, /pov_memory_table:/);
assert.match(text, /\| owner \| story_time \| summary \| belief \| emotion \| attitude \|/);
assert.match(text, /角色: 艾琳/);
assert.match(text, /用户: 玩家/);
assert.match(text, /event_table:/);
assert.match(text, /\| story_time \| summary \| participants \| status \|/);
assert.match(text, /第二天清晨 · ongoing/);
assert.match(text, /story_time_span/);
assert.match(text, /昨夜冲突之后 -> 第二天清晨/);

console.log("injector-format tests passed");
