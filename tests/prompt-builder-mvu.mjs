import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__promptBuilderMvuExtensionSettings || {};",
  "export function getContext() {",
  "  return globalThis.__promptBuilderMvuContext || {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: [],",
  "    characterId: null,",
  "    name1: '',",
  "    name2: '',",
  "    chatId: 'mvu-test-chat',",
  "  };",
  "}",
].join("\n");
const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return { 'Content-Type': 'application/json' };",
  "}",
].join("\n");
const openAiShimSource = [
  "export const chat_completion_sources = { CUSTOM: 'custom', OPENAI: 'openai' };",
  "export async function sendOpenAIRequest(...args) {",
  "  if (typeof globalThis.__promptBuilderMvuSendOpenAIRequest === 'function') {",
  "    return await globalThis.__promptBuilderMvuSendOpenAIRequest(...args);",
  "  }",
  "  return { choices: [{ message: { content: '{}' } }] };",
  "}",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(extensionsShimSource)}`,
      };
    }
    if (specifier === "../../../../script.js") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(scriptShimSource)}`,
      };
    }
    if (specifier === "../../../openai.js") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(openAiShimSource)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
const originalExtensionSettings = globalThis.__promptBuilderMvuExtensionSettings;
const originalContext = globalThis.__promptBuilderMvuContext;
const originalSendOpenAIRequest = globalThis.__promptBuilderMvuSendOpenAIRequest;
const originalFetch = globalThis.fetch;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;

globalThis.require = require;
globalThis.__promptBuilderMvuExtensionSettings = {
  st_bme: {},
};
globalThis.__promptBuilderMvuContext = {
  chat: [],
  chatMetadata: {},
  extensionSettings: {},
  powerUserSettings: {},
  characters: [],
  characterId: null,
  name1: "User",
  name2: "Alice",
  chatId: "mvu-test-chat",
};

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  strategyType = "constant",
  keys = [],
  enabled = true,
  order = 10,
}) {
  return {
    uid,
    name,
    comment,
    content,
    enabled,
    position: {
      type: "before_character_definition",
      role: "system",
      depth: 0,
      order,
    },
    strategy: {
      type: strategyType,
      keys,
      keys_secondary: { logic: "and_any", keys: [] },
    },
    probability: 100,
    extra: {},
  };
}

