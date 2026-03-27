// ST-BME: 任务预设与兼容迁移层

const TASK_TYPES = [
  "extract",
  "recall",
  "compress",
  "synopsis",
  "reflection",
  "consolidation",
];

const TASK_TYPE_META = {
  extract: {
    label: "提取",
    description: "从当前对话批次中抽取结构化记忆。",
  },
  recall: {
    label: "召回",
    description: "根据上下文筛选最相关的记忆节点。",
  },
  compress: {
    label: "压缩",
    description: "合并并压缩高层节点内容。",
  },
  synopsis: {
    label: "概要",
    description: "生成阶段性的全局剧情提要。",
  },
  reflection: {
    label: "反思",
    description: "沉淀长期趋势、触发点与建议。",
  },
  consolidation: {
    label: "整合",
    description: "分析新旧记忆的冲突、去重与进化。",
  },
};

const BUILTIN_BLOCK_DEFINITIONS = [
  {
    sourceKey: "taskName",
    name: "任务名",
    role: "system",
    description: "注入当前任务类型标识（如 extract、recall）。通常不需要手动添加，因为角色定义块已隐含任务身份。",
  },
  {
    sourceKey: "systemInstruction",
    name: "系统说明",
    role: "system",
    description: "注入任务级系统指令。可用于添加通用约束或全局规则。提示：可创建多个自定义块并设置不同角色（system/user/assistant）来实现多轮对话式 prompt 编排，利用 few-shot 引导 LLM 遵守格式。可用变量：{{charName}}、{{userName}}、{{charDescription}}、{{userPersona}}、{{currentTime}}。",
  },
  {
    sourceKey: "charDescription",
    name: "角色描述",
    role: "system",
    description: "注入当前角色卡的描述正文。适合需要把角色设定直接并入任务 prompt 的预设。",
  },
  {
    sourceKey: "userPersona",
    name: "用户设定",
    role: "system",
    description: "注入当前用户 Persona / 用户设定。适合让任务在生成时参考玩家长期设定。",
  },
  {
    sourceKey: "worldInfoBefore",
    name: "世界书前块",
    role: "system",
    description: "注入按酒馆世界书规则解析后的 before 桶内容，支持角色主/附加世界书、用户设定世界书、聊天世界书，以及世界书条目中的 EJS / getwi。",
  },
  {
    sourceKey: "worldInfoAfter",
    name: "世界书后块",
    role: "system",
    description: "注入按酒馆世界书规则解析后的 after 桶内容。atDepth 条目不会出现在这里，而是自动并入额外消息链路。",
  },
  {
    sourceKey: "outputRules",
    name: "输出规则",
    role: "system",
    description: "注入 JSON 结构化输出的格式要求。适用于需要严格 JSON 输出的任务（extract、recall、consolidation 等）。",
  },
  {
    sourceKey: "schema",
    name: "Schema",
    role: "system",
    description: "注入知识图谱的节点类型和字段定义。extract 任务会用到，让 LLM 知道可以创建哪些类型的节点。",
  },
  {
    sourceKey: "recentMessages",
    name: "最近消息",
    role: "system",
    description: "注入最近的对话上下文片段。extract 和 recall 任务使用，提供 LLM 分析所需的对话历史。",
  },
  {
    sourceKey: "userMessage",
    name: "用户消息",
    role: "system",
    description: "注入当前用户的最新输入内容。recall 任务使用，用于匹配最相关的记忆节点。",
  },
  {
    sourceKey: "candidateNodes",
    name: "候选节点",
    role: "system",
    description: "注入待筛选的候选记忆节点列表。recall（选择相关节点）和 consolidation（检测冲突）任务使用。",
  },
  {
    sourceKey: "graphStats",
    name: "图统计",
    role: "system",
    description: "注入图谱当前状态摘要（如节点数量、类型分布）。所有任务类型均可使用，帮助 LLM 了解图谱全貌。",
  },
  {
    sourceKey: "currentRange",
    name: "当前范围",
    role: "system",
    description: "注入当前处理的消息楼层范围（如「楼 5 ~ 楼 10」）。extract 和 compress 任务使用。",
  },
  {
    sourceKey: "nodeContent",
    name: "节点内容",
    role: "system",
    description: "注入待压缩的节点正文内容。compress 任务专用，包含需要合并总结的多个节点文本。",
  },
  {
    sourceKey: "eventSummary",
    name: "事件摘要",
    role: "system",
    description: "注入近期事件时间线摘要。synopsis（生成前情提要）和 reflection（生成反思）任务使用。",
  },
  {
    sourceKey: "characterSummary",
    name: "角色摘要",
    role: "system",
    description: "注入近期角色状态变化摘要。synopsis 和 reflection 任务使用，帮助 LLM 了解角色动态。",
  },
  {
    sourceKey: "threadSummary",
    name: "主线摘要",
    role: "system",
    description: "注入当前活跃的故事主线摘要。synopsis 和 reflection 任务使用，帮助 LLM 把握叙事走向。",
  },
  {
    sourceKey: "contradictionSummary",
    name: "矛盾摘要",
    role: "system",
    description: "注入近期检测到的记忆矛盾或冲突信息。reflection 任务专用，触发基于矛盾的深度反思。",
  },
];

