import { stableStringify } from "../domain/memory-id.js";

function capabilityLabel(entry = {}) {
  const capabilities = [entry.readOnly ? "只读" : "可结算状态"];
  if (entry.idempotent) capabilities.push("可安全重试");
  if (entry.parallelSafe) capabilities.push("可并行");
  return capabilities.join(" / ");
}

export function formatAgentToolCatalog(snapshot = {}) {
  const entries = Array.isArray(snapshot?.catalog) ? snapshot.catalog : [];
  const parts = [
    "## 本次运行实际可用的工具",
    `工具快照：${String(snapshot?.fingerprint || "unknown")}`,
    "以下目录由本次真实注册的工具生成；它只解释能力，实际调用仍受参数 Schema、聊天作用域、认知边界和事务检查约束。",
  ];

  for (const entry of entries) {
    parts.push(
      "",
      `### ${String(entry?.name || "unknown")}`,
      String(entry?.description || "未提供说明"),
      `性质：${capabilityLabel(entry)}`,
      `参数 Schema：${stableStringify(entry?.parameters || {})}`,
    );
  }

  return parts.join("\n");
}
