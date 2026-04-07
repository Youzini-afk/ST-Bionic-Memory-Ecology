// ST-BME: 节点类型 Schema 定义
// 定义图谱中支持的节点类型、字段、注入策略和压缩配置

/**
 * 压缩模式
 */
export const COMPRESSION_MODE = {
  NONE: "none",
  HIERARCHICAL: "hierarchical",
};

/**
 * 默认节点类型 Schema
 * 每种类型定义了：
 * - id: 唯一标识
 * - label: 显示名称
 * - tableName: 注入时的表名
 * - columns: 字段列表 [{name, hint, required}]
 * - alwaysInject: 是否常驻注入（true=Core, false=需要召回）
 * - latestOnly: 是否只保留最新版本（用于角色/地点等随时间更新的实体）
 * - forceUpdate: 每次提取是否必须产出此类型节点
 * - compression: 压缩配置
 */
export const DEFAULT_NODE_SCHEMA = [
  {
    id: "event",
    label: "事件",
    tableName: "event_table",
    columns: [
      { name: "title", hint: "简短事件名（建议 6-18 字，用于图谱显示）", required: false },
      { name: "summary", hint: "事件摘要，包含因果关系和结果", required: true },
      { name: "participants", hint: "参与角色名，逗号分隔", required: false },
      {
        name: "status",
        hint: "事件状态：ongoing/resolved/blocked",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: true,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 9,
      fanIn: 3,
      maxDepth: 10,
      keepRecentLeaves: 6,
      instruction:
        "将事件节点压缩为高价值的剧情里程碑摘要。保留因果关系、不可逆结果和未解决的伏笔。",
    },
  },
  {
    id: "character",
    label: "角色",
    tableName: "character_table",
    columns: [
      { name: "name", hint: "角色名（仅规范名称）", required: true },
      { name: "traits", hint: "稳定的性格特征和外貌标记", required: false },
      { name: "state", hint: "当前状态或处境", required: false },
      { name: "goal", hint: "当前目标或动机", required: false },
      { name: "inventory", hint: "携带或拥有的关键物品", required: false },
      { name: "core_note", hint: "值得长期记住的关键备注", required: false },
    ],
    alwaysInject: false,
    latestOnly: true,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "location",
    label: "地点",
    tableName: "location_table",
    columns: [
      { name: "name", hint: "地点名称（仅规范名称）", required: true },
      { name: "state", hint: "当前状态或环境条件", required: false },
      { name: "features", hint: "重要特征、资源或服务", required: false },
      { name: "danger", hint: "危险等级或威胁", required: false },
    ],
    alwaysInject: false,
    latestOnly: true,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "rule",
    label: "规则",
    tableName: "rule_table",
    columns: [
      { name: "title", hint: "简短规则名", required: true },
      { name: "constraint", hint: "不可违反的规则内容", required: true },
      { name: "scope", hint: "适用范围/场景", required: false },
      {
        name: "status",
        hint: "当前有效性：active/suspended/revoked",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "thread",
    label: "主线",
    tableName: "thread_table",
    columns: [
      { name: "title", hint: "主线名称", required: true },
      { name: "summary", hint: "当前进展摘要", required: false },
      {
        name: "status",
        hint: "状态：active/completed/abandoned",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 6,
      fanIn: 3,
      maxDepth: 5,
      keepRecentLeaves: 3,
      instruction: "将主线节点压缩为阶段性进展摘要。保留关键转折和当前目标。",
    },
  },
  // ====== v2 新增节点类型 ======
  {
    id: "synopsis",
    label: "全局概要",
    tableName: "synopsis_table",
    columns: [
      {
        name: "summary",
        hint: "当前故事的全局概要（前情提要）",
        required: true,
      },
      { name: "scope", hint: "概要覆盖的楼层范围", required: false },
    ],
    alwaysInject: true, // 常驻注入（MemoRAG 启发）
    latestOnly: true, // 只保留最新版本
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "reflection",
    label: "反思",
    tableName: "reflection_table",
    columns: [
      { name: "insight", hint: "对角色行为或情节的元认知反思", required: true },
      { name: "trigger", hint: "触发反思的事件/矛盾", required: false },
      { name: "suggestion", hint: "对后续叙事的建议", required: false },
    ],
    alwaysInject: false, // 需要被召回
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 6,
      fanIn: 3,
      maxDepth: 3,
      keepRecentLeaves: 3,
      instruction: "将反思条目合并为高层次的叙事指导原则。",
    },
  },
  {
    id: "pov_memory",
    label: "主观记忆",
    tableName: "pov_memory_table",
    columns: [
      { name: "summary", hint: "这个视角如何记住这件事", required: true },
      { name: "belief", hint: "她/他认为发生了什么", required: false },
      { name: "emotion", hint: "主观情绪反应", required: false },
      { name: "attitude", hint: "对人物或事件的态度", required: false },
      {
        name: "certainty",
        hint: "确定度：certain/unsure/mistaken",
        required: false,
      },
      { name: "about", hint: "关联对象或引用标签", required: false },
    ],
    alwaysInject: false,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 8,
      fanIn: 3,
      maxDepth: 4,
      keepRecentLeaves: 4,
      instruction:
        "将同一视角、同一角色归属下的主观记忆压缩成更稳定的第一视角记忆摘要，保留误解、情绪和态度变化。",
    },
  },
];

/**
 * 规范化的关系类型
 */
export const RELATION_TYPES = [
  "related", // 一般关联
  "involved_in", // 参与事件
  "occurred_at", // 发生于地点
  "advances", // 推进主线
  "updates", // 更新实体状态
  "contradicts", // 矛盾/冲突（用于抑制边）
  "evolves", // A-MEM 进化链接（新→旧）
  "temporal_update", // 时序更新（Graphiti：新状态替代旧状态）
];

/**
 * 验证 Schema 配置的合法性
 * @param {Array} schema
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSchema(schema) {
  const errors = [];

  if (!Array.isArray(schema) || schema.length === 0) {
    errors.push("Schema 必须是非空数组");
    return { valid: false, errors };
  }

  const ids = new Set();
  const tableNames = new Set();

  for (const type of schema) {
    if (!type || typeof type !== "object") {
      errors.push("Schema 类型定义必须是对象");
      continue;
    }

    if (!type.id || typeof type.id !== "string") {
      errors.push("每种类型必须有 id");
      continue;
    }

    if (ids.has(type.id)) {
      errors.push(`类型 ID 重复：${type.id}`);
    }
    ids.add(type.id);

    if (!type.label || typeof type.label !== "string") {
      errors.push(`类型 ${type.id}：缺少 label`);
    }

    if (!type.tableName || typeof type.tableName !== "string") {
      errors.push(`类型 ${type.id}：缺少 tableName`);
    } else if (tableNames.has(type.tableName)) {
      errors.push(`表名重复：${type.tableName}`);
    } else {
      tableNames.add(type.tableName);
    }

    if (!Array.isArray(type.columns) || type.columns.length === 0) {
      errors.push(`类型 ${type.id}：至少需要一个列`);
      continue;
    }

    const columnNames = new Set();
    for (const column of type.columns) {
      if (!column?.name || typeof column.name !== "string") {
        errors.push(`类型 ${type.id}：存在缺少 name 的列定义`);
        continue;
      }
      if (columnNames.has(column.name)) {
        errors.push(`类型 ${type.id}：列名重复 ${column.name}`);
      }
      columnNames.add(column.name);
    }

    const hasRequired = type.columns.some((c) => c?.required);
    if (!hasRequired) {
      errors.push(`类型 ${type.id}：至少需要一个 required 列`);
    }

    if (type.latestOnly) {
      const hasPrimaryLikeField = ["name", "title", "summary"].some(
        (fieldName) =>
          type.columns.some((column) => column?.name === fieldName),
      );
      if (!hasPrimaryLikeField) {
        errors.push(
          `类型 ${type.id}：latestOnly 类型至少需要 name/title/summary 之一作为主标识字段`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 获取 Schema 中某个类型的定义
 * @param {Array} schema
 * @param {string} typeId
 * @returns {object|null}
 */
export function getSchemaType(schema, typeId) {
  return schema.find((t) => t.id === typeId) || null;
}