const DEFAULT_TASK_PROFILE_VERSION = 3;
const DEFAULT_PROFILE_ID = "default";

const LEGACY_PROMPT_FIELD_MAP = {
  extract: "extractPrompt",
  recall: "recallPrompt",
  compress: "compressPrompt",
  synopsis: "synopsisPrompt",
  reflection: "reflectionPrompt",
  consolidation: "consolidationPrompt",
};

// ═══════════════════════════════════════════════════
// 默认预设拆块定义：每个任务 → 3 段（角色定义 / 输出格式 / 行为规则）
// ═══════════════════════════════════════════════════

const DEFAULT_TASK_BLOCKS = {
  extract: {
    role: [
      "你是记忆提取执行 AI。从对话中提取结构化记忆节点，写入知识图谱。",
      `必须按「分析（thought）→ 操作（operations）」架构工作。`,
    ].join("\n"),
    format: [
      "请你用下面这个 JSON 结构回复我，不要输出任何多余内容：",
      "{",
      '  "thought": "写下你对这段对话的分析（发生了什么事、角色有什么变化、出现了什么新信息）",',
      '  "operations": [',
      "    {",
      '      "action": "create",',
      '      "type": "event",',
      '      "fields": {"title": "简短事件名", "summary": "...", "participants": "...", "status": "ongoing"},',
      '      "importance": 6,',
      '      "ref": "evt1",',
      '      "links": [',
      '        {"targetNodeId": "existing-id", "relation": "involved_in", "strength": 0.9}',
      "      ]",
      "    },",
      "    {",
      '      "action": "update",',
      '      "nodeId": "existing-node-id",',
      '      "fields": {"state": "新的状态"}',
      "    }",
      "  ]",
      "}",
    ].join("\n"),
    rules: [
      "我对你有这几个要求，请严格遵守：",
      "",
      "提取原则——",
      "- 只从上面给你的对话正文里提取内容，我没提到的东西你千万别自己编造",
      "- 每批对话最多给我 1 个事件节点，如果有多个小事件就合并到一个里面",
      "- 先查一下图里有没有同名角色/地点，有的话用 update，别重复 create",
      "- importance 按 1-10 打分：日常交互给 3-5，关键转折给 7-8，改变格局的才给 9-10",
      "",
      "字段要求——",
      "- event 的 title 写简短的事件名就行，6-18 个字，别写成一大段",
      "- summary 用你自己的话概括，别照抄原文，150 字以内",
      "- participants 把所有参与者的名字列出来，用逗号分隔",
      "",
      "JSON 格式——",
      "- 字符串里的双引号必须转义",
      "- 不要留尾随逗号、不要用单引号、不要写注释",
      "",
      "以下是我特别不想看到的错误，请你一定避免：",
      "- 编造对话里没出现过的事件或角色",
      `- 图里已经有「张三」了还去 create 一个新「张三」`,
      "- title 写成一整段叙述而非简短事件名",
      "- summary 直接复制粘贴原文",
      "- importance 全给 5，不区分轻重",
    ].join("\n"),
  },
  recall: {
    role: [
      "你是记忆召回执行 AI。从候选记忆节点中选择与当前对话最相关的节点。",
      "必须先推测剧情走向，再按相关性排序选择。",
    ].join("\n"),
    format: '请用这个 JSON 格式回复我，不要多余内容：\n{"selected_ids": ["id1", "id2", ...], "reason": "简要说明你为什么选了这些节点"}',
    rules: [
      "请按下面的优先级帮我挑选记忆节点：",
      "",
      "优先级从高到低——",
      "1. 跟当前场景直接相关的（正在发生的事件、在场的角色）",
      "2. 跟当前事件有因果关系的前序事件",
      "3. 涉及相同角色的情感/关系变化",
      "4. 可能影响当前决策的背景信息",
      "",
      "选择原则——",
      "- 别因为 importance 分高就选，必须跟当前对话有关才行",
      "- 每个选中的节点都在 reason 里告诉我为什么选它",
      "- 宁可少选也不要选进无关的节点",
      "",
      "我不想看到这些问题：",
      "- 把所有候选节点全选了（你得有取舍）",
      "- 一个都不选（除非候选的确实全部无关）",
      `- reason 只写一句「这些节点相关」（我需要你具体说明每个节点相关在哪）`,
      "- 选了已经标记为 archived 的过期信息",
    ].join("\n"),
  },
  consolidation: {
    role: [
      "你是记忆整合执行 AI。当新记忆加入知识图谱时，执行冲突检测与进化分析。",
      `必须按「冲突检测 → 进化分析」双任务架构工作。`,
    ].join("\n"),
    format: [
      "请用下面的 JSON 格式回复我：",
      '{ "results": [',
      '  { "node_id": "新记忆节点ID",',
      '    "action": "keep"|"merge"|"skip",',
      '    "merge_target_id": "旧节点ID（只在 merge 时填）",',
      '    "reason": "你的判断理由",',
      '    "evolution": { "should_evolve": true/false, "connections": ["旧记忆ID"], "neighbor_updates": [...] }',
      "  }",
      "] }",
    ].join("\n"),
    rules: [
      "请对每个新记忆节点做这两步判断：",
      "",
      "第一步：冲突检测——",
      "- skip：跟已有记忆完全重复，没什么新信息",
      "- merge：是对旧记忆的修正、补充或更新",
      "- keep：包含全新信息，跟已有记忆不冲突",
      "",
      "第二步：进化分析（只在 action=keep 时做）——",
      "- 看看新记忆跟旧记忆之间有没有因果/时序/角色关联",
      "- 有的话建立 connections",
      "- 判断是否需要反向更新旧记忆的状态",
      "",
      "帮我把标准吃准：",
      `- 「完全重复」是指核心事实相同，不是措辞像就算`,
      `- 「修正」是指新信息明确否定或纠正了旧信息`,
      `- 「补充」是指新信息给旧信息加了细节但没有矛盾`,
      "",
      "千万别犯这些错：",
      "- 对所有节点都返回 keep（要认真查重）",
      "- merge 时忘了填 merge_target_id",
      `- 信息只是措辞不同就判 keep（应该 skip 或 merge）`,
      "- keep 时 connections 留空（尽量找关联）",
    ].join("\n"),
  },
  compress: {
    role: [
      "你是记忆压缩执行 AI。将多个同类记忆节点合并为一条精炼的高层摘要。",
      `必须按「分析 → 压缩 → 自检」流程工作。`,
    ].join("\n"),
    format: '请用这个 JSON 格式给我压缩结果：\n{"fields": {"summary": "压缩后的摘要", ...}}',
    rules: [
      "帮我把这些记忆节点压缩成一条精炼摘要，按这个优先级保留信息：",
      "",
      "保留优先级从高到低——",
      "1. 不可逆的结果（死亡、永久变化、无法撤销的决定）",
      "2. 因果关系链（A 导致 B 的逻辑）",
      "3. 未解决的伏笔和悬念",
      "4. 关键的情感/关系转折",
      "5. 可以删掉的：重复描述、日常寒暄、低信息量内容",
      "",
      "写作要求——",
      "- 目标 150 字左右，最多不超过 300 字",
      "- 用第三人称客观视角，不加你的主观判断",
      "- 保留时间线的先后顺序，别写乱了",
      "",
      "写完后请自查：",
      "□ 关键因果链保留了吗？",
      "□ 有没有重要信息被遗漏？",
      "□ 时间顺序对不对？",
      "□ 有没有加入了原文没有的东西？",
      "",
      "我不想看到：",
      "- 丢失了关键因果关系",
      "- 把不同角色的经历搞混",
      "- 加入了原始节点里没有的推测",
      "- 超过 300 字",
    ].join("\n"),
  },
  synopsis: {
    role: [
      "你是故事概要生成执行 AI。根据事件线、角色状态和主线信息，生成简洁的前情提要。",
      "必须覆盖核心冲突、关键转折和角色当前状态。",
    ].join("\n"),
    format: '请给我一个 JSON：{"summary": "前情提要（200字以内）"}',
    rules: [
      "帮我写一段简洁的前情提要，必须覆盖：",
      "",
      "1. 核心冲突——当前故事的主要矛盾",
      "2. 关键转折——近期改变局势的事件",
      "3. 角色状态——主要角色现在的处境和关系",
      "",
      "写作要求——",
      "- 200 字以内",
      "- 按时间线顺序写",
      "- 用第三人称叙述视角",
      "- 写成连贯的叙述，别列清单",
      "",
      "别犯这些错误：",
      "- 超过 200 字",
      "- 漏了核心冲突或主要角色",
      "- 写成一条条事件列表",
      "- 加入你个人的评价或预测",
    ].join("\n"),
  },
  reflection: {
    role: [
      "你是长期记忆反思执行 AI。从近期事件中提炼长期趋势、潜在线索和值得关注的变化。",
      "重点关注：角色关系走向、未解悬念、可能的伏笔。",
    ].join("\n"),
    format: '请用这个 JSON 格式回复：{"insight":"...", "trigger":"...", "suggestion":"...", "importance":1-10}',
    rules: [
      "请帮我从近期事件中提炼出值得长期关注的趋势和线索：",
      "",
      "我需要你关注三个维度——",
      "1. insight：最值得长期保留的变化趋势、关系走向或潜在线索",
      "2. trigger：是什么事件或矛盾触发了你的这条反思",
      "3. suggestion：后续叙事中我应该留意或检索的方向",
      "",
      "写作要求——",
      "- 别复述事件详情，我要的是你提炼出的高层结论",
      "- insight 应该数十轮之后回看仍然有参考价值",
      "- importance 严格按影响范围打分，别全给高分",
      "",
      "别犯这些错：",
      "- 把全部事件复述一遍而不是提炼结论",
      "- insight 写成事件摘要而非趋势分析",
      "- importance 全给 8 以上",
      "- trigger 为空或写得太笼统",
    ].join("\n"),
  },
};

