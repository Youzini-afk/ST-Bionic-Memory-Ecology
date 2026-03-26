// ST-BME: 任务级 EJS / 世界书渲染引擎
// 仅用于世界书条目渲染，不开放给用户自定义 prompt 块。

const DEFAULT_MAX_RECURSION = 10;
let ejsRuntimePromise = null;

const FALLBACK_LODASH = {
  get: getByPath,
  set: setByPath,
  unset: unsetByPath,
  cloneDeep: cloneDeep,
  escapeRegExp: escapeRegExp,
  sum(values = []) {
    return (Array.isArray(values) ? values : []).reduce(
      (total, value) => total + (Number(value) || 0),
      0,
    );
  },
};

function getUtilityLib() {
  return globalThis._ || FALLBACK_LODASH;
}

function getEjsRuntime() {
  return globalThis.ejs || null;
}

async function ensureEjsRuntime() {
  if (globalThis.ejs) {
    return globalThis.ejs;
  }
  if (ejsRuntimePromise) {
    return await ejsRuntimePromise;
  }

  ejsRuntimePromise = (async () => {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const previousWindow = globalThis.window;

    if (!hadWindow) {
      globalThis.window = globalThis;
    }

    try {
      await import("./vendor/ejs.js");
    } catch (error) {
      console.warn("[ST-BME] task-ejs 加载 vendor/ejs.js 失败:", error);
    } finally {
      if (!hadWindow) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
    }

    return globalThis.ejs || null;
  })();

  return await ejsRuntimePromise;
}

function getStContext() {
  try {
    return globalThis.SillyTavern?.getContext?.() || {};
  } catch {
    return {};
  }
}

function getStChat() {
  try {
    const ctx = getStContext();
    return Array.isArray(ctx.chat) ? ctx.chat : [];
  } catch {
    return [];
  }
}

function cloneDeep(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
    // ignore and fall back to JSON
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getByPath(target, path, defaultValue = undefined) {
  const result = String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
  return result === undefined ? defaultValue : result;
}

function setByPath(target, path, value) {
  const segments = String(path || "")
    .split(".")
    .filter(Boolean);
  if (segments.length === 0 || target == null || typeof target !== "object") {
    return;
  }

  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (cursor[key] == null || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[segments[segments.length - 1]] = value;
}

function unsetByPath(target, path) {
  const segments = String(path || "")
    .split(".")
    .filter(Boolean);
  if (segments.length === 0 || target == null || typeof target !== "object") {
    return;
  }

  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = cursor?.[segments[index]];
    if (cursor == null || typeof cursor !== "object") {
      return;
    }
  }
  delete cursor[segments[segments.length - 1]];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEntryKey(value) {
  return String(value ?? "").trim();
}

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function processChatMessage(message) {
  return String(message?.mes ?? message?.message ?? message?.content ?? "");
}

function buildTemplateContext(templateContext = {}) {
  const ctx = getStContext();
  const chat = getStChat();
  const lastUserMessage =
    typeof templateContext.user_input === "string"
      ? templateContext.user_input
      : chat.findLast?.((message) => message?.is_user)?.mes ||
        [...chat].reverse().find((message) => message?.is_user)?.mes ||
        "";

  return {
    user: ctx.name1 || "",
    char: ctx.name2 || "",
    userName: ctx.name1 || "",
    charName: ctx.name2 || "",
    persona:
      ctx.powerUserSettings?.persona_description ||
      ctx.extensionSettings?.persona_description ||
      ctx.name1_description ||
      ctx.persona ||
      "",
    lastUserMessage,
    last_user_message: lastUserMessage,
    userInput: lastUserMessage,
    user_input: lastUserMessage,
    original: "",
    input: "",
    lastMessage: "",
    lastMessageId: "",
    newline: "\n",
    trim: "",
    ...templateContext,
  };
}

export function substituteTaskEjsParams(text, templateContext = {}) {
  if (!text || !String(text).includes("{{")) {
    return String(text || "");
  }

  const context = buildTemplateContext(templateContext);
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_.$]+)\s*\}\}/g, (_, path) => {
    const value = getByPath(context, path);
    if (value == null) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    }
    return String(value);
  });
}

