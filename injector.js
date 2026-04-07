// ST-BME: Prompt 注入模块
// 将检索结果格式化为表格注入到 LLM 上下文中

import { getSchemaType } from "./schema.js";
import { normalizeMemoryScope } from "./memory-scope.js";

/**
 * 将检索结果转换为注入文本
 *
 * @param {object} retrievalResult - retriever.retrieve() 的返回值
 * @param {object[]} schema - 节点类型 Schema
 * @returns {string} 注入文本
 */
export function formatInjection(retrievalResult, schema) {
  const { coreNodes, recallNodes, groupedRecallNodes, scopeBuckets } =
    retrievalResult;
  const parts = [];
  const appended = new Set();

  if (scopeBuckets && typeof scopeBuckets === "object") {
    appendScopeSection(
      parts,
      "[Memory - Character POV]",
      scopeBuckets.characterPov,
      schema,
      appended,
    );
    appendScopeSection(
      parts,
      "[Memory - User POV / Not Character Facts]",
      scopeBuckets.userPov,
      schema,
      appended,
      "这些是用户/玩家侧主观记忆，不等于角色已知事实；只能作为关系、承诺、情绪和长期互动背景参考。",
    );
    appendScopeSection(
      parts,
      "[Memory - Objective / Current Region]",
      scopeBuckets.objectiveCurrentRegion,
      schema,
      appended,
    );
    appendScopeSection(
      parts,
      "[Memory - Objective / Global]",
      scopeBuckets.objectiveGlobal,
      schema,
      appended,
    );

    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  // ========== Core 常驻注入 ==========
  if (coreNodes.length > 0) {
    parts.push("[Memory - Core]");

    const grouped = groupByType(coreNodes);

    for (const [typeId, nodes] of grouped) {
      const typeDef = getSchemaType(schema, typeId);
      if (!typeDef) continue;

      const table = formatTable(nodes, typeDef, appended);
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

    appendBucket(parts, "当前状态记忆", buckets.state, schema, appended);
    appendBucket(parts, "情景事件记忆", buckets.episodic, schema, appended);
    appendBucket(parts, "反思与长期锚点", buckets.reflective, schema, appended);
    appendBucket(parts, "规则与约束", buckets.rule, schema, appended);
    appendBucket(parts, "其他关联记忆", buckets.other, schema, appended);
  }

  return parts.join("\n");
}

function appendScopeSection(parts, title, nodes, schema, appended, note = "") {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  if (parts.length > 0) {
    parts.push("");
  }
  parts.push(title);
  if (note) {
    parts.push(note);
  }

  const grouped = groupByType(nodes);
  for (const [typeId, groupedNodes] of grouped) {
    const typeDef = getSchemaType(schema, typeId);
    if (!typeDef) continue;
    const table = formatTable(groupedNodes, typeDef, appended);
    if (table) parts.push(table);
  }
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

function appendBucket(parts, title, nodes, schema, appended) {
  if (!nodes || nodes.length === 0) return;
  parts.push(`## ${title}`);

  const grouped = groupByType(nodes);
  for (const [typeId, groupedNodes] of grouped) {
    const typeDef = getSchemaType(schema, typeId);
    if (!typeDef) continue;

    const table = formatTable(groupedNodes, typeDef, appended);
    if (table) parts.push(table);
  }
}

/**
 * 将同类型节点格式化为 Markdown 表格
 */
function formatTable(nodes, typeDef, appended = new Set()) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";

  const uniqueNodes = nodes.filter((node) => {
    if (!node?.id || appended.has(node.id)) return false;
    appended.add(node.id);
    return true;
  });

  if (uniqueNodes.length === 0) return "";

  // 确定要展示的列（有实际数据的列）
  const activeCols = typeDef.columns.filter((col) =>
    uniqueNodes.some(
      (n) => n.fields?.[col.name] != null && n.fields[col.name] !== "",
    ),
  );
  const derivedCols = buildDerivedColumns(uniqueNodes, typeDef);
  const allCols = [...derivedCols, ...activeCols];

  if (allCols.length === 0) return "";

  // 表头
  const header = `| ${allCols.map((c) => c.name).join(" | ")} |`;
  const separator = `| ${allCols.map(() => "---").join(" | ")} |`;

  // 数据行
  const rows = uniqueNodes.map((node) => {
    const cells = allCols.map((col) => {
      const val =
        typeof col.getValue === "function"
          ? col.getValue(node)
          : node.fields?.[col.name] ?? "";
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

function buildDerivedColumns(nodes, typeDef) {
  if (typeDef?.id !== "pov_memory") {
    return [];
  }

  return [
    {
      name: "owner",
      getValue(node) {
        const scope = normalizeMemoryScope(node?.scope);
        const ownerLabel = scope.ownerName || scope.ownerId || "未命名";
        if (scope.ownerType === "user") {
          return `用户: ${ownerLabel}`;
        }
        if (scope.ownerType === "character") {
          return `角色: ${ownerLabel}`;
        }
        return `POV: ${ownerLabel}`;
      },
    },
  ];
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
