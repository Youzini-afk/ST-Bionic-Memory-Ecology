// ST-BME: 任务级 EJS / 世界书渲染引擎
// 仅用于世界书条目渲染，不开放给用户自定义 prompt 块。

import { getSTContextSnapshot } from "./st-context.js";

const DEFAULT_MAX_RECURSION = 10;
let ejsRuntimeStatePromise = null;

const EJS_RUNTIME_STATUS = {
  PRIMARY: "primary",
  FALLBACK: "fallback",
  FAILED: "failed",
};

const FALLBACK_LODASH = {
  get: getByPath,
  cloneDeep,
  escapeRegExp,
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

function buildEjsRuntimeState(runtime, status, error = null) {
  return {
    runtime: runtime || null,
    status,
    isAvailable: Boolean(runtime),
    isFallback: status === EJS_RUNTIME_STATUS.FALLBACK,
    error: error || null,
  };
}

function getCurrentEjsRuntimeState() {
  const runtime = getEjsRuntime();
  if (!runtime) {
    return buildEjsRuntimeState(null, EJS_RUNTIME_STATUS.FAILED);
  }
  return buildEjsRuntimeState(runtime, EJS_RUNTIME_STATUS.PRIMARY);
}

function createTaskEjsRuntimeUnavailableError(backend, content = "") {
  const error = new Error(
    `task-ejs runtime unavailable (${backend?.status || EJS_RUNTIME_STATUS.FAILED})`,
  );
  error.name = "TaskEjsRuntimeUnavailableError";
  error.code = "st_bme_task_ejs_runtime_unavailable";
  error.backend = backend || null;
  error.content = String(content || "");
  return error;
}

function createTaskEjsUnsupportedHelperError(helperName, args = []) {
  const error = new Error(`task-ejs unsupported helper: ${String(helperName || "unknown")}`);
  error.name = "TaskEjsUnsupportedHelperError";
  error.code = "st_bme_task_ejs_unsupported_helper";
  error.helperName = String(helperName || "unknown");
  error.args = Array.isArray(args) ? cloneDeep(args) : [];
  return error;
}

async function ensureEjsRuntime() {
  const currentState = getCurrentEjsRuntimeState();
  if (currentState.isAvailable) {
    return currentState;
  }
  if (ejsRuntimeStatePromise) {
    return await ejsRuntimeStatePromise;
  }

  ejsRuntimeStatePromise = (async () => {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const previousWindow = globalThis.window;
    let importError = null;

    if (!hadWindow) {
      globalThis.window = globalThis;
    }

    try {
      await import("./vendor/ejs.js");
    } catch (error) {
      importError = error;
      console.warn("[ST-BME] task-ejs 加载 vendor/ejs.js 失败:", error);
    } finally {
      if (!hadWindow) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
    }

    const runtime = getEjsRuntime();
    if (runtime) {
      return buildEjsRuntimeState(runtime, EJS_RUNTIME_STATUS.FALLBACK);
    }
    return buildEjsRuntimeState(null, EJS_RUNTIME_STATUS.FAILED, importError);
  })();

  return await ejsRuntimeStatePromise;
}

async function resolveTaskEjsBackend(options = {}) {
  if (options.ensureRuntime === false) {
    return getCurrentEjsRuntimeState();
  }
  return await ensureEjsRuntime();
}

function resolveHostSnapshot(injectedSnapshot) {
  if (injectedSnapshot?.snapshot) {
    return injectedSnapshot;
  }
  return getSTContextSnapshot();
}

function getStChat(injectedSnapshot) {
  return resolveHostSnapshot(injectedSnapshot).snapshot.chat.messages || [];
}

function buildTemplateContext(templateContext = {}, hostSnapshot) {
  const resolvedHost = resolveHostSnapshot(hostSnapshot);
  const snapshot = resolvedHost.snapshot;
  const promptAliases = resolvedHost.prompt || {};
  const lastUserMessage =
    typeof templateContext.user_input === "string"
      ? templateContext.user_input
      : snapshot.chat.lastUserMessage || "";

  return {
    user: snapshot.user.name,
    char: snapshot.character.name,
    userName: promptAliases.userName || snapshot.user.name,
    charName: promptAliases.charName || snapshot.character.name,
    persona: promptAliases.userPersona || snapshot.persona.text,
    userPersona: promptAliases.userPersona || snapshot.persona.text,
    charDescription:
      promptAliases.charDescription || snapshot.character.description,
    currentTime: promptAliases.currentTime || snapshot.time.current,
    stSnapshot: snapshot,
    hostSnapshot: snapshot,
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEntryKey(value) {
  return String(value ?? "").trim();
}

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeRole(role) {
  const normalized = String(role || "system").trim().toLowerCase();
  return ["system", "user", "assistant"].includes(normalized)
    ? normalized
    : "system";
}

function processChatMessage(message) {
  return String(message?.mes ?? message?.message ?? message?.content ?? "");
}

export function substituteTaskEjsParams(
  text,
  templateContext = {},
  options = {},
) {
  if (!text || !String(text).includes("{{")) {
    return String(text || "");
  }

  const context = buildTemplateContext(
    templateContext,
    options.hostSnapshot || templateContext.hostSnapshot,
  );
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

function createReadOnlyVariableState(hostSnapshot) {
  const snapshot = resolveHostSnapshot(hostSnapshot).snapshot;
  const chat = snapshot.chat.messages || [];
  const lastMessage = chat[chat.length - 1] || {};
  const swipeId = Number(lastMessage?.swipe_id ?? 0);
  const messageVars =
    lastMessage?.variables && typeof lastMessage.variables === "object"
      ? cloneDeep(lastMessage.variables[swipeId] || {})
      : {};
  const globalVars = cloneDeep(snapshot.variables.global || {});
  const localVars = cloneDeep(snapshot.variables.local || {});

  return Object.freeze({
    globalVars,
    localVars,
    messageVars,
    cacheVars: {
      ...globalVars,
      ...localVars,
      ...messageVars,
    },
  });
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

function normalizeRenderEntry(entry = {}) {
  return {
    uid: Number(entry.uid) || 0,
    name: normalizeEntryKey(entry.name),
    comment: normalizeEntryKey(entry.comment),
    content: String(entry.content || ""),
    worldbook: normalizeEntryKey(entry.worldbook),
    role: normalizeRole(entry.role),
    position: Number(entry.position ?? 0),
    depth: Number(entry.depth ?? 0),
    order: Number(entry.order ?? 100),
    enabled: entry.enabled !== false,
    activationDebug:
      entry.activationDebug && typeof entry.activationDebug === "object"
        ? cloneDeep(entry.activationDebug)
        : null,
  };
}

function registerEntryLookup(lookup, key, entry) {
  const normalizedKey = normalizeEntryKey(key);
  if (!normalizedKey || lookup.has(normalizedKey)) return;
  lookup.set(normalizedKey, entry);
}

function registerEntries(renderCtx, entries = []) {
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = normalizeRenderEntry(rawEntry);
    renderCtx.entries.push(entry);
    registerEntryLookup(renderCtx.allEntries, entry.name, entry);
    registerEntryLookup(renderCtx.allEntries, entry.comment, entry);

    if (!renderCtx.entriesByWorldbook.has(entry.worldbook)) {
      renderCtx.entriesByWorldbook.set(entry.worldbook, new Map());
    }
    const worldbookLookup = renderCtx.entriesByWorldbook.get(entry.worldbook);
    registerEntryLookup(worldbookLookup, entry.name, entry);
    registerEntryLookup(worldbookLookup, entry.comment, entry);
  }
}

function activationKey(entry) {
  return [entry.worldbook, entry.uid || entry.comment || entry.name].join("::");
}

function recordRenderWarning(renderCtx, warning) {
  const text = String(warning || "").trim();
  if (!text) return;
  if (!Array.isArray(renderCtx?.warnings)) {
    renderCtx.warnings = [];
  }
  if (!renderCtx.warnings.includes(text)) {
    renderCtx.warnings.push(text);
  }
}

async function ensureWorldbookEntriesLoaded(renderCtx, worldbookName) {
  const normalizedWorldbook = normalizeEntryKey(worldbookName);
  if (!normalizedWorldbook) {
    return false;
  }
  if (renderCtx.entriesByWorldbook.has(normalizedWorldbook)) {
    return true;
  }
  if (renderCtx.worldbookLoadAttempts.has(normalizedWorldbook)) {
    return renderCtx.entriesByWorldbook.has(normalizedWorldbook);
  }
  if (typeof renderCtx.loadWorldbookEntries !== "function") {
    return false;
  }

  renderCtx.worldbookLoadAttempts.add(normalizedWorldbook);
  try {
    const loadedEntries = await renderCtx.loadWorldbookEntries(normalizedWorldbook);
    registerEntries(renderCtx, loadedEntries);
    if ((Array.isArray(loadedEntries) ? loadedEntries : []).length > 0) {
      renderCtx.lazyLoadedWorldbooks.add(normalizedWorldbook);
      return true;
    }
  } catch (error) {
    recordRenderWarning(
      renderCtx,
      `lazy load worldbook failed: ${normalizedWorldbook}`,
    );
    console.warn(
      `[ST-BME] task-ejs 懒加载世界书失败: ${normalizedWorldbook}`,
      error,
    );
  }

  return renderCtx.entriesByWorldbook.has(normalizedWorldbook);
}

async function resolveEntry(renderCtx, currentWorldbook, worldbookOrEntry, entryNameOrData) {
  const explicitWorldbook =
    typeof entryNameOrData === "string"
      ? normalizeEntryKey(worldbookOrEntry)
      : "";
  const fallbackWorldbook = normalizeEntryKey(currentWorldbook);
  const identifier = normalizeEntryKey(
    typeof entryNameOrData === "string" ? entryNameOrData : worldbookOrEntry,
  );

  if (!identifier) return undefined;

  const lookupInWorldbook = (worldbook) => {
    if (!worldbook) return undefined;
    return renderCtx.entriesByWorldbook.get(worldbook)?.get(identifier);
  };

  let resolved =
    lookupInWorldbook(explicitWorldbook) ||
    lookupInWorldbook(fallbackWorldbook) ||
    renderCtx.allEntries.get(identifier);

  if (!resolved && explicitWorldbook) {
    await ensureWorldbookEntriesLoaded(renderCtx, explicitWorldbook);
    resolved =
      lookupInWorldbook(explicitWorldbook) ||
      lookupInWorldbook(fallbackWorldbook) ||
      renderCtx.allEntries.get(identifier);
  }

  if (
    !resolved &&
    typeof renderCtx.resolveIgnoredEntry === "function"
  ) {
    const ignoredEntry =
      renderCtx.resolveIgnoredEntry(explicitWorldbook || fallbackWorldbook, identifier) ||
      renderCtx.resolveIgnoredEntry("", identifier);
    if (ignoredEntry) {
      const descriptor = ignoredEntry.sourceName || ignoredEntry.name || identifier;
      recordRenderWarning(
        renderCtx,
        `mvu filtered world info blocked: ${ignoredEntry.worldbook ? `${ignoredEntry.worldbook}/` : ""}${descriptor}`,
      );
    }
  }

  return resolved;
}

async function activateWorldInfoInContext(
  renderCtx,
  currentWorldbook,
  world,
  entryOrForce,
  maybeForce,
) {
  const hasExplicitWorldbook = typeof entryOrForce === "string";
  const identifier = normalizeEntryKey(hasExplicitWorldbook ? entryOrForce : world);
  const explicitWorldbook = hasExplicitWorldbook ? normalizeEntryKey(world) : "";
  const entry = await resolveEntry(
    renderCtx,
    currentWorldbook,
    explicitWorldbook || identifier,
    hasExplicitWorldbook ? identifier : undefined,
  );

  if (!entry) {
    recordRenderWarning(
      renderCtx,
      `activewi target not found: ${explicitWorldbook ? `${explicitWorldbook}/` : ""}${identifier}`,
    );
    return null;
  }

  const normalizedEntry = normalizeRenderEntry({
    ...entry,
    content: String(entry.content || "").replaceAll("@@dont_activate", ""),
  });

  renderCtx.forcedActivatedEntries.set(activationKey(normalizedEntry), normalizedEntry);
  return {
    world: normalizedEntry.worldbook,
    comment: normalizedEntry.comment || normalizedEntry.name,
    content: normalizedEntry.content,
    forced: typeof maybeForce === "boolean" ? maybeForce : typeof entryOrForce === "boolean",
  };
}

async function getwi(
  renderCtx,
  currentWorldbook,
  worldbookOrEntry,
  entryNameOrData,
) {
  const entry = await resolveEntry(
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
    recordRenderWarning(
      renderCtx,
      `recursive getwi blocked: ${entry.comment || entry.name}`,
    );
    console.warn(
      `[ST-BME] task-ejs 检测到循环 getwi: ${entry.comment || entry.name}`,
    );
    return "";
  }

  if (renderCtx.renderStack.size >= renderCtx.maxRecursion) {
    recordRenderWarning(
      renderCtx,
      `getwi recursion limit reached: ${entry.comment || entry.name}`,
    );
    console.warn(
      `[ST-BME] task-ejs 超过最大递归深度: ${renderCtx.maxRecursion}`,
    );
    return "";
  }

  const processed = substituteTaskEjsParams(entry.content, renderCtx.templateContext, {
    hostSnapshot: renderCtx.hostSnapshot,
  });
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

  renderCtx.inlinePulledEntries.set(entryKey, {
    name: entry.name,
    comment: entry.comment,
    content: finalContent,
    worldbook: entry.worldbook,
  });

  return String(finalContent || "");
}

function getChatMessageCompat(renderCtx, index, role) {
  const chat = getStChat(renderCtx?.hostSnapshot)
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

function getChatMessagesCompat(renderCtx, startOrCount, endOrRole, role) {
  const chat = getStChat(renderCtx?.hostSnapshot);
  const allMessages = chat.map((message, index) => ({
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
      startOrCount > 0
        ? filtered.slice(0, startOrCount)
        : filtered.slice(startOrCount)
    ).map((item) => item.text);
  }

  return filterByRole(allMessages, role)
    .slice(startOrCount, endOrRole)
    .map((item) => item.text);
}

function matchChatMessagesCompat(renderCtx, pattern) {
  const regex = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
  return getStChat(renderCtx?.hostSnapshot).some((message) =>
    regex.test(processChatMessage(message)),
  );
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

function makeUnsupportedHelper(helperName) {
  return (...args) => {
    throw createTaskEjsUnsupportedHelperError(helperName, args);
  };
}

function getCurrentActivatedEntries(renderCtx) {
  return Array.isArray(renderCtx?.currentActivatedEntries)
    ? renderCtx.currentActivatedEntries
    : [];
}

export function createTaskEjsRenderContext(entries = [], options = {}) {
  const hostSnapshot = resolveHostSnapshot(options.hostSnapshot);
  const renderCtx = {
    entries: [],
    allEntries: new Map(),
    entriesByWorldbook: new Map(),
    renderStack: new Set(),
    worldbookLoadAttempts: new Set(),
    lazyLoadedWorldbooks: new Set(),
    warnings: [],
    maxRecursion:
      Number.isFinite(Number(options.maxRecursion)) && Number(options.maxRecursion) > 0
        ? Number(options.maxRecursion)
        : DEFAULT_MAX_RECURSION,
    hostSnapshot,
    variableState: createReadOnlyVariableState(hostSnapshot),
    currentActivatedEntries: Array.isArray(options.currentActivatedEntries)
      ? options.currentActivatedEntries.map((entry) => normalizeRenderEntry(entry))
      : [],
    forcedActivatedEntries: new Map(),
    inlinePulledEntries: new Map(),
    ejsRuntimeStatus: EJS_RUNTIME_STATUS.FAILED,
    ejsRuntimeFallback: false,
    ejsLastError: null,
    loadWorldbookEntries:
      typeof options.loadWorldbookEntries === "function"
        ? options.loadWorldbookEntries
        : null,
    resolveIgnoredEntry:
      typeof options.resolveIgnoredEntry === "function"
        ? options.resolveIgnoredEntry
        : null,
    templateContext: {
      ...(options.templateContext || {}),
      hostSnapshot: hostSnapshot.snapshot,
      stSnapshot: hostSnapshot.snapshot,
    },
  };

  registerEntries(renderCtx, entries);
  return renderCtx;
}

export async function evalTaskEjsTemplate(content, renderCtx, extraEnv = {}) {
  const backend = await resolveTaskEjsBackend();
  const runtime = backend.runtime;
  if (renderCtx && typeof renderCtx === "object") {
    renderCtx.ejsRuntimeStatus = backend.status;
    renderCtx.ejsRuntimeFallback = Boolean(backend.isFallback);
    renderCtx.ejsLastError = backend.error
      ? backend.error instanceof Error
        ? backend.error.message
        : String(backend.error)
      : null;
  }

  const hostSnapshot = resolveHostSnapshot(renderCtx?.hostSnapshot);
  const snapshot = hostSnapshot.snapshot;
  const processed = substituteTaskEjsParams(content, renderCtx?.templateContext, {
    hostSnapshot,
  });

  if (!runtime) {
    if (processed.includes("<%")) {
      throw createTaskEjsRuntimeUnavailableError(backend, processed);
    }
    return processed;
  }

  if (!processed.includes("<%")) {
    return processed;
  }

  const stCtx = snapshot.raw || {};
  const chat = snapshot.chat.messages || [];
  const utilityLib = getUtilityLib();
  const workflowUserInput =
    typeof renderCtx?.templateContext?.user_input === "string"
      ? renderCtx.templateContext.user_input
      : snapshot.chat.lastUserMessage || "";

  const unsupported = {
    setvar: makeUnsupportedHelper("setvar"),
    setLocalVar: makeUnsupportedHelper("setLocalVar"),
    setGlobalVar: makeUnsupportedHelper("setGlobalVar"),
    setMessageVar: makeUnsupportedHelper("setMessageVar"),
    incvar: makeUnsupportedHelper("incvar"),
    decvar: makeUnsupportedHelper("decvar"),
    delvar: makeUnsupportedHelper("delvar"),
    insvar: makeUnsupportedHelper("insvar"),
    incLocalVar: makeUnsupportedHelper("incLocalVar"),
    incGlobalVar: makeUnsupportedHelper("incGlobalVar"),
    incMessageVar: makeUnsupportedHelper("incMessageVar"),
    decLocalVar: makeUnsupportedHelper("decLocalVar"),
    decGlobalVar: makeUnsupportedHelper("decGlobalVar"),
    decMessageVar: makeUnsupportedHelper("decMessageVar"),
    patchVariables: makeUnsupportedHelper("patchVariables"),
    getprp: makeUnsupportedHelper("getprp"),
    getpreset: makeUnsupportedHelper("getpreset"),
    getPresetPrompt: makeUnsupportedHelper("getPresetPrompt"),
    execute: makeUnsupportedHelper("execute"),
    define: makeUnsupportedHelper("define"),
    getqr: makeUnsupportedHelper("getqr"),
    getQuickReply: makeUnsupportedHelper("getQuickReply"),
    selectActivatedEntries: makeUnsupportedHelper("selectActivatedEntries"),
    activateWorldInfoByKeywords: makeUnsupportedHelper("activateWorldInfoByKeywords"),
    activateRegex: makeUnsupportedHelper("activateRegex"),
    injectPrompt: makeUnsupportedHelper("injectPrompt"),
    getPromptsInjected: makeUnsupportedHelper("getPromptsInjected"),
    hasPromptsInjected: makeUnsupportedHelper("hasPromptsInjected"),
    jsonPatch: makeUnsupportedHelper("jsonPatch"),
  };

  const context = {
    _: utilityLib,
    console,
    userName: snapshot.user.name,
    charName: snapshot.character.name,
    assistantName: snapshot.character.name,
    charDescription: snapshot.character.description || "",
    userPersona: snapshot.persona.text || "",
    currentTime: snapshot.time.current || "",
    characterId: snapshot.character.id,
    hostSnapshot: snapshot,
    stSnapshot: snapshot,
    get chatId() {
      return snapshot.chat.id || "";
    },
    get variables() {
      return renderCtx.variableState.cacheVars;
    },
    get lastUserMessageId() {
      if (typeof chat.findLastIndex === "function") {
        return chat.findLastIndex((message) => message?.is_user);
      }
      const reversedIndex = [...chat].reverse().findIndex((message) => message?.is_user);
      return reversedIndex < 0 ? -1 : chat.length - 1 - reversedIndex;
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
      if (typeof chat.findLastIndex === "function") {
        return chat.findLastIndex(
          (message) => !message?.is_user && !message?.is_system,
        );
      }
      const reversedIndex = [...chat]
        .reverse()
        .findIndex((message) => !message?.is_user && !message?.is_system);
      return reversedIndex < 0 ? -1 : chat.length - 1 - reversedIndex;
    },
    get lastCharMessage() {
      return (
        chat.findLast?.((message) => !message?.is_user && !message?.is_system)?.mes ||
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
      return snapshot.worldbook.character || "";
    },
    get userLoreBook() {
      return snapshot.worldbook.persona || "";
    },
    get chatLoreBook() {
      return snapshot.worldbook.chat || "";
    },
    get charAvatar() {
      return snapshot.character.avatar || "";
    },
    userAvatar: snapshot.user.avatar || "",
    groups: stCtx.groups || [],
    groupId: snapshot.host.meta.selectedGroupId,
    get model() {
      return snapshot.host.meta.onlineStatus || "";
    },
    get SillyTavern() {
      return stCtx;
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
    getvar: (path, options) => getVariable(renderCtx.variableState, path, options),
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
    getChatMessage: (id, role) => getChatMessageCompat(renderCtx, id, role),
    getChatMessages: (startOrCount = getStChat(hostSnapshot).length, endOrRole, role) =>
      getChatMessagesCompat(renderCtx, startOrCount, endOrRole, role),
    matchChatMessages: (pattern) => matchChatMessagesCompat(renderCtx, pattern),
    getchr: () => snapshot.character.description || "",
    evalTemplate: async (innerContent, data = {}) =>
      evalTaskEjsTemplate(innerContent, renderCtx, data),
    getWorldInfoData: async () =>
      renderCtx.entries.map((entry) => ({
        comment: entry.comment || entry.name,
        content: entry.content,
        world: entry.worldbook,
      })),
    getWorldInfoActivatedData: async () =>
      getCurrentActivatedEntries(renderCtx).map((entry) => ({
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
    getEnabledLoreBooks: () => [...new Set(renderCtx.entries.map((entry) => entry.worldbook))],
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
    parseJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    print: (...parts) =>
      parts.filter((part) => part !== undefined && part !== null).join(""),
    ...unsupported,
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
    if (renderCtx && typeof renderCtx === "object") {
      renderCtx.ejsLastError =
        error instanceof Error ? error.message : String(error);
    }
    if (error?.code === "st_bme_task_ejs_unsupported_helper") {
      throw error;
    }
    console.warn("[ST-BME] task-ejs 渲染失败:", error);
    throw error;
  }
}

export async function renderTaskEjsContent(content, templateContext = {}) {
  const hostSnapshot = resolveHostSnapshot(templateContext.hostSnapshot);
  const processed = substituteTaskEjsParams(content, templateContext, {
    hostSnapshot,
  });
  if (!processed.includes("<%")) {
    return processed;
  }

  const renderCtx = createTaskEjsRenderContext([], {
    templateContext,
    hostSnapshot,
  });
  return await evalTaskEjsTemplate(processed, renderCtx);
}

export async function checkTaskEjsSyntax(content) {
  const backend = await resolveTaskEjsBackend();
  const runtime = backend.runtime;
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

export async function inspectTaskEjsRuntimeBackend(options = {}) {
  return await resolveTaskEjsBackend(options);
}