function createVariableState() {
  const ctx = getStContext();
  const chat = getStChat();
  const lastMessage = chat[chat.length - 1] || {};
  const swipeId = Number(lastMessage?.swipe_id ?? 0);
  const messageVars =
    lastMessage?.variables && typeof lastMessage.variables === "object"
      ? cloneDeep(lastMessage.variables[swipeId] || {})
      : {};
  const globalVars = cloneDeep(ctx.extensionSettings?.variables?.global || {});
  const localVars = cloneDeep(ctx.chatMetadata?.variables || {});

  return {
    globalVars,
    localVars,
    messageVars,
    cacheVars: {
      ...globalVars,
      ...localVars,
      ...messageVars,
    },
  };
}

function rebuildVariableCache(state) {
  state.cacheVars = {
    ...state.globalVars,
    ...state.localVars,
    ...state.messageVars,
  };
}

function getVariable(state, path, options = {}) {
  const scope = normalizeIdentifier(options.scope);
  if (scope === "global") {
    return getByPath(state.globalVars, path, options.defaults);
  }
  if (scope === "local") {
    return getByPath(state.localVars, path, options.defaults);
  }
  if (scope === "message") {
    return getByPath(state.messageVars, path, options.defaults);
  }
  return getByPath(state.cacheVars, path, options.defaults);
}

function setVariable(state, path, value, options = {}) {
  const scope = normalizeIdentifier(options.scope) || "message";
  const target =
    scope === "global"
      ? state.globalVars
      : scope === "local"
        ? state.localVars
        : state.messageVars;

  if (value === undefined) {
    unsetByPath(target, path);
  } else {
    setByPath(target, path, cloneDeep(value));
  }
  rebuildVariableCache(state);
}

function registerEntryLookup(lookup, key, entry) {
  const normalizedKey = normalizeEntryKey(key);
  if (!normalizedKey || lookup.has(normalizedKey)) return;
  lookup.set(normalizedKey, entry);
}

function activationKey(entry) {
  return `${entry.worldbook}::${entry.comment || entry.name}`;
}

function findEntry(renderCtx, currentWorldbook, worldbookOrEntry, entryNameOrData) {
  const explicitWorldbook =
    typeof entryNameOrData === "string" ? normalizeEntryKey(worldbookOrEntry) : "";
  const fallbackWorldbook = normalizeEntryKey(currentWorldbook);
  const identifier = normalizeEntryKey(
    typeof entryNameOrData === "string" ? entryNameOrData : worldbookOrEntry,
  );

  if (!identifier) return undefined;

  const lookupInWorldbook = (worldbook) => {
    if (!worldbook) return undefined;
    return renderCtx.entriesByWorldbook.get(worldbook)?.get(identifier);
  };

  return (
    lookupInWorldbook(explicitWorldbook) ||
    lookupInWorldbook(fallbackWorldbook) ||
    renderCtx.allEntries.get(identifier)
  );
}

async function activateWorldInfoInContext(
  renderCtx,
  currentWorldbook,
  world,
  entryOrForce,
  maybeForce,
) {
  const force = typeof entryOrForce === "boolean" ? entryOrForce : maybeForce;
  const explicitWorldbook = typeof entryOrForce === "string" ? world : null;
  const identifier = typeof entryOrForce === "string" ? entryOrForce : world;
  const entry = identifier
    ? findEntry(renderCtx, currentWorldbook, explicitWorldbook, identifier)
    : undefined;

  if (!entry) {
    return null;
  }

  const normalizedEntry = force
    ? {
        ...entry,
        content: String(entry.content || "").replaceAll("@@dont_activate", ""),
      }
    : entry;

  renderCtx.activatedEntries.set(activationKey(normalizedEntry), normalizedEntry);
  return {
    world: normalizedEntry.worldbook,
    comment: normalizedEntry.comment || normalizedEntry.name,
    content: normalizedEntry.content,
  };
}

async function getwi(
  renderCtx,
  currentWorldbook,
  worldbookOrEntry,
  entryNameOrData,
) {
  const entry = findEntry(
    renderCtx,
    currentWorldbook,
    worldbookOrEntry,
    entryNameOrData,
  );
  if (!entry) {
    return "";
  }

  const entryKey = activationKey(entry);
  if (renderCtx.renderStack.has(entryKey)) {
    console.warn(
      `[ST-BME] task-ejs 检测到循环 getwi: ${entry.comment || entry.name}`,
    );
    return substituteTaskEjsParams(entry.content, renderCtx.templateContext);
  }

  if (renderCtx.renderStack.size >= renderCtx.maxRecursion) {
    console.warn(
      `[ST-BME] task-ejs 超过最大递归深度: ${renderCtx.maxRecursion}`,
    );
    return substituteTaskEjsParams(entry.content, renderCtx.templateContext);
  }

  const processed = substituteTaskEjsParams(
    entry.content,
    renderCtx.templateContext,
  );
  let finalContent = processed;

  if (processed.includes("<%")) {
    renderCtx.renderStack.add(entryKey);
    try {
      finalContent = await evalTaskEjsTemplate(processed, renderCtx, {
        world_info: {
          comment: entry.comment || entry.name,
          name: entry.name,
          world: entry.worldbook,
        },
      });
    } finally {
      renderCtx.renderStack.delete(entryKey);
    }
  }

  if (!renderCtx.pulledEntries.has(entryKey)) {
    renderCtx.pulledEntries.set(entryKey, {
      name: entry.name,
      comment: entry.comment,
      content: finalContent,
      worldbook: entry.worldbook,
    });
  }

  return finalContent;
}

