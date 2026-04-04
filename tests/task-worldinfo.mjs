import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: extensionsShimUrl,
      };
    }
    return nextResolve(specifier, context);
  },
});

const originalSillyTavern = globalThis.SillyTavern;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  enabled = true,
  positionType = "before_character_definition",
  role = "system",
  depth = 0,
  order = 10,
  strategyType = "constant",
  keys = [],
  keysSecondary = [],
}) {
  return {
    uid,
    name,
    comment,
    content,
    enabled,
    position: {
      type: positionType,
      role,
      depth,
      order,
    },
    strategy: {
      type: strategyType,
      keys,
      keys_secondary: { logic: "and_any", keys: keysSecondary },
    },
    probability: 100,
    extra: {},
  };
}

function createConstantWorldbookEntry(uid, name, content, comment = name) {
  return createWorldbookEntry({
    uid,
    name,
    comment,
    content,
  });
}

const constantEntry = createWorldbookEntry({
  uid: 1,
  name: "常驻设定",
  comment: "常驻设定",
  content: "这里是常驻世界设定。",
  order: 10,
});

const dynEntry = createWorldbookEntry({
  uid: 2,
  name: "EW/Dyn/线索",
  comment: "线索条目",
  content: "隐藏线索：<%= charName %> 正在调查。",
  enabled: false,
  strategyType: "selective",
  keys: ["调查"],
  order: 15,
});

const inlineSummaryEntry = createWorldbookEntry({
  uid: 3,
  name: "普通 EJS 汇总",
  comment: "EJS 汇总",
  content: '控制摘要：<%= await getwi("EW/Dyn/线索") %>',
  order: 20,
});

const inlineDataSummaryEntry = createWorldbookEntry({
  uid: 12,
  name: "数据 EJS 汇总",
  comment: "数据 EJS 汇总",
  content:
    '数据摘要：<%= await getwi("数据模板", { clue: "蓝钥匙", mood: "紧张" }) %>',
  order: 21,
});

const inlineDataTemplateEntry = createWorldbookEntry({
  uid: 13,
  name: "数据模板",
  comment: "数据模板",
  content:
    "线索=<%= clue %>；情绪=<%= mood %>；角色=<%= char %>；用户=<%= user %>；上下文=<%= recentMessages %>",
  enabled: false,
  order: 22,
});

const extensionLiteralEntry = createWorldbookEntry({
  uid: 4,
  name: "扩展语义正文",
  comment: "扩展语义正文",
  content: "@@generate\n[GENERATE:Test]\n扩展语义只是普通文本。",
  order: 25,
});

const externalInlineEntry = createWorldbookEntry({
  uid: 5,
  name: "外部书汇总",
  comment: "外部书汇总",
  content: '外部补充：<%= await getwi("bonus-book", "Bonus 条目") %>',
  order: 26,
});

const forceControlEntry = createWorldbookEntry({
  uid: 6,
  name: "普通 EJS 控制",
  comment: "EJS 控制",
  content: '<% await activewi("强制 after") %>',
  order: 30,
});

const forcedAfterEntry = createWorldbookEntry({
  uid: 7,
  name: "强制 after",
  comment: "强制后置",
  content: "这是被 EJS 强制激活的后置条目。",
  positionType: "after_character_definition",
  strategyType: "selective",
  keys: ["永远不会命中"],
  order: 40,
});

const atDepthEntry = createWorldbookEntry({
  uid: 8,
  name: "深度注入",
  comment: "深度注入",
  content: "这是一条 atDepth 消息。",
  positionType: "at_depth_as_system",
  depth: 2,
  order: 5,
});

const mvuTaggedEntry = createWorldbookEntry({
  uid: 9,
  name: "[mvu_update] 状态同步",
  comment: "MVU tagged",
  content: "这一条不应该进入结果。",
  order: 28,
});

const mvuHeuristicEntry = createWorldbookEntry({
  uid: 10,
  name: "MVU 启发式条目",
  comment: "MVU heuristic",
  content: "<status_current_variable>secret=true</status_current_variable>",
  order: 29,
});

const mvuLazyProbeEntry = createWorldbookEntry({
  uid: 11,
  name: "MVU 懒加载探测",
  comment: "MVU 懒加载探测",
  content: 'MVU lazy: <%= await getwi("bonus-book", "Bonus MVU") %>',
  order: 27,
});

