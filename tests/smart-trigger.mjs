import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadSmartTriggerDecision() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.resolve(__dirname, "../index.js");
  const source = await fs.readFile(indexPath, "utf8");
  const keywordMatch = source.match(
    /const DEFAULT_TRIGGER_KEYWORDS = \[[\s\S]*?\];/m,
  );
  const fnMatch = source.match(
    /export function getSmartTriggerDecision\(chat, lastProcessed, settings\) \{[\s\S]*?^\}/m,
  );

  if (!keywordMatch || !fnMatch) {
    throw new Error("无法从 index.js 提取 smart trigger 实现");
  }

  const context = vm.createContext({});
  const script = new vm.Script(`
${keywordMatch[0]}
${fnMatch[0].replace("export function", "function")}
this.getSmartTriggerDecision = getSmartTriggerDecision;
`);
  script.runInContext(context);
  return context.getSmartTriggerDecision;
}

const getSmartTriggerDecision = await loadSmartTriggerDecision();

const noTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "今天天气不错。" },
    { is_user: false, mes: "是的，我们继续赶路。" },
  ],
  -1,
  { triggerPatterns: "", smartTriggerThreshold: 3 },
);
assert.equal(noTrigger.triggered, false);

const keywordTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "我们突然发现城堡地下有秘密。" },
    { is_user: false, mes: "原来失踪的人都被关在这里！" },
  ],
  -1,
  { triggerPatterns: "", smartTriggerThreshold: 2 },
);
assert.equal(keywordTrigger.triggered, true);
assert.ok(keywordTrigger.score >= 2);

const customTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "她轻声说出真相。" },
    { is_user: false, mes: "所有人都沉默了。" },
  ],
  -1,
  { triggerPatterns: "真相|背叛", smartTriggerThreshold: 2 },
);
assert.equal(customTrigger.triggered, true);
assert.ok(customTrigger.reasons.some((r) => r.includes("自定义触发")));

const ignoresProcessedMessages = getSmartTriggerDecision(
  [
    { is_user: true, mes: "之前突然出现了秘密。" },
    { is_user: false, mes: "这已经处理过。" },
    { is_user: true, mes: "现在只是平静地走路。" },
    { is_user: false, mes: "没有新的异常。" },
  ],
  1,
  { triggerPatterns: "", smartTriggerThreshold: 2 },
);
assert.equal(ignoresProcessedMessages.triggered, false);
assert.equal(ignoresProcessedMessages.score, 0);

const ignoresBlankAndInvalidRegex = getSmartTriggerDecision(
  [
    { is_system: true, mes: "系统消息" },
    { is_user: true, mes: "   " },
    { is_user: false, mes: "Alpha城发生了什么？！" },
  ],
  -1,
  { triggerPatterns: "([\n真相", smartTriggerThreshold: 2 },
);
assert.equal(ignoresBlankAndInvalidRegex.triggered, true);
assert.ok(ignoresBlankAndInvalidRegex.reasons.includes("情绪/冲突波动"));

console.log("smart-trigger tests passed");