function getChatMessageCompat(index, role) {
  const chat = getStChat()
    .filter((message) => {
      if (!role) return true;
      if (role === "user") return Boolean(message?.is_user);
      if (role === "system") return Boolean(message?.is_system);
      return !message?.is_user && !message?.is_system;
    })
    .map(processChatMessage);

  const resolvedIndex = index >= 0 ? index : chat.length + index;
  return chat[resolvedIndex] || "";
}

function getChatMessagesCompat(startOrCount = getStChat().length, endOrRole, role) {
  const allMessages = getStChat().map((message, index) => ({
    raw: message,
    id: index,
    text: processChatMessage(message),
  }));

  const filterByRole = (items, currentRole) => {
    if (!currentRole) return items;
    return items.filter((item) => {
      if (currentRole === "user") return Boolean(item.raw?.is_user);
      if (currentRole === "system") return Boolean(item.raw?.is_system);
      return !item.raw?.is_user && !item.raw?.is_system;
    });
  };

  if (endOrRole == null) {
    return (
      startOrCount > 0
        ? allMessages.slice(0, startOrCount)
        : allMessages.slice(startOrCount)
    ).map((item) => item.text);
  }

  if (typeof endOrRole === "string") {
    const filtered = filterByRole(allMessages, endOrRole);
    return (
      startOrCount > 0 ? filtered.slice(0, startOrCount) : filtered.slice(startOrCount)
    ).map((item) => item.text);
  }

  return filterByRole(allMessages, role)
    .slice(startOrCount, endOrRole)
    .map((item) => item.text);
}

function matchChatMessagesCompat(pattern) {
  const regex =
    typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
  return getStChat().some((message) => regex.test(processChatMessage(message)));
}

function rethrow(err, str, filename, lineNumber, esc) {
  const lines = String(str || "").split("\n");
  const start = Math.max(lineNumber - 3, 0);
  const end = Math.min(lines.length, lineNumber + 3);
  const escapedFileName =
    typeof esc === "function" ? esc(filename) : filename || "ejs";
  const context = lines
    .slice(start, end)
    .map((line, index) => {
      const currentLine = index + start + 1;
      return `${currentLine === lineNumber ? " >> " : "    "}${currentLine}| ${line}`;
    })
    .join("\n");

  err.message = `${escapedFileName}:${lineNumber}\n${context}\n\n${err.message}`;
  throw err;
}

export function createTaskEjsRenderContext(entries = [], options = {}) {
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => ({
    name: normalizeEntryKey(entry?.name),
    comment: normalizeEntryKey(entry?.comment),
    content: String(entry?.content || ""),
    worldbook: normalizeEntryKey(entry?.worldbook),
  }));

  const allEntries = new Map();
  const entriesByWorldbook = new Map();

  for (const entry of normalizedEntries) {
    registerEntryLookup(allEntries, entry.name, entry);
    registerEntryLookup(allEntries, entry.comment, entry);

    if (!entriesByWorldbook.has(entry.worldbook)) {
      entriesByWorldbook.set(entry.worldbook, new Map());
    }
    const worldbookLookup = entriesByWorldbook.get(entry.worldbook);
    registerEntryLookup(worldbookLookup, entry.name, entry);
    registerEntryLookup(worldbookLookup, entry.comment, entry);
  }

  return {
    entries: normalizedEntries,
    allEntries,
    entriesByWorldbook,
    renderStack: new Set(),
    maxRecursion:
      Number.isFinite(Number(options.maxRecursion)) &&
      Number(options.maxRecursion) > 0
        ? Number(options.maxRecursion)
        : DEFAULT_MAX_RECURSION,
    variableState: createVariableState(),
    activatedEntries: new Map(),
    pulledEntries: new Map(),
    templateContext: {
      ...(options.templateContext || {}),
    },
  };
}

