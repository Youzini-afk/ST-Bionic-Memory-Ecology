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
    description: "注入任务级系统指令。可用于添加通用约束或全局规则，所有任务类型均可使用。",
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
    role: "user",
    description: "注入最近的对话上下文片段。extract 和 recall 任务使用，提供 LLM 分析所需的对话历史。",
  },
  {
    sourceKey: "userMessage",
    name: "用户消息",
    role: "user",
    description: "注入当前用户的最新输入内容。recall 任务使用，用于匹配最相关的记忆节点。",
  },
  {
    sourceKey: "candidateNodes",
    name: "候选节点",
    role: "user",
    description: "注入待筛选的候选记忆节点列表。recall（选择相关节点）和 consolidation（检测冲突）任务使用。",
  },
  {
    sourceKey: "graphStats",
    name: "图统计",
    role: "user",
    description: "注入图谱当前状态摘要（如节点数量、类型分布）。所有任务类型均可使用，帮助 LLM 了解图谱全貌。",
  },
  {
    sourceKey: "currentRange",
    name: "当前范围",
    role: "user",
    description: "注入当前处理的消息楼层范围（如「楼 5 ~ 楼 10」）。extract 和 compress 任务使用。",
  },
  {
    sourceKey: "nodeContent",
    name: "节点内容",
    role: "user",
    description: "注入待压缩的节点正文内容。compress 任务专用，包含需要合并总结的多个节点文本。",
  },
  {
    sourceKey: "eventSummary",
    name: "事件摘要",
    role: "user",
    description: "注入近期事件时间线摘要。synopsis（生成前情提要）和 reflection（生成反思）任务使用。",
  },
  {
    sourceKey: "characterSummary",
    name: "角色摘要",
    role: "user",
    description: "注入近期角色状态变化摘要。synopsis 和 reflection 任务使用，帮助 LLM 了解角色动态。",
  },
  {
    sourceKey: "threadSummary",
    name: "主线摘要",
    role: "user",
    description: "注入当前活跃的故事主线摘要。synopsis 和 reflection 任务使用，帮助 LLM 把握叙事走向。",
  },
  {
    sourceKey: "contradictionSummary",
    name: "矛盾摘要",
    role: "user",
    description: "注入近期检测到的记忆矛盾或冲突信息。reflection 任务专用，触发基于矛盾的深度反思。",
  },
];

