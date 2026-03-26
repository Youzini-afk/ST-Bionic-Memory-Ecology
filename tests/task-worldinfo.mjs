import assert from "node:assert/strict";

const originalSillyTavern = globalThis.SillyTavern;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;

const constantEntry = {
  uid: 1,
  name: "常驻设定",
  comment: "常驻设定",
  content: "这里是常驻世界设定。",
  enabled: true,
  position: {
    type: "before_character_definition",
    role: "system",
    depth: 0,
    order: 10,
  },
  strategy: {
    type: "constant",
    keys: [],
    keys_secondary: { logic: "and_any", keys: [] },
  },
  probability: 100,
  extra: {},
};

const dynEntry = {
  uid: 2,
  name: "Dyn/线索",
  comment: "线索条目",
  content: "隐藏线索：<%= charName %> 正在调查。",
  enabled: false,
  position: {
    type: "before_character_definition",
    role: "system",
    depth: 0,
    order: 20,
  },
  strategy: {
    type: "selective",
    keys: ["调查"],
    keys_secondary: { logic: "and_any", keys: [] },
  },
  probability: 100,
  extra: {},
};

const controllerEntry = {
  uid: 3,
  name: "EW/Controller/Main",
  comment: "控制器",
  content: '<%= await getwi("Dyn/线索") %>',
  enabled: true,
  position: {
    type: "before_character_definition",
    role: "system",
    depth: 0,
    order: 30,
  },
  strategy: {
    type: "constant",
    keys: [],
    keys_secondary: { logic: "and_any", keys: [] },
  },
  probability: 100,
  extra: {},
};

const atDepthEntry = {
  uid: 4,
  name: "深度注入",
  comment: "深度注入",
  content: "这是一条 atDepth 消息。",
  enabled: true,
  position: {
    type: "at_depth_as_system",
    role: "system",
    depth: 2,
    order: 5,
  },
  strategy: {
    type: "constant",
    keys: [],
    keys_secondary: { logic: "and_any", keys: [] },
  },
  probability: 100,
  extra: {},
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
  globalThis.getWorldbook = async () => [
    constantEntry,
    dynEntry,
    controllerEntry,
    atDepthEntry,
  ];
  globalThis.getLorebookEntries = async () => [];

  const { resolveTaskWorldInfo } = await import("../task-worldinfo.js");
  const { buildTaskPrompt } = await import("../prompt-builder.js");

  const worldInfo = await resolveTaskWorldInfo({
    templateContext: {
      recentMessages: "我们继续调查那条线索",
      charName: "Alice",
    },
    userMessage: "继续调查",
  });

  assert.deepEqual(
    worldInfo.beforeEntries.map((entry) => entry.name),
    ["常驻设定", "EW/Controller/Main", "线索条目"],
  );
  assert.equal(worldInfo.additionalMessages.length, 1);
  assert.equal(worldInfo.additionalMessages[0].content, "这是一条 atDepth 消息。");

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
                type: "custom",
                content: "角色: {{charName}}",
                role: "user",
                enabled: true,
                order: 1,
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
  assert.match(promptBuild.systemPrompt, /隐藏线索：Alice 正在调查/);
  assert.equal(promptBuild.additionalMessages.length, 1);
  assert.equal(promptBuild.additionalMessages[0].content, "这是一条 atDepth 消息。");

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
}