export async function evalTaskEjsTemplate(
  content,
  renderCtx,
  extraEnv = {},
) {
  const runtime = await ensureEjsRuntime();
  if (!runtime) {
    console.warn("[ST-BME] task-ejs 未找到全局 ejs 运行时，跳过渲染");
    return substituteTaskEjsParams(content, renderCtx?.templateContext);
  }

  const processed = substituteTaskEjsParams(content, renderCtx?.templateContext);
  if (!processed.includes("<%")) {
    return processed;
  }

  const stCtx = getStContext();
  const chat = getStChat();
  const utilityLib = getUtilityLib();
  const workflowUserInput =
    typeof renderCtx?.templateContext?.user_input === "string"
      ? renderCtx.templateContext.user_input
      : chat.findLast?.((message) => message?.is_user)?.mes ||
        [...chat].reverse().find((message) => message?.is_user)?.mes ||
        "";

  const context = {
    _: utilityLib,
    console,
    userName: stCtx.name1 || "",
    charName: stCtx.name2 || "",
    assistantName: stCtx.name2 || "",
    characterId: stCtx.characterId,
    get chatId() {
      return stCtx.chatId || globalThis.getCurrentChatId?.() || "";
    },
    get variables() {
      return renderCtx.variableState.cacheVars;
    },
    get lastUserMessageId() {
      return chat.findLastIndex
        ? chat.findLastIndex((message) => message?.is_user)
        : [...chat]
            .reverse()
            .findIndex((message) => message?.is_user);
    },
    get lastUserMessage() {
      return (
        workflowUserInput ||
        chat.findLast?.((message) => message?.is_user)?.mes ||
        [...chat].reverse().find((message) => message?.is_user)?.mes ||
        ""
      );
    },
    get last_user_message() {
      return this.lastUserMessage;
    },
    get userInput() {
      return workflowUserInput;
    },
    get user_input() {
      return workflowUserInput;
    },
    get lastCharMessageId() {
      return chat.findLastIndex
        ? chat.findLastIndex((message) => !message?.is_user && !message?.is_system)
        : [...chat]
            .reverse()
            .findIndex((message) => !message?.is_user && !message?.is_system);
    },
    get lastCharMessage() {
      return (
        chat.findLast?.((message) => !message?.is_user && !message?.is_system)
          ?.mes ||
        [...chat]
          .reverse()
          .find((message) => !message?.is_user && !message?.is_system)?.mes ||
        ""
      );
    },
    get lastMessageId() {
      return chat.length - 1;
    },
    get charLoreBook() {
      try {
        const characters = stCtx.characters;
        const charId = stCtx.characterId;
        return characters?.[charId]?.data?.extensions?.world || "";
      } catch {
        return "";
      }
    },
    get userLoreBook() {
      return (
        stCtx.extensionSettings?.persona_description_lorebook ||
        stCtx.powerUserSettings?.persona_description_lorebook ||
        stCtx.power_user?.persona_description_lorebook ||
        ""
      );
    },
    get chatLoreBook() {
      return stCtx.chatMetadata?.world || "";
    },
    get charAvatar() {
      try {
        const characters = stCtx.characters;
        const charId = stCtx.characterId;
        return characters?.[charId]?.avatar
          ? `/characters/${characters[charId].avatar}`
          : "";
      } catch {
        return "";
      }
    },
    userAvatar: "",
    groups: stCtx.groups || [],
    groupId: stCtx.selectedGroupId ?? null,
    get model() {
      return stCtx.onlineStatus || "";
    },
    get SillyTavern() {
      return getStContext();
    },
    getwi: (worldbookOrEntry, entryNameOrData) =>
      getwi(
        renderCtx,
        String(context.world_info?.world || ""),
        worldbookOrEntry,
        entryNameOrData,
      ),
    getWorldInfo: (worldbookOrEntry, entryNameOrData) =>
      getwi(
        renderCtx,
        String(context.world_info?.world || ""),
        worldbookOrEntry,
        entryNameOrData,
      ),
    getvar: (path, options) =>
      getVariable(renderCtx.variableState, path, options),
    getLocalVar: (path, options = {}) =>
      getVariable(renderCtx.variableState, path, {
        ...options,
        scope: "local",
      }),
    getGlobalVar: (path, options = {}) =>
      getVariable(renderCtx.variableState, path, {
        ...options,
        scope: "global",
      }),
    getMessageVar: (path, options = {}) =>
      getVariable(renderCtx.variableState, path, {
        ...options,
        scope: "message",
      }),
    setvar: (path, value, options = {}) =>
      setVariable(renderCtx.variableState, path, value, options),
    setLocalVar: (path, value, options = {}) =>
      setVariable(renderCtx.variableState, path, value, {
        ...options,
        scope: "local",
      }),
    setGlobalVar: (path, value, options = {}) =>
      setVariable(renderCtx.variableState, path, value, {
        ...options,
        scope: "global",
      }),
    setMessageVar: (path, value, options = {}) =>
      setVariable(renderCtx.variableState, path, value, {
        ...options,
        scope: "message",
      }),
    incvar: () => undefined,
    decvar: () => undefined,
    delvar: () => undefined,
    insvar: () => undefined,
    incLocalVar: () => undefined,
    incGlobalVar: () => undefined,
    incMessageVar: () => undefined,
    decLocalVar: () => undefined,
    decGlobalVar: () => undefined,
    decMessageVar: () => undefined,
    patchVariables: () => undefined,
    getChatMessage: (id, role) => getChatMessageCompat(id, role),
    getChatMessages: (startOrCount, endOrRole, role) =>
      getChatMessagesCompat(startOrCount, endOrRole, role),
    matchChatMessages: (pattern) => matchChatMessagesCompat(pattern),
    getchr: () => {
      try {
        const characters = stCtx.characters;
        const charId = stCtx.characterId;
        const character = characters?.[charId];
        return (
          character?.description ||
          character?.data?.description ||
          ""
        );
      } catch {
        return "";
      }
    },
    getchar: undefined,
    getChara: undefined,
    getprp: async () => "",
    getpreset: async () => "",
    getPresetPrompt: async () => "",
    execute: async () => "",
    define: () => undefined,
    evalTemplate: async (innerContent, data = {}) =>
      evalTaskEjsTemplate(innerContent, renderCtx, data),
    getqr: async () => "",
    getQuickReply: async () => "",
    findVariables: () => ({}),
    getWorldInfoData: async () =>
      renderCtx.entries.map((entry) => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    getWorldInfoActivatedData: async () =>
      [...renderCtx.activatedEntries.values()].map((entry) => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    getEnabledWorldInfoEntries: async () =>
      renderCtx.entries.map((entry) => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    selectActivatedEntries: () => [],
    activateWorldInfoByKeywords: async () => [],
    getEnabledLoreBooks: () =>
      [...new Set(renderCtx.entries.map((entry) => entry.worldbook))],
    activewi: async (world, entryOrForce, maybeForce) =>
      activateWorldInfoInContext(
        renderCtx,
        String(context.world_info?.world || ""),
        world,
        entryOrForce,
        maybeForce,
      ),
    activateWorldInfo: async (world, entryOrForce, maybeForce) =>
      activateWorldInfoInContext(
        renderCtx,
        String(context.world_info?.world || ""),
        world,
        entryOrForce,
        maybeForce,
      ),
    activateRegex: () => undefined,
    injectPrompt: () => undefined,
    getPromptsInjected: () => [],
    hasPromptsInjected: () => false,
    jsonPatch: () => undefined,
    parseJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    print: (...parts) =>
      parts
        .filter((part) => part !== undefined && part !== null)
        .join(""),
    ...extraEnv,
  };

  context.getchar = context.getchr;
  context.getChara = context.getchr;

  try {
    const compiled = runtime.compile(processed, {
      async: true,
      outputFunctionName: "print",
      _with: true,
      localsName: "locals",
      client: true,
    });
    const result = await compiled.call(
      context,
      context,
      (value) => value,
      () => ({ filename: "", template: "" }),
      rethrow,
    );
    return result ?? "";
  } catch (error) {
    console.warn("[ST-BME] task-ejs 渲染失败，回退原文本:", error);
    return processed;
  }
}

export async function renderTaskEjsContent(content, templateContext = {}) {
  const processed = substituteTaskEjsParams(content, templateContext);
  if (!processed.includes("<%")) {
    return processed;
  }

  const renderCtx = createTaskEjsRenderContext([], { templateContext });
  return await evalTaskEjsTemplate(processed, renderCtx);
}

export function checkTaskEjsSyntax(content) {
  const runtime = getEjsRuntime();
  if (!runtime || !String(content || "").includes("<%")) {
    return null;
  }

  try {
    runtime.compile(content, {
      async: true,
      client: true,
      _with: true,
      localsName: "locals",
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
