import assert from "node:assert/strict";
import { formatInjection } from "../injector.js";
import { DEFAULT_NODE_SCHEMA } from "../schema.js";

const coreEvent = {
  id: "event-1",
  type: "event",
  fields: {
    summary: "艾琳在钟楼发现了地下入口",
    participants: "艾琳",
    status: "resolved",
  },
};

const recalledCharacter = {
  id: "char-1",
  type: "character",
  fields: {
    name: "艾琳",
    state: "警觉并准备进入地下室",
    goal: "调查钟楼秘密",
  },
};

const recalledReflection = {
  id: "reflection-1",
  type: "reflection",
  fields: {
    insight: "地下入口意味着先前的失踪案与钟楼存在长期关联",
    trigger: "钟楼发现暗门",
    suggestion: "后续优先追查地下通道与失踪人口名单",
  },
};

const text = formatInjection(
  {
    coreNodes: [coreEvent],
    recallNodes: [recalledCharacter, recalledReflection],
    groupedRecallNodes: {
      state: [recalledCharacter],
      episodic: [],
      reflective: [recalledReflection],
      rule: [],
      other: [],
    },
  },
  DEFAULT_NODE_SCHEMA,
);

assert.match(text, /\[Memory - Core\]/);
assert.match(text, /event_table:/);
assert.match(text, /\[Memory - Recalled\]/);
assert.match(text, /## 当前状态记忆/);
assert.match(text, /## 反思与长期锚点/);
assert.match(text, /character_table:/);
assert.match(text, /reflection_table:/);

console.log("injector-format tests passed");
