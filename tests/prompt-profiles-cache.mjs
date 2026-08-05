import assert from "node:assert/strict";
import {
  createDefaultTaskProfile,
  normalizeTaskProfile,
} from "../prompting/prompt-profiles.js";

// 回归测试：任务模板/指纹按 taskType 缓存后，
// 重复构建必须返回全新对象且内容一致、指纹稳定。
const first = createDefaultTaskProfile("extract_objective");
const second = createDefaultTaskProfile("extract_objective");
assert.notEqual(first, second);
assert.deepEqual(second, first);
assert.equal(
  first.metadata.defaultTemplateFingerprint,
  second.metadata.defaultTemplateFingerprint,
);

// 所有内置任务类型都能构建，且缓存不破坏对象隔离与指纹一致性。
for (const taskType of [
  "extract_subjective",
  "recall",
  "agent_recall",
  "compress",
  "synopsis",
  "summary_rollup",
  "reflection",
  "consolidation",
  "agent_steward",
  "planner",
]) {
  const a = createDefaultTaskProfile(taskType);
  const b = createDefaultTaskProfile(taskType);
  assert.ok(a && Array.isArray(a.blocks) && a.blocks.length > 0, taskType);
  assert.notEqual(a, b, taskType);
  assert.deepEqual(b, a, taskType);
  assert.equal(
    a.metadata.defaultTemplateFingerprint,
    b.metadata.defaultTemplateFingerprint,
    taskType,
  );
}

// normalizeTaskProfile 仍然正常合并用户 profile。
const normalized = normalizeTaskProfile("extract_objective", { version: 3 });
assert.equal(normalized.taskType, "extract_objective");
assert.equal(normalized.id, "default");
assert.ok(Array.isArray(normalized.blocks) && normalized.blocks.length > 0);

console.log("prompt-profiles cache tests passed");