const COMMON_DEFAULT_BLOCK_BLUEPRINTS = [
  {
    id: "default-role",
    name: "角色定义",
    type: "custom",
    role: "system",
    contentKey: "role",
  },
  {
    id: "default-char-desc",
    name: "角色描述",
    type: "builtin",
    role: "system",
    sourceKey: "charDescription",
  },
  {
    id: "default-user-persona",
    name: "用户设定",
    type: "builtin",
    role: "system",
    sourceKey: "userPersona",
  },
  {
    id: "default-wi-before",
    name: "世界书前块",
    type: "builtin",
    role: "system",
    sourceKey: "worldInfoBefore",
  },
  {
    id: "default-wi-after",
    name: "世界书后块",
    type: "builtin",
    role: "system",
    sourceKey: "worldInfoAfter",
  },
];

const TASK_CONTEXT_BLOCK_BLUEPRINTS = {
  extract: [
    {
      id: "default-recent-messages",
      name: "最近消息",
      type: "builtin",
      role: "system",
      sourceKey: "recentMessages",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
    {
      id: "default-schema",
      name: "Schema",
      type: "builtin",
      role: "system",
      sourceKey: "schema",
    },
    {
      id: "default-current-range",
      name: "当前范围",
      type: "builtin",
      role: "system",
      sourceKey: "currentRange",
    },
  ],
  recall: [
    {
      id: "default-recent-messages",
      name: "最近消息",
      type: "builtin",
      role: "system",
      sourceKey: "recentMessages",
    },
    {
      id: "default-user-message",
      name: "用户消息",
      type: "builtin",
      role: "system",
      sourceKey: "userMessage",
    },
    {
      id: "default-candidate-nodes",
      name: "候选节点",
      type: "builtin",
      role: "system",
      sourceKey: "candidateNodes",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  consolidation: [
    {
      id: "default-candidate-nodes",
      name: "候选节点",
      type: "builtin",
      role: "system",
      sourceKey: "candidateNodes",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  compress: [
    {
      id: "default-node-content",
      name: "节点内容",
      type: "builtin",
      role: "system",
      sourceKey: "nodeContent",
    },
    {
      id: "default-current-range",
      name: "当前范围",
      type: "builtin",
      role: "system",
      sourceKey: "currentRange",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  synopsis: [
    {
      id: "default-event-summary",
      name: "事件摘要",
      type: "builtin",
      role: "system",
      sourceKey: "eventSummary",
    },
    {
      id: "default-character-summary",
      name: "角色摘要",
      type: "builtin",
      role: "system",
      sourceKey: "characterSummary",
    },
    {
      id: "default-thread-summary",
      name: "主线摘要",
      type: "builtin",
      role: "system",
      sourceKey: "threadSummary",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  reflection: [
    {
      id: "default-event-summary",
      name: "事件摘要",
      type: "builtin",
      role: "system",
      sourceKey: "eventSummary",
    },
    {
      id: "default-character-summary",
      name: "角色摘要",
      type: "builtin",
      role: "system",
      sourceKey: "characterSummary",
    },
    {
      id: "default-thread-summary",
      name: "主线摘要",
      type: "builtin",
      role: "system",
      sourceKey: "threadSummary",
    },
    {
      id: "default-contradiction-summary",
      name: "矛盾摘要",
      type: "builtin",
      role: "system",
      sourceKey: "contradictionSummary",
    },
    {
      id: "default-graph-stats",
      name: "图统计",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
};

const DEFAULT_TRAILING_BLOCK_BLUEPRINTS = [
  {
    id: "default-format",
    name: "输出格式",
    type: "custom",
    role: "user",
    contentKey: "format",
  },
  {
    id: "default-rules",
    name: "行为规则",
    type: "custom",
    role: "user",
    contentKey: "rules",
  },
];

export { DEFAULT_TASK_BLOCKS };

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function createUniqueId(prefix = "profile") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeRole(role) {
  const value = String(role || "system").trim().toLowerCase();
  if (["system", "user", "assistant"].includes(value)) {
    return value;
  }
  return "system";
}

function normalizeInjectionMode(mode) {
  const value = String(mode || "append").trim().toLowerCase();
  if (["append", "prepend", "relative"].includes(value)) {
    return value;
  }
  return "append";
}

function normalizePromptBlock(taskType, block = {}, index = 0) {
  const fallbackType = String(block?.type || "custom");
  return {
    id: String(block?.id || createPromptBlockId(taskType)),
    name: typeof block?.name === "string" ? block.name : "",
    type: fallbackType,
    enabled: block?.enabled !== false,
    role: normalizeRole(block?.role),
    sourceKey: typeof block?.sourceKey === "string" ? block.sourceKey : "",
    sourceField: typeof block?.sourceField === "string" ? block.sourceField : "",
    content: typeof block?.content === "string" ? block.content : "",
    injectionMode: normalizeInjectionMode(block?.injectionMode),
    order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
  };
}

function normalizeRegexLocalRule(rule = {}, taskType = "task", index = 0) {
  return {
    id: String(rule?.id || createRegexRuleId(taskType)),
    script_name: String(
      rule?.script_name || rule?.scriptName || `本地规则 ${index + 1}`,
    ),
    enabled: rule?.enabled !== false,
    find_regex: String(rule?.find_regex || rule?.findRegex || ""),
    replace_string: String(
      rule?.replace_string ?? rule?.replaceString ?? "",
    ),
    trim_strings: Array.isArray(rule?.trim_strings)
      ? rule.trim_strings.map((item) => String(item || ""))
      : typeof rule?.trim_strings === "string"
        ? rule.trim_strings
        : "",
    source: {
      user_input:
        rule?.source?.user_input === undefined
          ? true
          : Boolean(rule.source.user_input),
      ai_output:
        rule?.source?.ai_output === undefined
          ? true
          : Boolean(rule.source.ai_output),
    },
    destination: {
      prompt:
        rule?.destination?.prompt === undefined
          ? true
          : Boolean(rule.destination.prompt),
      display: Boolean(rule?.destination?.display),
    },
    min_depth: Number.isFinite(Number(rule?.min_depth))
      ? Number(rule.min_depth)
      : 0,
    max_depth: Number.isFinite(Number(rule?.max_depth))
      ? Number(rule.max_depth)
      : 9999,
  };
}

function normalizeTaskProfilesState(taskProfiles = {}) {
  return ensureTaskProfiles({ taskProfiles });
}

function getDefaultProfileDescription(taskType) {
  return TASK_TYPE_META[taskType]?.description || "";
}

export function createPromptBlockId(taskType = "task") {
  return createUniqueId(`${taskType}-block`);
}

export function createRegexRuleId(taskType = "task") {
  return createUniqueId(`${taskType}-rule`);
}

export function createProfileId(taskType = "task") {
  return createUniqueId(`${taskType}-profile`);
}

export function createDefaultTaskProfiles() {
  const profiles = {};
  for (const taskType of TASK_TYPES) {
    profiles[taskType] = {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultTaskProfile(taskType)],
    };
  }
  return profiles;
}

function buildDefaultTaskProfileBlocks(taskType) {
  const defaults = DEFAULT_TASK_BLOCKS[taskType] || {};
  const blueprints = [
    ...COMMON_DEFAULT_BLOCK_BLUEPRINTS,
    ...(TASK_CONTEXT_BLOCK_BLUEPRINTS[taskType] || []),
    ...DEFAULT_TRAILING_BLOCK_BLUEPRINTS,
  ];

  return blueprints.map((blueprint, index) => ({
    id: blueprint.id,
    name: blueprint.name,
    type: blueprint.type,
    enabled: true,
    role: blueprint.role,
    sourceKey: blueprint.sourceKey || "",
    sourceField: "",
    content:
      blueprint.type === "custom"
        ? String(defaults?.[blueprint.contentKey] || "")
        : "",
    injectionMode: "relative",
    order: index,
  }));
}

function mergeDefaultTaskProfileBlocks(taskType, existingBlocks = []) {
  const canonicalBlocks = buildDefaultTaskProfileBlocks(taskType);
  const existingById = new Map(
    (Array.isArray(existingBlocks) ? existingBlocks : [])
      .filter((block) => block && typeof block === "object")
      .map((block) => [String(block.id || ""), block]),
  );
  const merged = canonicalBlocks.map((canonicalBlock, index) => {
    const existing = existingById.get(canonicalBlock.id);
    if (!existing) {
      return {
        ...canonicalBlock,
        order: Number.isFinite(Number(canonicalBlock.order)) ? Number(canonicalBlock.order) : index,
      };
    }

    return {
      ...canonicalBlock,
      ...existing,
      id: canonicalBlock.id,
      name:
        typeof existing.name === "string" && existing.name
          ? existing.name
          : canonicalBlock.name,
      type: canonicalBlock.type,
      role: canonicalBlock.role,
      sourceKey: canonicalBlock.sourceKey || "",
      content:
        canonicalBlock.type === "custom"
          ? typeof existing.content === "string"
            ? existing.content
            : canonicalBlock.content
          : typeof existing.content === "string"
            ? existing.content
            : "",
      injectionMode:
        typeof existing.injectionMode === "string" && existing.injectionMode
          ? existing.injectionMode
          : canonicalBlock.injectionMode,
      order: Number.isFinite(Number(existing.order)) ? Number(existing.order) : index,
    };
  });

  const canonicalIds = new Set(canonicalBlocks.map((block) => block.id));
  const extraBlocks = (Array.isArray(existingBlocks) ? existingBlocks : [])
    .filter((block) => block && typeof block === "object")
    .filter((block) => !canonicalIds.has(String(block.id || "")))
    .map((block, index) => ({
      ...block,
      order: Number.isFinite(Number(block.order)) ? Number(block.order) : canonicalBlocks.length + index,
    }));

  return [...merged, ...extraBlocks];
}

export function createDefaultTaskProfile(taskType) {
  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  return {
    id: DEFAULT_PROFILE_ID,
    name: "默认预设",
    taskType,
    version: DEFAULT_TASK_PROFILE_VERSION,
    builtin: true,
    enabled: true,
    description: getDefaultProfileDescription(taskType),
    promptMode: "block-based",
    updatedAt: nowIso(),
    blocks: buildDefaultTaskProfileBlocks(taskType),
    generation: {
      max_context_tokens: null,
      max_completion_tokens: null,
      reply_count: null,
      stream: true,
      temperature: null,
      top_p: null,
      top_k: null,
      top_a: null,
      min_p: null,
      seed: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
      squash_system_messages: null,
      reasoning_effort: ["extract", "recall", "consolidation"].includes(taskType) ? "low" : null,
      request_thoughts: null,
      enable_function_calling: null,
      enable_web_search: null,
      character_name_prefix: null,
      wrap_user_messages_in_quotes: null,
    },
    regex: {
      enabled: true,
      inheritStRegex: true,
      sources: {
        global: true,
        preset: true,
        character: true,
      },
      stages: {
        finalPrompt: true,
        "input.userMessage": false,
        "input.recentMessages": false,
        "input.candidateText": false,
        "input.finalPrompt": false,
        rawResponse: false,
        beforeParse: false,
        "output.rawResponse": false,
        "output.beforeParse": false,
      },
      localRules: [],
    },
    metadata: {
      migratedFromLegacy: false,
      legacyPromptField,
    },
  };
}

export function createCustomPromptBlock(taskType, overrides = {}) {
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: "自定义块",
    type: "custom",
    enabled: true,
    role: "system",
    sourceKey: "",
    sourceField: "",
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createBuiltinPromptBlock(taskType, sourceKey = "", overrides = {}) {
  const definition =
    BUILTIN_BLOCK_DEFINITIONS.find((item) => item.sourceKey === sourceKey) ||
    BUILTIN_BLOCK_DEFINITIONS[0];
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: definition?.name || "内置块",
    type: "builtin",
    enabled: true,
    role: definition?.role || "system",
    sourceKey: definition?.sourceKey || sourceKey,
    sourceField: "",
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createLegacyPromptBlock(taskType, overrides = {}) {
  const legacyField = LEGACY_PROMPT_FIELD_MAP[taskType] || "";
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: "默认提示词",
    type: "legacyPrompt",
    enabled: true,
    role: "system",
    sourceKey: "",
    sourceField: legacyField,
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createLocalRegexRule(taskType, overrides = {}) {
  return normalizeRegexLocalRule(
    {
      id: createRegexRuleId(taskType),
      script_name: "本地规则",
      enabled: true,
      find_regex: "",
      replace_string: "",
      trim_strings: "",
      source: {
        user_input: true,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
      min_depth: 0,
      max_depth: 9999,
      ...overrides,
    },
    taskType,
    0,
  );
}

export function ensureTaskProfiles(settings = {}) {
  const existing = settings.taskProfiles;
  const defaults = createDefaultTaskProfiles();

  if (!existing || typeof existing !== "object") {
    return defaults;
  }

  const normalized = {};
  for (const taskType of TASK_TYPES) {
    const current = existing[taskType] || {};
    const defaultBucket = defaults[taskType];
    const profiles =
      Array.isArray(current.profiles) && current.profiles.length > 0
        ? current.profiles.map((profile) =>
            normalizeTaskProfile(taskType, profile, settings),
          )
        : defaultBucket.profiles;

    const activeProfileId =
      typeof current.activeProfileId === "string" &&
      profiles.some((profile) => profile.id === current.activeProfileId)
        ? current.activeProfileId
        : profiles[0]?.id || DEFAULT_PROFILE_ID;

    normalized[taskType] = {
      activeProfileId,
      profiles,
    };
  }

  return normalized;
}

export function normalizeTaskProfile(taskType, profile = {}, settings = {}) {
  const base = createDefaultTaskProfile(taskType);
  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  const isBuiltinDefaultProfile =
    String(profile?.id || base.id) === DEFAULT_PROFILE_ID &&
    profile?.builtin !== false;
  const rawBlocks =
    Array.isArray(profile.blocks) && profile.blocks.length > 0
      ? isBuiltinDefaultProfile
        ? mergeDefaultTaskProfileBlocks(taskType, profile.blocks)
        : profile.blocks
      : base.blocks;
  const blocks = rawBlocks.map((block, index) =>
    normalizePromptBlock(taskType, block, index),
  );

  return {
    ...base,
    ...profile,
    id: String(profile?.id || base.id),
    name: String(profile?.name || base.name),
    taskType,
    builtin:
      profile?.builtin === undefined
        ? profile?.id === DEFAULT_PROFILE_ID
        : Boolean(profile?.builtin),
    enabled: profile?.enabled !== false,
    description:
      typeof profile?.description === "string"
        ? profile.description
        : base.description,
    promptMode: String(profile?.promptMode || base.promptMode),
    updatedAt:
      typeof profile?.updatedAt === "string" && profile.updatedAt
        ? profile.updatedAt
        : nowIso(),
    blocks,
    generation: {
      ...base.generation,
      ...(profile?.generation || {}),
    },
    regex: {
      ...base.regex,
      ...(profile?.regex || {}),
      sources: {
        ...base.regex.sources,
        ...(profile?.regex?.sources || {}),
      },
      stages: {
        ...base.regex.stages,
        ...(profile?.regex?.stages || {}),
      },
      localRules: Array.isArray(profile?.regex?.localRules)
        ? profile.regex.localRules.map((rule, index) =>
            normalizeRegexLocalRule(rule, taskType, index),
          )
        : [],
    },
    metadata: {
      ...base.metadata,
      ...(profile?.metadata || {}),
      legacyPromptField,
      legacyPromptSnapshot:
        typeof settings?.[legacyPromptField] === "string"
          ? settings[legacyPromptField]
          : "",
    },
  };
}

export function migrateLegacyTaskProfiles(settings = {}) {
  const alreadyMigrated =
    Number(settings.taskProfilesVersion) >= DEFAULT_TASK_PROFILE_VERSION;
  const nextTaskProfiles = ensureTaskProfiles(settings);
  let changed = !alreadyMigrated;

  for (const taskType of TASK_TYPES) {
    const legacyField = LEGACY_PROMPT_FIELD_MAP[taskType];
    const legacyPrompt =
      typeof settings?.[legacyField] === "string" ? settings[legacyField] : "";
    const bucket = nextTaskProfiles[taskType];
    if (!bucket || !Array.isArray(bucket.profiles) || bucket.profiles.length === 0) {
      nextTaskProfiles[taskType] = {
        activeProfileId: DEFAULT_PROFILE_ID,
        profiles: [createDefaultTaskProfile(taskType)],
      };
      changed = true;
      continue;
    }

    const firstProfile = bucket.profiles[0];
    if (
      firstProfile?.id === DEFAULT_PROFILE_ID &&
      firstProfile?.metadata?.migratedFromLegacy !== true &&
      legacyPrompt
    ) {
      firstProfile.metadata = {
        ...(firstProfile.metadata || {}),
        migratedFromLegacy: true,
        legacyPromptField: legacyField,
        legacyPromptSnapshot: legacyPrompt,
      };
      changed = true;
    }
  }

  return {
    changed,
    taskProfilesVersion: DEFAULT_TASK_PROFILE_VERSION,
    taskProfiles: nextTaskProfiles,
  };
}

export function getActiveTaskProfile(settings = {}, taskType) {
  const taskProfiles = ensureTaskProfiles(settings);
  const bucket = taskProfiles?.[taskType];
  if (!bucket?.profiles?.length) {
    return createDefaultTaskProfile(taskType);
  }
  return (
    bucket.profiles.find((profile) => profile.id === bucket.activeProfileId) ||
    bucket.profiles[0]
  );
}

export function getLegacyPromptForTask(settings = {}, taskType) {
  const field = LEGACY_PROMPT_FIELD_MAP[taskType];
  return typeof settings?.[field] === "string" ? settings[field] : "";
}

export function getLegacyPromptFieldForTask(taskType) {
  return LEGACY_PROMPT_FIELD_MAP[taskType] || "";
}

export function getTaskTypeMeta(taskType) {
  return {
    id: taskType,
    label: TASK_TYPE_META[taskType]?.label || taskType,
    description: TASK_TYPE_META[taskType]?.description || "",
  };
}

export function getTaskTypeOptions() {
  return TASK_TYPES.map((taskType) => getTaskTypeMeta(taskType));
}

export function getTaskTypes() {
  return [...TASK_TYPES];
}

export function getBuiltinBlockDefinitions() {
  return BUILTIN_BLOCK_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function cloneTaskProfile(profile = {}, options = {}) {
  const taskType = String(options.taskType || profile.taskType || "extract");
  const cloned = normalizeTaskProfile(taskType, cloneJson(profile));
  const nextName = String(options.name || "").trim() || `${cloned.name} 副本`;
  const nextProfile = {
    ...cloned,
    id: createProfileId(taskType),
    taskType,
    name: nextName,
    builtin: false,
    updatedAt: nowIso(),
    blocks: (Array.isArray(cloned.blocks) ? cloned.blocks : []).map(
      (block, index) =>
        normalizePromptBlock(
          taskType,
          {
            ...block,
            id: createPromptBlockId(taskType),
            order: index,
          },
          index,
        ),
    ),
    regex: {
      ...(cloned.regex || {}),
      localRules: Array.isArray(cloned?.regex?.localRules)
        ? cloned.regex.localRules.map((rule, index) =>
            normalizeRegexLocalRule(
              {
                ...rule,
                id: createRegexRuleId(taskType),
              },
              taskType,
              index,
            ),
          )
        : [],
    },
    metadata: {
      ...(cloned.metadata || {}),
      clonedFromId: cloned.id || "",
      clonedAt: nowIso(),
    },
  };

  return nextProfile;
}

export function upsertTaskProfile(
  taskProfiles = {},
  taskType,
  profile,
  options = {},
) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType] || {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [],
  };
  const normalizedProfile = normalizeTaskProfile(taskType, {
    ...(profile || {}),
    updatedAt: nowIso(),
  });
  const nextProfiles = [...bucket.profiles];
  const existingIndex = nextProfiles.findIndex(
    (item) => item.id === normalizedProfile.id,
  );

  if (existingIndex >= 0) {
    nextProfiles.splice(existingIndex, 1, normalizedProfile);
  } else if (normalizedProfile.id === DEFAULT_PROFILE_ID) {
    nextProfiles.unshift(normalizedProfile);
  } else {
    nextProfiles.push(normalizedProfile);
  }

  normalizedState[taskType] = {
    activeProfileId:
      options.setActive === false
        ? bucket.activeProfileId
        : normalizedProfile.id,
    profiles: nextProfiles.map((item, index) =>
      normalizeTaskProfile(taskType, {
        ...item,
        blocks: Array.isArray(item.blocks)
          ? item.blocks.map((block, blockIndex) => ({
              ...block,
              order: Number.isFinite(Number(block?.order))
                ? Number(block.order)
                : blockIndex,
            }))
          : [],
        builtin: item.id === DEFAULT_PROFILE_ID ? true : item.builtin,
        updatedAt:
          item.id === normalizedProfile.id ? normalizedProfile.updatedAt : item.updatedAt,
      }),
    ),
  };

  return normalizedState;
}

export function setActiveTaskProfileId(taskProfiles = {}, taskType, profileId) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  if (!bucket?.profiles?.some((profile) => profile.id === profileId)) {
    return normalizedState;
  }
  normalizedState[taskType] = {
    ...bucket,
    activeProfileId: profileId,
  };
  return normalizedState;
}

export function deleteTaskProfile(taskProfiles = {}, taskType, profileId) {
  if (!profileId) return normalizeTaskProfilesState(taskProfiles);

  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  if (!bucket?.profiles?.length) {
    return normalizedState;
  }

  const remaining = bucket.profiles.filter((profile) => profile.id !== profileId);
  if (remaining.length === 0) {
    normalizedState[taskType] = {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultTaskProfile(taskType)],
    };
    return normalizedState;
  }

  normalizedState[taskType] = {
    activeProfileId: remaining.some(
      (profile) => profile.id === bucket.activeProfileId,
    )
      ? bucket.activeProfileId
      : remaining[0].id,
    profiles: remaining,
  };
  return normalizedState;
}

export function restoreDefaultTaskProfile(taskProfiles = {}, taskType) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType] || {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [],
  };
  const defaultProfile = createDefaultTaskProfile(taskType);
  const remaining = (bucket.profiles || []).filter(
    (profile) => profile.id !== DEFAULT_PROFILE_ID,
  );

  normalizedState[taskType] = {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [defaultProfile, ...remaining],
  };

  return normalizedState;
}

export function exportTaskProfile(taskProfiles = {}, taskType, profileId = "") {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  const profile =
    bucket?.profiles?.find((item) => item.id === profileId) ||
    bucket?.profiles?.[0];

  if (!profile) {
    throw new Error(`Task profile not found: ${taskType}/${profileId}`);
  }

  return {
    format: "st-bme-task-profile",
    version: DEFAULT_TASK_PROFILE_VERSION,
    taskType,
    exportedAt: nowIso(),
    profile: cloneJson(profile),
  };
}

export function importTaskProfile(
  taskProfiles = {},
  rawInput,
  preferredTaskType = "",
) {
  const parsed =
    typeof rawInput === "string" ? JSON.parse(rawInput) : cloneJson(rawInput);
  const candidate =
    parsed?.profile && typeof parsed.profile === "object"
      ? parsed.profile
      : parsed;
  const importedTaskType = String(
    preferredTaskType || parsed?.taskType || candidate?.taskType || "",
  ).trim();

  if (!TASK_TYPES.includes(importedTaskType)) {
    throw new Error(`Unsupported task type: ${importedTaskType || "(empty)"}`);
  }

  const bucket = normalizeTaskProfilesState(taskProfiles)[importedTaskType];
  const baseName = String(candidate?.name || "").trim() || "导入预设";
  const importedProfile = normalizeTaskProfile(importedTaskType, {
    ...candidate,
    id: createProfileId(importedTaskType),
    taskType: importedTaskType,
    name: baseName,
    builtin: false,
    updatedAt: nowIso(),
    metadata: {
      ...(candidate?.metadata || {}),
      importedAt: nowIso(),
    },
    blocks: Array.isArray(candidate?.blocks) && candidate.blocks.length > 0
      ? candidate.blocks.map((block, index) => ({
          ...block,
          id: createPromptBlockId(importedTaskType),
          order: index,
        }))
      : createDefaultTaskProfile(importedTaskType).blocks,
    regex: {
      ...(candidate?.regex || {}),
      localRules: Array.isArray(candidate?.regex?.localRules)
        ? candidate.regex.localRules.map((rule) => ({
            ...rule,
            id: createRegexRuleId(importedTaskType),
          }))
        : [],
    },
  });

  const nextTaskProfiles = upsertTaskProfile(
    {
      ...normalizeTaskProfilesState(taskProfiles),
      [importedTaskType]: bucket,
    },
    importedTaskType,
    importedProfile,
    { setActive: true },
  );

  return {
    taskProfiles: nextTaskProfiles,
    taskType: importedTaskType,
    profile: importedProfile,
  };
}
