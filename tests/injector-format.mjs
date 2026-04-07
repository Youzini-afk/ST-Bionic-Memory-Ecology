import assert from "node:assert/strict";
import { formatInjection } from "../injector.js";
import { DEFAULT_NODE_SCHEMA } from "../schema.js";

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

const text = formatInjection(
  {
    coreNodes: [coreEvent],
    recallNodes: [recalledCharacter, recalledReflection],
    scopeBuckets: {
      characterPov: [recalledCharacter],
      userPov: [recalledReflection],
      objectiveCurrentRegion: [coreEvent],
      objectiveGlobal: [],
    },
  },
  DEFAULT_NODE_SCHEMA,
);

assert.match(text, /\[Memory - Character POV\]/);
assert.match(text, /\[Memory - User POV \/ Not Character Facts\]/);
assert.match(text, /不等于角色已知事实/);
assert.match(text, /\[Memory - Objective \/ Current Region\]/);
assert.match(text, /pov_memory_table:/);
assert.match(text, /\| owner \| summary \| belief \| emotion \| attitude \|/);
assert.match(text, /角色: 艾琳/);
assert.match(text, /用户: 玩家/);
assert.match(text, /event_table:/);

console.log("injector-format tests passed");