try {
  const extensionsApi = await import("../../../../extensions.js");
  const { createDefaultTaskProfiles } = await import("../prompt-profiles.js");
  const {
    buildTaskExecutionDebugContext,
    buildTaskLlmPayload,
    buildTaskPrompt,
  } = await import("../prompt-builder.js");
  const llm = await import("../llm.js");

  function createRule(id, findRegex, replaceString) {
    return {
      id,
      script_name: id,
      enabled: true,
      find_regex: findRegex,
      replace_string: replaceString,
      source: {
        user_input: true,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
    };
  }

  function buildSettings() {
    const taskProfiles = createDefaultTaskProfiles();
    const recallProfile = taskProfiles.recall.profiles[0];
    recallProfile.generation = {
      ...recallProfile.generation,
      stream: false,
    };
    recallProfile.regex = {
      enabled: true,
      inheritStRegex: false,
      sources: {
        global: false,
        preset: false,
        character: false,
      },
      stages: {
        "input.userMessage": true,
        "input.recentMessages": true,
        "input.candidateText": true,
        "input.finalPrompt": true,
      },
      localRules: [
        createRule("user-rule", "/BAD_USER/g", "GOOD_USER"),
        createRule("recent-rule", "/BAD_RECENT/g", "GOOD_RECENT"),
        createRule("candidate-rule", "/BAD_CANDIDATE/g", "GOOD_CANDIDATE"),
        createRule("final-rule", "/FINAL_BAD/g", "FINAL_GOOD"),
      ],
    };
    recallProfile.blocks.push({
      id: "mvu-final-custom",
      name: "最终检查块",
      type: "custom",
      enabled: true,
      role: "system",
      sourceKey: "",
      sourceField: "",
      content: "FINAL_BAD",
      injectionMode: "append",
      order: recallProfile.blocks.length,
    });
    recallProfile.blocks.push({
      id: "mvu-chat-custom",
      name: "聊天对象检查",
      type: "custom",
      enabled: true,
      role: "system",
      sourceKey: "",
      sourceField: "",
      content: "聊天对象 {{chatMessages}}",
      injectionMode: "append",
      order: recallProfile.blocks.length,
    });

    return {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-mvu-secret",
      llmModel: "gpt-mvu-test",
      timeoutMs: 4321,
      taskProfilesVersion: 3,
      taskProfiles,
    };
  }

  const settings = buildSettings();
  extensionsApi.extension_settings.st_bme = settings;
  delete globalThis.__stBmeRuntimeDebugState;

  const promptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    charDescription: "角色设定 <StatusPlaceHolderImpl/> BAD_RECENT",
    userPersona: "变量更新规则:\ntype: state\n当前时间: 12:00",
    recentMessages:
      "最近消息 <status_current_variable>hp=3</status_current_variable> BAD_RECENT",
    chatMessages: [
      {
        role: "assistant",
        content: "聊天内容 BAD_RECENT",
        variables: {
          0: {
            stat_data: { hp: [3, "状态更新"] },
            display_data: { hp: "2->3" },
            delta_data: { hp: "2->3" },
          },
        },
        debugStatus: "{{get_message_variable::display_data.hp}} BAD_RECENT",
      },
    ],
    userMessage:
      "用户输入 <updatevariable>secret</updatevariable> {{get_message_variable::stat_data.hp}} BAD_USER",
    candidateNodes: [
      {
        id: "node-1",
        summary: "候选节点 BAD_CANDIDATE <StatusPlaceHolderImpl/>",
        variables: {
          0: {
            stat_data: { 地点: "学校" },
            display_data: { 地点: "教室" },
          },
        },
        note: "{{get_message_variable::stat_data.地点}} BAD_CANDIDATE",
      },
    ],
    candidateText:
      "候选节点 BAD_CANDIDATE {{get_message_variable::stat_data.地点}}",
    graphStats: "candidate_count=1",
  });

  assert.match(promptBuild.systemPrompt, /GOOD_RECENT/);
  assert.match(JSON.stringify(promptBuild.executionMessages), /GOOD_CANDIDATE/);
  assert.match(promptBuild.systemPrompt, /FINAL_BAD/);
  assert.doesNotMatch(promptBuild.systemPrompt, /FINAL_GOOD/);
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) => entry.name === "userMessage"),
    true,
  );
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) =>
      String(entry.name || "").startsWith("candidateNodes[0].variables"),
    ),
    true,
  );
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) =>
      String(entry.name || "").startsWith("chatMessages[0].variables"),
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(promptBuild),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.equal(promptBuild.debug.mvu.sanitizedFieldCount >= 4, true);
  assert.equal(promptBuild.debug.mvu.finalMessageStripCount >= 1, true);
  assert.equal(Array.isArray(promptBuild.regexInput?.entries), true);
  assert.equal(promptBuild.regexInput.entries.length > 0, true);

  const systemOnlySettings = buildSettings();
  systemOnlySettings.taskProfiles.recall = {
    activeProfileId: "system-only",
    profiles: [
      {
        id: "system-only",
        name: "system only",
        taskType: "recall",
        builtin: false,
        blocks: [
          {
            id: "only-system",
            name: "Only System",
            type: "custom",
            enabled: true,
            role: "system",
            sourceKey: "",
            sourceField: "",
            content: "系统块",
            injectionMode: "append",
            order: 0,
          },
        ],
        generation: createDefaultTaskProfiles().recall.profiles[0].generation,
        regex: {
          enabled: false,
          inheritStRegex: false,
          stages: {},
          localRules: [],
        },
      },
    ],
  };

  const systemOnlyPromptBuild = await buildTaskPrompt(systemOnlySettings, "recall", {
    taskName: "recall",
  });
  const systemOnlyPayload = buildTaskLlmPayload(
    systemOnlyPromptBuild,
    "fallback <updatevariable>hidden</updatevariable> text",
  );
  assert.equal(systemOnlyPayload.userPrompt, "fallback text");

  const rawWorldInfoEntries = [
    createWorldbookEntry({
      uid: 101,
      name: "raw-trigger",
      comment: "原始触发命中",
      content: "世界书原始触发成功。",
      strategyType: "selective",
      keys: ["星火密令"],
      order: 10,
    }),
    createWorldbookEntry({
      uid: 102,
      name: "raw-ejs",
      comment: "原始 EJS 命中",
      content:
        '<%= user_input.includes("星火密令") ? "EJS 看到了原始 MVU 信号。" : "EJS 丢失了原始 MVU 信号。" %>',
      order: 20,
    }),
  ];

  globalThis.getCharWorldbookNames = () => ({
    primary: "mvu-raw-worldbook",
    additional: [],
  });
  globalThis.getWorldbook = async (worldbookName) =>
    worldbookName === "mvu-raw-worldbook" ? rawWorldInfoEntries : [];
  globalThis.getLorebookEntries = async (worldbookName) =>
    (worldbookName === "mvu-raw-worldbook" ? rawWorldInfoEntries : []).map(
      (entry) => ({
        uid: entry.uid,
        comment: entry.comment,
      }),
    );
  globalThis.__promptBuilderMvuContext = {
    ...globalThis.__promptBuilderMvuContext,
    chatId: "mvu-raw-trigger-chat",
    chatMetadata: {},
    extensionSettings: {},
    powerUserSettings: {},
  };

  const rawWorldInfoSettings = buildSettings();
  rawWorldInfoSettings.taskProfiles.recall = {
    activeProfileId: "raw-worldinfo",
    profiles: [
      {
        id: "raw-worldinfo",
        name: "raw worldinfo",
        taskType: "recall",
        builtin: false,
        blocks: [
          {
            id: "wi-before",
            name: "世界书前块",
            type: "builtin",
            enabled: true,
            role: "system",
            sourceKey: "worldInfoBefore",
            sourceField: "",
            content: "",
            injectionMode: "append",
            order: 0,
          },
          {
            id: "recent-messages",
            name: "最近消息",
            type: "builtin",
            enabled: true,
            role: "system",
            sourceKey: "recentMessages",
            sourceField: "",
            content: "",
            injectionMode: "append",
            order: 1,
          },
        ],
        generation: createDefaultTaskProfiles().recall.profiles[0].generation,
        regex: {
          enabled: false,
          inheritStRegex: false,
          stages: {},
          localRules: [],
        },
      },
    ],
  };

  const rawWorldInfoPromptBuild = await buildTaskPrompt(rawWorldInfoSettings, "recall", {
    taskName: "recall",
    recentMessages: "最近消息",
    userMessage:
      "继续 <status_current_variable>星火密令</status_current_variable>",
    chatMessages: [],
  });

  assert.match(rawWorldInfoPromptBuild.systemPrompt, /世界书原始触发成功/);
  assert.match(rawWorldInfoPromptBuild.systemPrompt, /EJS 看到了原始 MVU 信号/);
  assert.doesNotMatch(
    rawWorldInfoPromptBuild.systemPrompt,
    /status_current_variable/i,
  );
  assert.equal(
    rawWorldInfoPromptBuild.debug.effectivePath?.worldInfoInputContext,
    "raw-context-for-trigger-and-ejs",
  );

  const capturedBodies = [];
  globalThis.fetch = async (_url, options = {}) => {
    capturedBodies.push(JSON.parse(String(options.body || "{}")));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"ok":true}',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const payload = buildTaskLlmPayload(promptBuild, "unused fallback");
  assert.equal(payload.systemPrompt, "");
  assert.match(JSON.stringify(payload.promptMessages), /FINAL_BAD/);
  assert.doesNotMatch(JSON.stringify(payload.promptMessages), /FINAL_GOOD/);
  const result = await llm.callLLMForJSON({
    systemPrompt: payload.systemPrompt,
    userPrompt: payload.userPrompt,
    maxRetries: 0,
    taskType: "recall",
    promptMessages: payload.promptMessages,
    additionalMessages: payload.additionalMessages,
    debugContext: buildTaskExecutionDebugContext(promptBuild),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(capturedBodies.length, 1);
  assert.match(JSON.stringify(capturedBodies[0].messages), /FINAL_GOOD/);
  assert.doesNotMatch(JSON.stringify(capturedBodies[0].messages), /FINAL_BAD/);
  assert.doesNotMatch(
    JSON.stringify(capturedBodies[0].messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );

  const runtimePromptBuild =
    globalThis.__stBmeRuntimeDebugState?.taskPromptBuilds?.recall || null;
  const runtimeLlmRequest =
    globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.recall || null;

  assert.ok(runtimePromptBuild);
  assert.ok(runtimeLlmRequest);
  assert.match(JSON.stringify(runtimeLlmRequest.messages), /FINAL_GOOD/);
  assert.equal(runtimeLlmRequest.requestCleaning?.applied, true);
  assert.equal(
    runtimeLlmRequest.requestCleaning?.stages?.length > 0,
    true,
  );
  assert.equal(
    runtimeLlmRequest.requestCleaning?.stages?.every(
      (entry) => entry.stage === "input.finalPrompt",
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimePromptBuild.executionMessages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.requestBody?.messages || []),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.deepEqual(
    runtimeLlmRequest.messages,
    runtimeLlmRequest.requestBody.messages,
  );
  assert.equal(
    runtimeLlmRequest.promptExecution?.mvu?.sanitizedFieldCount,
    promptBuild.debug.mvu.sanitizedFieldCount,
  );

  // ── 新增测试：passive mode 字段族不被整段 drop ───────────────────────────────

  // helpers
  function buildExtractSettings() {
    const taskProfiles = createDefaultTaskProfiles();
    return {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "gpt-test",
      timeoutMs: 4321,
      taskProfilesVersion: 3,
      taskProfiles,
    };
  }

  function buildExtractBlock(id, name, sourceKey, order) {
    return {
      id,
      name,
      type: "builtin",
      enabled: true,
      role: "system",
      sourceKey,
      sourceField: "",
      content: "",
      injectionMode: "relative",
      order,
    };
  }

  function buildMinimalExtractSettings() {
    const base = buildExtractSettings();
    base.taskProfiles.extract = {
      activeProfileId: "extract-passive-test",
      profiles: [
        {
          id: "extract-passive-test",
          name: "passive test",
          taskType: "extract",
          builtin: false,
          version: 3,
          enabled: true,
          blocks: [
            buildExtractBlock("blk-char", "charDescription", "charDescription", 0),
            buildExtractBlock("blk-persona", "userPersona", "userPersona", 1),
            buildExtractBlock("blk-recent", "recentMessages", "recentMessages", 2),
            buildExtractBlock("blk-candidate", "candidateText", "candidateText", 3),
          ],
          generation: createDefaultTaskProfiles().extract.profiles[0].generation,
          regex: { enabled: false, inheritStRegex: false, stages: {}, localRules: [] },
        },
      ],
    };
    return base;
  }

  // 测试 1：recentMessages 含多次 getvar 宏 — 不被整段 drop，宏被剥离
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const s = buildMinimalExtractSettings();
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "#0 [assistant]: {{get_message_variable::stat_data.hp}} 今晚的气氛很好。{{get_message_variable::display_data.mood}}",
      charDescription: "普通角色描述，不含 MVU。",
      userPersona: "普通用户设定。",
      candidateText: "",
    });
    const rendered = JSON.stringify(pb.executionMessages);
    assert.match(rendered, /今晚的气氛很好/,
      "T1: recentMessages 的叙述文本必须保留");
    assert.doesNotMatch(rendered, /get_message_variable/i,
      "T1: getvar 宏必须被剥离");
    const droppedField = pb.debug.mvu.sanitizedFields.find(
      (e) => e.name === "recentMessages" && e.dropped,
    );
    assert.equal(droppedField, undefined,
      "T1: recentMessages 不应被整段 drop（passive mode）");
  }

  // 测试 2：recentMessages 叙述里提到 stat_data 字样 — 不被整段 drop
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const s = buildMinimalExtractSettings();
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "#0 [assistant]: 墙上的 stat_data 标签被撕掉了，角色叹了口气。",
      charDescription: "",
      userPersona: "",
      candidateText: "",
    });
    const rendered = JSON.stringify(pb.executionMessages);
    assert.match(rendered, /墙上的/,
      "T2: recentMessages 叙述文本必须保留");
    const droppedField = pb.debug.mvu.sanitizedFields.find(
      (e) => e.name === "recentMessages" && e.dropped,
    );
    assert.equal(droppedField, undefined,
      "T2: recentMessages 不应被整段 drop");
  }

  // 测试 3：charDescription 含 MVU 宏 — 不被整段 drop，宏被剥离
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const s = buildMinimalExtractSettings();
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "普通对话。",
      charDescription: "角色叫 Alice。<StatusPlaceHolderImpl/> 她性格温柔。",
      userPersona: "",
      candidateText: "",
    });
    const rendered = JSON.stringify(pb.executionMessages);
    assert.match(rendered, /她性格温柔/,
      "T3: charDescription 叙述文本必须保留");
    assert.doesNotMatch(rendered, /StatusPlaceHolderImpl/i,
      "T3: 占位符必须被剥离");
    const droppedField = pb.debug.mvu.sanitizedFields.find(
      (e) => e.name === "charDescription" && e.dropped,
    );
    assert.equal(droppedField, undefined,
      "T3: charDescription 不应被整段 drop");
  }

  // 测试 4：userPersona 是 MVU 规则内容 — 不被整段 drop
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const s = buildMinimalExtractSettings();
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "普通对话。",
      charDescription: "",
      userPersona: "变量更新规则:\ntype: state\n当前时间: 12:00",
      candidateText: "",
    });
    const rendered = JSON.stringify(pb.executionMessages);
    assert.match(rendered, /变量更新规则/,
      "T4: userPersona 文本必须保留");
    const droppedField = pb.debug.mvu.sanitizedFields.find(
      (e) => e.name === "userPersona" && e.dropped,
    );
    assert.equal(droppedField, undefined,
      "T4: userPersona 不应被整段 drop（passive mode）");
  }

  // 测试 5：candidateNodes 含 stat_data/getvar — 字符串叶子保留，容器键剥离
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const s = buildMinimalExtractSettings();
    s.taskProfiles.extract.profiles[0].blocks.push(
      buildExtractBlock("blk-nodes", "candidateNodes", "candidateNodes", 4),
    );
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "",
      charDescription: "",
      userPersona: "",
      candidateText: "",
      candidateNodes: [
        {
          id: "node-a",
          summary: "这是一个有意义的候选摘要，说明了角色的决定。",
          note: "{{get_message_variable::stat_data.地点}} 某地区的行动。",
          variables: {
            0: {
              stat_data: { 地点: "学校" },
              display_data: { 地点: "教室" },
            },
          },
        },
      ],
    });
    const rendered = JSON.stringify(pb.executionMessages);
    assert.match(rendered, /有意义的候选摘要/,
      "T5: candidateNodes 的 summary 文本必须保留");
    assert.doesNotMatch(rendered, /get_message_variable/i,
      "T5: getvar 宏必须被剥离");
    const containerDropped = pb.debug.mvu.sanitizedFields.find(
      (e) => String(e.name || "").startsWith("candidateNodes[0].variables"),
    );
    assert.ok(containerDropped,
      "T5: stat_data/display_data 容器键必须仍被剥离");
  }

  // 测试 6：world info 仍然 aggressive drop（守卫 6cec031 正收益）
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const mvuWorldbookEntry = [
      createWorldbookEntry({
        uid: 999,
        name: "mvu-statusbar",
        comment: "mvu-statusbar",
        content: "变量输出格式: 严格 <UpdateVariable>\ntype: state\nformat: |-\n  stat_data:",
        strategyType: "constant",
        keys: [],
        order: 1,
      }),
    ];
    globalThis.getCharWorldbookNames = () => ({
      primary: "mvu-guard-worldbook",
      additional: [],
    });
    globalThis.getWorldbook = async (name) =>
      name === "mvu-guard-worldbook" ? mvuWorldbookEntry : [];
    globalThis.getLorebookEntries = async (name) =>
      (name === "mvu-guard-worldbook" ? mvuWorldbookEntry : []).map((e) => ({
        uid: e.uid, comment: e.comment,
      }));
    globalThis.__promptBuilderMvuContext = {
      ...globalThis.__promptBuilderMvuContext,
      chatId: "mvu-guard-chat",
      chatMetadata: {},
    };

    const s = buildExtractSettings();
    // 使用含 worldInfo 块的 extract 默认 profile
    const pb = await buildTaskPrompt(s, "extract", {
      recentMessages: "普通对话，用于触发世界书。",
      userMessage: "普通消息。",
      chatMessages: [],
    });
    const rendered = JSON.stringify(pb);
    assert.doesNotMatch(rendered, /UpdateVariable/,
      "T6: MVU 世界书条目必须仍被 aggressive drop");
  }

  // 测试 6b：warn 路径 — 双断言
  // 构造一个故意用 aggressive mode 且会 drop 的字段（绕过策略表用内部 API）
  // 通过检验 sanitizedFields 中的 dropped + reasons 来验证 warn 的依据已正确记录
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const { sanitizeMvuContent, MVU_SANITIZE_MODES } = await import("../mvu-compat.js");
    assert.ok(MVU_SANITIZE_MODES, "mvu-compat 必须导出 MVU_SANITIZE_MODES");
    assert.equal(MVU_SANITIZE_MODES.AGGRESSIVE, "aggressive",
      "MVU_SANITIZE_MODES.AGGRESSIVE 应为 'aggressive'");
    assert.equal(MVU_SANITIZE_MODES.PASSIVE, "passive",
      "MVU_SANITIZE_MODES.PASSIVE 应为 'passive'");

    // aggressive mode 下 MVU 世界书内容应被 drop
    const aggressiveResult = sanitizeMvuContent(
      "变量输出格式: 严格 <UpdateVariable>\ntype: state\nformat: |-\n  stat_data:",
      { mode: MVU_SANITIZE_MODES.AGGRESSIVE },
    );
    assert.equal(aggressiveResult.dropped, true,
      "T6b: aggressive mode 命中 likely_mvu_content 应 dropped=true");
    assert.ok(aggressiveResult.reasons.includes("likely_mvu_content"),
      "T6b: reasons 应含 likely_mvu_content");

    // passive mode 下相同内容不应被整段 drop
    const passiveResult = sanitizeMvuContent(
      "变量更新规则:\ntype: state\n当前时间: 12:00",
      { mode: MVU_SANITIZE_MODES.PASSIVE },
    );
    assert.equal(passiveResult.dropped, false,
      "T6b: passive mode 不应整段 drop");

    // warn 路径：手动 mock console.warn 验证关键字段清空时 warn 触发
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args);
    try {
      // 构建一个 extract 任务，把一个关键字段故意设成 aggressive 会 drop 的内容
      // 为触发 warn，我们在 sanitizePromptContextInputs 里必须 omit 且原始非空
      // 因为 passive 策略会保留，我们直接用 recentMessages 传入一段
      // 绕过策略表的方式是：在 world info 条目里触发 aggressive（不经过字段策略表）
      // 这里改为：直接测试 sanitizeMvuContent 在 PASSIVE mode 下 dropped=false，即 warn 不触发
      // 然后对 AGGRESSIVE 手动调用相同逻辑，断言 warn 输出
      //
      // 实际场景 warn 触发点：在 sanitizePromptContextInputs 里检测到 CRITICAL 字段 omit
      // 修复后正常场景不应触发；我们用 debug.mvu.sanitizedFields 来断言"字段未被 drop"
      const s2 = buildMinimalExtractSettings();
      const pb2 = await buildTaskPrompt(s2, "extract", {
        recentMessages: "变量更新规则:\ntype: state\n当前时间: 12:00",
        charDescription: "",
        userPersona: "",
        candidateText: "",
      });
      // passive 模式下不应 warn 关键字段 drop
      const criticalDropWarn = warnCalls.find(
        (args) => String(args[0] || "").includes("关键任务输入字段被 MVU 策略清空"),
      );
      assert.equal(criticalDropWarn, undefined,
        "T6b: passive 模式下关键字段不应触发 warn");
      // 且字段不应在 sanitizedFields 中被标记为 dropped
      const recentDropped = pb2.debug.mvu.sanitizedFields.find(
        (e) => e.name === "recentMessages" && e.dropped,
      );
      assert.equal(recentDropped, undefined,
        "T6b: recentMessages 不应在 debug.mvu.sanitizedFields 中 dropped");
    } finally {
      console.warn = originalWarn;
    }
  }

  // 测试 6c：warn 诊断字段包含 reasons 和 before/after preview
  {
    delete globalThis.__stBmeRuntimeDebugState;
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args);
    try {
      const s = buildMinimalExtractSettings();
      await buildTaskPrompt(s, "extract", {
        recentMessages:
          "{{get_message_variable::stat_data.hp}}\n{{get_message_variable::display_data.hp}}",
        charDescription: "",
        userPersona: "",
        candidateText: "",
      });
      const criticalDropWarn = warnCalls.find(
        (args) => String(args[0] || "").includes("关键任务输入字段被 MVU 策略清空"),
      );
      assert.ok(criticalDropWarn, "T6c: 清洗后为空时应触发关键字段 warn");
      assert.equal(criticalDropWarn[1]?.fieldName, "recentMessages",
        "T6c: warn 应指向 recentMessages");
      assert.equal(criticalDropWarn[1]?.mode, "passive",
        "T6c: recentMessages 应以 passive mode 清洗");
      assert.ok(
        Array.isArray(criticalDropWarn[1]?.reasons) &&
          criticalDropWarn[1].reasons.includes("artifact_stripped"),
        "T6c: warn 应携带 artifact_stripped reason",
      );
      assert.match(
        String(criticalDropWarn[1]?.rawPreview || ""),
        /get_message_variable/,
        "T6c: warn 应携带原始内容 preview",
      );
      assert.equal(
        String(criticalDropWarn[1]?.sanitizedPreview || ""),
        "",
        "T6c: 清洗为空时 sanitizedPreview 应为空串",
      );
      assert.ok(
        Number(criticalDropWarn[1]?.artifactRemovedCount || 0) >= 2,
        "T6c: warn 应记录 artifactRemovedCount",
      );
    } finally {
      console.warn = originalWarn;
    }
  }

  console.log("prompt-builder-mvu tests passed");
} finally {
  if (originalRequire === undefined) {
    delete globalThis.require;
  } else {
    globalThis.require = originalRequire;
  }

  if (originalExtensionSettings === undefined) {
    delete globalThis.__promptBuilderMvuExtensionSettings;
  } else {
    globalThis.__promptBuilderMvuExtensionSettings = originalExtensionSettings;
  }

  if (originalContext === undefined) {
    delete globalThis.__promptBuilderMvuContext;
  } else {
    globalThis.__promptBuilderMvuContext = originalContext;
  }

  if (originalSendOpenAIRequest === undefined) {
    delete globalThis.__promptBuilderMvuSendOpenAIRequest;
  } else {
    globalThis.__promptBuilderMvuSendOpenAIRequest = originalSendOpenAIRequest;
  }

  globalThis.fetch = originalFetch;

  if (originalGetWorldbook === undefined) {
    delete globalThis.getWorldbook;
  } else {
    globalThis.getWorldbook = originalGetWorldbook;
  }

  if (originalGetLorebookEntries === undefined) {
    delete globalThis.getLorebookEntries;
  } else {
    globalThis.getLorebookEntries = originalGetLorebookEntries;
  }

  if (originalGetCharWorldbookNames === undefined) {
    delete globalThis.getCharWorldbookNames;
  } else {
    globalThis.getCharWorldbookNames = originalGetCharWorldbookNames;
  }
}
