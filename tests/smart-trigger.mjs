import assert from "node:assert/strict";

function getSmartTriggerDecision(chat, lastProcessed, settings) {
  const DEFAULT_TRIGGER_KEYWORDS = [
    "突然",
    "没想到",
    "原来",
    "其实",
    "发现",
    "背叛",
    "死亡",
    "复活",
    "恢复记忆",
    "失忆",
    "告白",
    "暴露",
    "秘密",
    "计划",
    "规则",
    "契约",
    "位置",
    "地点",
    "离开",
    "来到",
  ];

  const pendingMessages = chat
    .slice(lastProcessed + 1)
    .filter((msg) => !msg.is_system)
    .map((msg) => ({
      role: msg.is_user ? "user" : "assistant",
      content: msg.mes || "",
    }));

  if (pendingMessages.length === 0) {
    return { triggered: false, score: 0, reasons: [] };
  }

  const reasons = [];
  let score = 0;
  const combinedText = pendingMessages.map((m) => m.content).join("\n");

  const keywordHits = DEFAULT_TRIGGER_KEYWORDS.filter((keyword) =>
    combinedText.includes(keyword),
  );
  if (keywordHits.length > 0) {
    score += Math.min(2, keywordHits.length);
    reasons.push(`关键词: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  const customPatterns = String(settings.triggerPatterns || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pattern of customPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(combinedText)) {
        score += 2;
        reasons.push(`自定义触发: ${pattern}`);
        break;
      }
    } catch {
      // ignore invalid regex
    }
  }

  const roleSwitchCount = pendingMessages.reduce((count, message, index) => {
    if (index === 0) return count;
    return count + (message.role !== pendingMessages[index - 1].role ? 1 : 0);
  }, 0);
  if (roleSwitchCount >= 2) {
    score += 1;
    reasons.push("多轮往返互动");
  }

  const punctuationHits = (combinedText.match(/[!?！？]/g) || []).length;
  if (punctuationHits >= 2) {
    score += 1;
    reasons.push("情绪/冲突波动");
  }

  const entityLikeHits =
    combinedText.match(
      /[A-Z][a-z]{2,}|[\u4e00-\u9fff]{2,6}(先生|小姐|王国|城|镇|村|学院|组织|公司|小队|军团)/g,
    ) || [];
  if (entityLikeHits.length > 0) {
    score += 1;
    reasons.push("疑似新实体/新地点");
  }

  const threshold = Math.max(1, settings.smartTriggerThreshold || 2);
  return {
    triggered: score >= threshold,
    score,
    reasons,
  };
}

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

console.log("smart-trigger tests passed");
