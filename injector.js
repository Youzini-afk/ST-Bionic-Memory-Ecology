// ST-BME: Prompt 注入模块
// 将检索结果格式化为表格注入到 LLM 上下文中

import { getSchemaType } from "./schema.js";

/**
 * 将检索结果转换为注入文本
 *
 * @param {object} retrievalResult - retriever.retrieve() 的返回值
 * @param {object[]} schema - 节点类型 Schema
 * @returns {string} 注入文本
 */
export function formatInjection(retrievalResult, schema) {
  const { coreNodes, recallNodes, groupedRecallNodes } = retrievalResult;
  const parts = [];

  // ========== Core 常驻注入 ==========
  if (coreNodes.length > 0) {
    parts.push("[Memory - Core]");

    const grouped = groupByType(coreNodes);

    for (const [typeId, nodes] of grouped) {
      const typeDef = getSchemaType(schema, typeId);
      if (!typeDef) continue;

      const table = formatTable(nodes, typeDef);
      if (table) parts.push(table);
    }
  }

  // ========== Recall 召回注入 ==========
  if (recallNodes.length > 0) {
    parts.push("");
    parts.push("[Memory - Recalled]");

    const buckets = groupedRecallNodes || {
      state: recallNodes.filter(
        (n) => n.type === "character" || n.type === "location",
      ),
      episodic: recallNodes.filter(
        (n) => n.type === "event" || n.type === "thread",
      ),
      reflective: recallNodes.filter(
        (n) => n.type === "reflection" || n.type === "synopsis",
      ),
      rule: recallNodes.filter((n) => n.type === "rule"),
      other: recallNodes.filter(
        (n) =>
          ![
            "character",
            "location",
            "event",
            "thread",
            "reflection",
            "synopsis",
            "rule",
          ].includes(n.type),
      ),
    };

    appendBucket(parts, "当前状态记忆", buckets.state, schema);
    appendBucket(parts, "情景事件记忆", buckets.episodic, schema);
    appendBucket(parts, "反思与长期锚点", buckets.reflective, schema);
    appendBucket(parts, "规则与约束", buckets.rule, schema);
    appendBucket(parts, "其他关联记忆", buckets.other, schema);
  }

  return parts.join("\n");
}

/**
 * 按类型分组节点
 */
function groupByType(nodes) {
  const map = new Map();
  for (const node of nodes) {
    if (!map.has(node.type)) map.set(node.type, []);
    map.get(node.type).push(node);
  }
  return map;
}

function appendBucket(parts, title, nodes, schema) {
  if (!nodes || nodes.length === 0) return;
  parts.push(`## ${title}`);

  const grouped = groupByType(nodes);
  for (const [typeId, groupedNodes] of grouped) {
    const typeDef = getSchemaType(schema, typeId);
    if (!typeDef) continue;

    const table = formatTable(groupedNodes, typeDef);
    if (table) parts.push(table);
  }
}

/**
 * 将同类型节点格式化为 Markdown 表格
 */
function formatTable(nodes, typeDef) {
  if (nodes.length === 0) return "";

  // 确定要展示的列（有实际数据的列）
  const activeCols = typeDef.columns.filter((col) =>
    nodes.some((n) => n.fields[col.name]),
  );

  if (activeCols.length === 0) return "";

  // 表头
  const header = `| ${activeCols.map((c) => c.name).join(" | ")} |`;
  const separator = `| ${activeCols.map(() => "---").join(" | ")} |`;

  // 数据行
  const rows = nodes.map((node) => {
    const cells = activeCols.map((col) => {
      const val = node.fields[col.name] || "";
      // 转义管道符，限制单元格长度
      return String(val)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 200);
    });
    return `| ${cells.join(" | ")} |`;
  });

  return `${typeDef.tableName}:\n${header}\n${separator}\n${rows.join("\n")}`;
}

/**
 * 获取注入提示词的总 token 估算
 * 粗略估算：1 个 token ≈ 2 个中文字符 或 4 个英文字符
 *
 * @param {string} injectionText
 * @returns {number} 估算 token 数
 */
export function estimateTokens(injectionText) {
  if (!injectionText) return 0;
  // 简单估算：中文 2 字符/token，英文 4 字符/token
  const cnChars = (injectionText.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = injectionText.length - cnChars;
  return Math.ceil(cnChars / 2 + otherChars / 4);
}