const bonusEntry = createWorldbookEntry({
  uid: 101,
  name: "Bonus 条目",
  comment: "Bonus 条目",
  content: "来自 bonus-book 的补充内容。",
  order: 10,
});

const bonusMvuEntry = createWorldbookEntry({
  uid: 102,
  name: "Bonus MVU",
  comment: "Bonus MVU",
  content: "变量更新规则:\ntype: sync\n当前时间: 12:00",
  order: 20,
});

const worldbooksByName = {
  "main-book": [
    constantEntry,
    dynEntry,
    inlineSummaryEntry,
    inlineDataSummaryEntry,
    inlineDataTemplateEntry,
    extensionLiteralEntry,
    externalInlineEntry,
    mvuLazyProbeEntry,
    forceControlEntry,
    forcedAfterEntry,
    atDepthEntry,
    mvuTaggedEntry,
    mvuHeuristicEntry,
  ],
  "bonus-book": [bonusEntry, bonusMvuEntry],
};

try {
  globalThis.SillyTavern = {
    getContext() {
      return {
        name1: "User",
        name2: "Alice",
        chat: [{ is_user: true, mes: "我们继续调查那条线索" }],
        chatMetadata: {},
        extensionSettings: {},
      };
    },
  };
  globalThis.getCharWorldbookNames = () => ({
    primary: "main-book",
    additional: [],
  });
  globalThis.getWorldbook = async (worldbookName) =>
    worldbooksByName[worldbookName] || [];
  globalThis.getLorebookEntries = async (worldbookName) =>
    (worldbooksByName[worldbookName] || []).map((entry) => ({
      uid: entry.uid,
      comment: entry.comment,
    }));

  const { resolveTaskWorldInfo } = await import("../task-worldinfo.js");
  const { buildTaskPrompt } = await import("../prompt-builder.js");

  const emptyTriggerWorldInfo = await resolveTaskWorldInfo({
    chatMessages: [],
    userMessage: "",
    templateContext: {},
  });
  assert.equal(
    emptyTriggerWorldInfo.beforeEntries.some((entry) => entry.name === "常驻设定"),
    true,
    "constant world info should still resolve without trigger text",
  );
  assert.equal(
    emptyTriggerWorldInfo.beforeEntries.some((entry) => entry.name === "数据 EJS 汇总"),
    true,
    "constant EJS entry should still render with empty template context defaults",
  );
  assert.match(emptyTriggerWorldInfo.beforeText, /数据摘要：线索=蓝钥匙；情绪=紧张；角色=Alice；用户=User；上下文=/);
  assert.equal(
    emptyTriggerWorldInfo.debug.warnings.some((warning) => warning.includes("渲染失败")),
    false,
  );

  const worldInfo = await resolveTaskWorldInfo({
    templateContext: {
      recentMessages: "我们继续调查那条线索",
      charName: "Alice",
    },
    userMessage: "继续调查",
  });

  assert.deepEqual(
    worldInfo.beforeEntries.map((entry) => entry.name),
    [
      "常驻设定",
      "EJS 汇总",
      "数据 EJS 汇总",
      "扩展语义正文",
      "外部书汇总",
      "MVU 懒加载探测",
    ],
  );
  assert.deepEqual(worldInfo.afterEntries.map((entry) => entry.name), ["强制后置"]);
  assert.equal(worldInfo.additionalMessages.length, 1);
  assert.equal(worldInfo.additionalMessages[0].content, "这是一条 atDepth 消息。");
  assert.match(worldInfo.beforeText, /控制摘要：隐藏线索：Alice 正在调查。/);
  assert.match(
    worldInfo.beforeText,
    /数据摘要：线索=蓝钥匙；情绪=紧张；角色=Alice；用户=User；上下文=我们继续调查那条线索/,
  );
  assert.match(worldInfo.beforeText, /外部补充：来自 bonus-book 的补充内容。/);
  assert.match(worldInfo.beforeText, /MVU lazy:/);
  assert.match(worldInfo.beforeText, /@@generate/);
  assert.match(worldInfo.beforeText, /\[GENERATE:Test\]/);
  assert.doesNotMatch(worldInfo.beforeText, /getwi|<%=?/);
  assert.doesNotMatch(worldInfo.beforeText, /status_current_variable|变量更新规则|updatevariable/i);
  assert.equal(worldInfo.debug.ejsInlinePullCount, 3);
  assert.equal(worldInfo.debug.ejsForcedActivationCount, 1);
  assert.equal(worldInfo.debug.resolvePassCount >= 2, true);
  assert.deepEqual(worldInfo.debug.forcedActivatedEntries.map((entry) => entry.name), [
    "强制后置",
  ]);
  assert.deepEqual(
    worldInfo.debug.inlinePulledEntries.map((entry) => entry.name).sort(),
    ["Bonus 条目", "数据模板", "线索条目"].sort(),
  );
  assert.deepEqual(worldInfo.debug.lazyLoadedWorldbooks, ["bonus-book"]);
  assert.equal(worldInfo.debug.mvu.filteredEntryCount, 2);
  assert.equal(worldInfo.debug.mvu.lazyFilteredEntryCount, 1);
  assert.equal(worldInfo.debug.mvu.blockedContentsCount, 3);
  assert.deepEqual(
    worldInfo.debug.mvu.filteredEntries.map((entry) => entry.sourceName).sort(),
    ["[mvu_update] 状态同步", "MVU 启发式条目", "Bonus MVU"].sort(),
  );
  assert.equal(
    worldInfo.debug.warnings.some((warning) => warning.includes("旧 EW 命名条目")),
    true,
  );
  assert.equal(
    worldInfo.debug.recursionWarnings.some((warning) =>
      warning.includes("mvu filtered world info blocked"),
    ),
    true,
  );

  const settings = {
    taskProfiles: {
      recall: {
        activeProfileId: "custom",
        profiles: [
          {
            id: "custom",
            name: "测试预设",
            taskType: "recall",
            builtin: false,
            blocks: [
              {
                id: "b1",
                type: "builtin",
                sourceKey: "worldInfoBefore",
                role: "system",
                enabled: true,
                order: 0,
                injectionMode: "append",
              },
              {
                id: "b2",
                type: "builtin",
                sourceKey: "worldInfoAfter",
                role: "system",
                enabled: true,
                order: 1,
                injectionMode: "append",
              },
              {
                id: "b3",
                type: "custom",
                content: "角色: {{charName}}",
                role: "user",
                enabled: true,
                order: 2,
                injectionMode: "append",
              },
            ],
          },
        ],
      },
    },
  };

  const promptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    userMessage: "继续调查",
    recentMessages: "我们继续调查那条线索",
    charName: "Alice",
  });

  assert.match(promptBuild.systemPrompt, /这里是常驻世界设定/);
  assert.match(promptBuild.systemPrompt, /控制摘要：隐藏线索：Alice 正在调查/);
  assert.match(
    promptBuild.systemPrompt,
    /数据摘要：线索=蓝钥匙；情绪=紧张；角色=Alice；用户=User；上下文=我们继续调查那条线索/,
  );
  assert.match(promptBuild.systemPrompt, /扩展语义只是普通文本/);
  assert.match(promptBuild.systemPrompt, /来自 bonus-book 的补充内容/);
  assert.match(promptBuild.systemPrompt, /MVU lazy:/);
  assert.doesNotMatch(promptBuild.systemPrompt, /getwi|<%=?/);
  assert.doesNotMatch(promptBuild.systemPrompt, /status_current_variable|变量更新规则|updatevariable/i);
  assert.equal(
    promptBuild.privateTaskMessages.length,
    2,
    "custom user block + atDepth world info should both enter private task messages",
  );
  assert.deepEqual(
    promptBuild.privateTaskMessages.map((message) => message.role),
    ["user", "system"],
  );
  assert.deepEqual(
    promptBuild.hostInjections.before.map((entry) => entry.name),
    [
      "常驻设定",
      "EJS 汇总",
      "数据 EJS 汇总",
      "扩展语义正文",
      "外部书汇总",
      "MVU 懒加载探测",
    ],
  );
  assert.deepEqual(
    promptBuild.hostInjections.after.map((entry) => entry.name),
    ["强制后置"],
  );
  assert.equal(promptBuild.hostInjections.atDepth.length, 1);
  assert.equal(promptBuild.hostInjections.atDepth[0].depth, 2);
  assert.equal(promptBuild.hostInjectionPlan.before.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.before[0].blockId, "b1");
  assert.equal(promptBuild.hostInjectionPlan.before[0].sourceKey, "worldInfoBefore");
  assert.deepEqual(promptBuild.hostInjectionPlan.before[0].entryNames, [
    "常驻设定",
    "EJS 汇总",
    "数据 EJS 汇总",
    "扩展语义正文",
    "外部书汇总",
    "MVU 懒加载探测",
  ]);
  assert.equal(promptBuild.hostInjectionPlan.after.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.after[0].blockId, "b2");
  assert.equal(promptBuild.hostInjectionPlan.after[0].sourceKey, "worldInfoAfter");
  assert.deepEqual(promptBuild.hostInjectionPlan.after[0].entryNames, ["强制后置"]);
  assert.equal(promptBuild.hostInjectionPlan.atDepth.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.atDepth[0].entryName, "深度注入");
  assert.equal(typeof promptBuild.debug.worldInfoCacheHit, "boolean");
  assert.equal(promptBuild.executionMessages.length, 4);
  assert.deepEqual(
    promptBuild.executionMessages.map((message) => message.role),
    ["system", "system", "user", "system"],
  );
  assert.deepEqual(
    promptBuild.renderedBlocks.map((block) => block.delivery),
    ["private.system", "private.system", "private.message"],
  );
  assert.equal(promptBuild.additionalMessages.length, 1);
  assert.equal(promptBuild.additionalMessages[0].content, "这是一条 atDepth 消息。");
  assert.equal(promptBuild.debug.mvu.sanitizedFieldCount >= 0, true);

  const { initializeHostAdapter } = await import("../host-adapter/index.js");
  const partialBridgeCalls = [];
  const partialBridgeEntriesByWorldbook = {
    "main-book": [createConstantWorldbookEntry(11, "主书原名", "主书内容。", "主书注释")],
    "side-book": [createConstantWorldbookEntry(12, "支线原名", "支线内容。", "支线注释")],
    "persona-book": [createConstantWorldbookEntry(13, "人格原名", "人格内容。", "人格注释")],
    "chat-book": [createConstantWorldbookEntry(14, "聊天原名", "聊天内容。", "聊天注释")],
  };

  globalThis.SillyTavern = {
    getContext() {
      return {
        name1: "User",
        name2: "Alice",
        chat: [{ is_user: true, mes: "我们继续调查那条线索" }],
        chatMetadata: {
          world: "chat-book",
        },
        extensionSettings: {
          persona_description_lorebook: "persona-book",
        },
      };
    },
  };
  globalThis.getCharWorldbookNames = () => ({
    primary: "main-book",
    additional: ["side-book"],
  });
  globalThis.getWorldbook = async () => {
    throw new Error(
      "legacy getWorldbook should not be used when bridge getWorldbook is available",
    );
  };
  globalThis.getLorebookEntries = async (worldbookName) =>
    (partialBridgeEntriesByWorldbook[worldbookName] || []).map((entry) => ({
      uid: entry.uid,
      comment: entry.comment,
    }));

  initializeHostAdapter({
    worldbookProvider: {
      async getWorldbook(worldbookName) {
        partialBridgeCalls.push(worldbookName);
        return partialBridgeEntriesByWorldbook[worldbookName] || [];
      },
    },
  });

  const partialBridgeWorldInfo = await resolveTaskWorldInfo({
    templateContext: {
      recentMessages: "我们继续调查那条线索",
      charName: "Alice",
    },
    userMessage: "继续调查",
  });

  assert.deepEqual(partialBridgeCalls, [
    "main-book",
    "side-book",
    "persona-book",
    "chat-book",
  ]);
  assert.deepEqual(
    partialBridgeWorldInfo.beforeEntries.map((entry) => entry.name).sort(),
    ["主书注释", "支线注释", "人格注释", "聊天注释"].sort(),
  );

  console.log("task-worldinfo tests passed");
} finally {
  if (originalSillyTavern === undefined) {
    delete globalThis.SillyTavern;
  } else {
    globalThis.SillyTavern = originalSillyTavern;
  }

  if (originalGetCharWorldbookNames === undefined) {
    delete globalThis.getCharWorldbookNames;
  } else {
    globalThis.getCharWorldbookNames = originalGetCharWorldbookNames;
  }

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

  try {
    const { initializeHostAdapter } = await import("../host-adapter/index.js");
    initializeHostAdapter({});
  } catch {
    // ignore reset failures in test cleanup
  }
}