const DEFAULT_TASK_PROFILE_VERSION = 1;
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
    role: "你是一个记忆提取分析器。从对话中提取结构化记忆节点并存入知识图谱。",
    format: [
      "输出格式为严格 JSON：",
      "{",
      '  \"thought\": \"你对本段对话的分析（事件/角色变化/新信息）\",',
      '  \"operations\": [',
      "    {",
      '      \"action\": \"create\",',
      '      \"type\": \"event\",',
      '      \"fields\": {\"title\": \"简短事件名\", \"summary\": \"...\", \"participants\": \"...\", \"status\": \"ongoing\"},',
      '      \"importance\": 6,',
      '      \"ref\": \"evt1\",',
      '      \"links\": [',
      '        {\"targetNodeId\": \"existing-id\", \"relation\": \"involved_in\", \"strength\": 0.9}',
      "      ]",
      "    },",
      "    {",
      '      \"action\": \"update\",',
      '      \"nodeId\": \"existing-node-id\",',
      '      \"fields\": {\"state\": \"新的状态\"}',
      "    }",
      "  ]",
      "}",
    ].join("\n"),
    rules: [
      "- 每批对话最多创建 1 个事件节点，多个子事件合并为一条",
      "- 角色/地点节点：如果图中已有同名节点，用 update 而非 create",
      "- 不要虚构内容，只提取对话中有证据支持的信息",
      "- importance 范围 1-10，普通事件 5，关键转折 8+",
      "- event.fields.title 需要是简短事件名，建议 6-18 字，只用于图谱和列表显示",
      "- summary 应该是摘要抽象，不要复制原文",
    ].join("\n"),
  },
  recall: {
    role: "你是一个记忆召回分析器。\n根据用户最新输入和对话上下文，从候选记忆节点中选择最相关的节点。",
    format: '输出严格的 JSON 格式：\n{\"selected_ids\": [\"id1\", \"id2\", ...], \"reason\": \"简要说明选择理由\"}',
    rules: "优先选择：\n  (1) 直接相关的当前场景节点\n  (2) 因果关系连续性节点\n  (3) 有潜在影响的背景节点",
  },
  consolidation: {
    role: "你是一个记忆整合分析器。当新记忆加入知识图谱时，你需要同时完成两项任务：",
    format: [
      "输出严格 JSON：",
      '{ \"results\": [',
      '  { \"node_id\": \"新记忆节点ID\",',
      '    \"action\": \"keep\"|\"merge\"|\"skip\",',
      '    \"merge_target_id\": \"旧节点ID (仅merge)\",',
      '    \"reason\": \"理由\",',
      '    \"evolution\": { \"should_evolve\": true/false, \"connections\": [\"旧记忆ID\"], \"neighbor_updates\": [...] }',
      "  }",
      "] }",
    ].join("\n"),
    rules: [
      "任务一：冲突检测",
      "  - skip: 新记忆与已有记忆完全重复",
      "  - merge: 新记忆是对旧记忆的修正/补充",
      "  - keep: 新记忆是全新信息",
      "",
      "任务二：进化分析（仅 action=keep 时）",
      "  - 建立关联连接",
      "  - 反向更新旧记忆",
    ].join("\n"),
  },
  compress: {
    role: "你是一个记忆压缩器。将多个同类型节点总结为一条更高层级的压缩节点。",
    format: '输出格式为严格 JSON：\n{\"fields\": {\"summary\": \"...\", ...}}',
    rules: "- 保留关键信息：因果关系、不可逆结果、未解决伏笔\n- 去除重复和低信息密度内容\n- 压缩后文本应精炼，目标 150 字左右",
  },
  synopsis: {
    role: "你是故事概要生成器。根据事件线、角色和主线生成简洁的前情提要。",
    format: '输出 JSON：{\"summary\": \"前情提要文本（200字以内）\"}',
    rules: "要求：涵盖核心冲突、关键转折、主要角色当前状态。",
  },
  reflection: {
    role: "你是 RP 长期记忆系统的反思生成器。",
    format: '输出严格 JSON：{\"insight\":\"...\",\"trigger\":\"...\",\"suggestion\":\"...\",\"importance\":1-10}',
    rules: "- insight 应总结最近情节中最值得长期保留的变化、关系趋势或潜在线索\n- trigger 说明触发这条反思的关键事件或矛盾\n- suggestion 给出后续检索或叙事上值得关注的提示\n- 不要复述全部事件，要提炼高层结论",
  },
};

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

export function createDefaultTaskProfile(taskType) {
  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  const defaults = DEFAULT_TASK_BLOCKS[taskType] || {};
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
    blocks: [
      {
        id: "default-role",
        name: "角色定义",
        type: "custom",
        enabled: true,
        role: "system",
        sourceKey: "",
        sourceField: "",
        content: defaults.role || "",
        injectionMode: "append",
        order: 0,
      },
      {
        id: "default-format",
        name: "输出格式",
        type: "custom",
        enabled: true,
        role: "system",
        sourceKey: "",
        sourceField: "",
        content: defaults.format || "",
        injectionMode: "append",
        order: 1,
      },
      {
        id: "default-rules",
        name: "行为规则",
        type: "custom",
        enabled: true,
        role: "system",
        sourceKey: "",
        sourceField: "",
        content: defaults.rules || "",
        injectionMode: "append",
        order: 2,
      },
    ],
    generation: {
      max_context_tokens: null,
      max_completion_tokens: null,
      reply_count: null,
      stream: false,
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
      reasoning_effort: null,
      request_thoughts: null,
      enable_function_calling: null,
      enable_web_search: null,
      character_name_prefix: null,
      wrap_user_messages_in_quotes: null,
    },
    regex: {
      enabled: false,
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
  const blocks =
    Array.isArray(profile.blocks) && profile.blocks.length > 0
      ? profile.blocks.map((block, index) =>
          normalizePromptBlock(taskType, block, index),
        )
      : base.blocks.map((block, index) =>
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
