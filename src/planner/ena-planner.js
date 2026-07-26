const DEFAULT_KEEP_TAGS = Object.freeze(["plot", "note", "plot-log", "state"]);
const DEFAULT_CHAT_EXCLUDE_TAGS = Object.freeze([
  "行动选项",
  "UpdateVariable",
  "StatusPlaceHolderImpl",
]);
const OPTION_KEYS = new Set([
  "enabled",
  "skipIfPlotPresent",
  "plotHistoryCount",
  "recentAssistantMessages",
  "responseKeepTags",
  "chatExcludeTags",
]);

export const DEFAULT_ENA_OPTIONS = Object.freeze({
  enabled: false,
  skipIfPlotPresent: true,
  plotHistoryCount: 2,
  recentAssistantMessages: 2,
  responseKeepTags: DEFAULT_KEEP_TAGS,
  chatExcludeTags: DEFAULT_CHAT_EXCLUDE_TAGS,
});

function normalizeBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeCount(value, fallback, label) {
  if (value === undefined) return fallback;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 50) {
    throw new TypeError(`${label} must be an integer between 0 and 50`);
  }
  return count;
}

function normalizeTags(value, fallback, label) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const tags = value.map((tag, index) => {
    if (typeof tag !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    const normalized = tag.trim();
    if (!normalized) throw new TypeError(`${label}[${index}] must not be empty`);
    return normalized;
  });
  return [...new Set(tags)];
}

export function normalizeEnaOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ENA options must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !OPTION_KEYS.has(key));
  if (unknown.length > 0) throw new TypeError(`unknown ENA option: ${unknown[0]}`);
  const responseKeepTags = normalizeTags(
    value.responseKeepTags,
    DEFAULT_KEEP_TAGS,
    "responseKeepTags",
  ).map((tag) => {
    const normalized = tag.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
      throw new TypeError(`invalid response keep tag: ${tag}`);
    }
    return normalized;
  });
  return Object.freeze({
    enabled: normalizeBoolean(value.enabled, DEFAULT_ENA_OPTIONS.enabled, "enabled"),
    skipIfPlotPresent: normalizeBoolean(
      value.skipIfPlotPresent,
      DEFAULT_ENA_OPTIONS.skipIfPlotPresent,
      "skipIfPlotPresent",
    ),
    plotHistoryCount: normalizeCount(
      value.plotHistoryCount,
      DEFAULT_ENA_OPTIONS.plotHistoryCount,
      "plotHistoryCount",
    ),
    recentAssistantMessages: normalizeCount(
      value.recentAssistantMessages,
      DEFAULT_ENA_OPTIONS.recentAssistantMessages,
      "recentAssistantMessages",
    ),
    responseKeepTags: Object.freeze([...new Set(responseKeepTags)]),
    chatExcludeTags: Object.freeze(normalizeTags(
      value.chatExcludeTags,
      DEFAULT_CHAT_EXCLUDE_TAGS,
      "chatExcludeTags",
    )),
  });
}

function normalizeUserInput(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function decideEnaSend(input, optionsInput = {}) {
  const options = normalizeEnaOptions(optionsInput);
  const raw = String(input ?? "");
  if (!options.enabled) return { intercept: false, reason: "disabled", input: raw };
  const normalized = normalizeUserInput(raw);
  if (!normalized) return { intercept: false, reason: "empty", input: raw };
  if (normalized.startsWith("/")) {
    return { intercept: false, reason: "slash-command", input: raw };
  }
  if (options.skipIfPlotPresent && /<plot\b/i.test(normalized)) {
    return { intercept: false, reason: "plot-present", input: raw };
  }
  return { intercept: true, reason: "enabled", input: raw };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPlannerThinking(value) {
  return String(value ?? "")
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, "")
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, "")
    .trim();
}

function extractTaggedBlocks(value, tags) {
  const names = [...new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter(Boolean))];
  if (names.length === 0) return [];
  const pattern = names.map(escapeRegExp).join("|");
  const matches = String(value ?? "").match(
    new RegExp(`<(${pattern})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
  );
  return matches || [];
}

function filterPlannerOutput(value, keepTags = DEFAULT_KEEP_TAGS) {
  const withoutThinking = stripPlannerThinking(value);
  const selected = extractTaggedBlocks(withoutThinking, keepTags);
  return selected.length > 0 ? selected.join("\n\n").trim() : withoutThinking;
}

function extractPlotBlocks(value) {
  return extractTaggedBlocks(value, ["plot"]).map((block) => block.trim());
}

function cleanAssistantText(value, excludeTags) {
  let text = stripPlannerThinking(value);
  for (const tag of excludeTags) {
    const escaped = escapeRegExp(tag);
    text = text
      .replace(new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"), "")
      .replace(new RegExp(`<\\/${escaped}>`, "gi"), "")
      .replace(new RegExp(`<${escaped}(?:[^>]*)\\/?>`, "gi"), "");
  }
  return text.trim();
}

function formatRecentAssistantHistory(history, count, excludeTags = []) {
  if (!count) return "";
  const messages = (Array.isArray(history) ? history : [])
    .filter(({ role }) => role === "assistant" || role === "greeting")
    .slice(-count)
    .map(({ speaker, text }) => {
      const cleaned = cleanAssistantText(text, excludeTags);
      return cleaned ? `[${String(speaker || "assistant")}] ${cleaned}` : "";
    })
    .filter(Boolean);
  return messages.length > 0
    ? `<chat_history>\n${messages.join("\n")}\n</chat_history>`
    : "";
}

function formatPlannerHistory(records, count) {
  if (!count) return "";
  const selected = [...(Array.isArray(records) ? records : [])]
    .sort((left, right) => Number(left.createdAt) - Number(right.createdAt) ||
      String(left.turnKey || "").localeCompare(String(right.turnKey || "")))
    .slice(-count);
  const plots = [];
  const seen = new Set();
  for (const record of selected) {
    const blocks = Array.isArray(record.plotBlocks) && record.plotBlocks.length > 0
      ? record.plotBlocks
      : extractPlotBlocks(record.plotText);
    const plot = blocks.join("\n").trim();
    if (!plot || seen.has(plot)) continue;
    seen.add(plot);
    plots.push(plot);
  }
  if (plots.length === 0) return "";
  const lines = plots.map(
    (plot, index) => `【plot -${plots.length - index}】\n${plot}`,
  );
  return `<previous_plots>\n${lines.join("\n\n")}\n</previous_plots>`;
}

function formatPlannerCharacter(character = {}) {
  const raw = character.raw || character;
  const data = raw?.data || {};
  const name = String(character.name || raw?.name || "").trim();
  const description = String(raw?.description || data.description || character.description || "").trim();
  const personality = String(raw?.personality || data.personality || "").trim();
  const scenario = String(raw?.scenario || data.scenario || "").trim();
  const parts = [];
  if (name) parts.push(`【角色卡】${name}`);
  if (description) parts.push(`【description】\n${description}`);
  if (personality) parts.push(`【personality】\n${personality}`);
  if (scenario) parts.push(`【scenario】\n${scenario}`);
  return parts.join("\n\n");
}

function toPromptMessages(history) {
  return (Array.isArray(history) ? history : []).map(({ role, speaker, text }) => ({
    role: role === "greeting" ? "assistant" : role,
    name: String(speaker || ""),
    content: String(text || ""),
  }));
}

export class EnaPlannerService {
  #getSettings;
  #getHostContext;
  #buildPrompt;
  #buildPayload;
  #complete;
  #runtime = null;

  constructor({
    getSettings = () => ({}),
    getHostContext = () => ({}),
    buildPrompt = null,
    buildPayload = null,
    complete = null,
  } = {}) {
    if (typeof getSettings !== "function") throw new TypeError("getSettings is required");
    if (typeof getHostContext !== "function") throw new TypeError("getHostContext is required");
    this.#getSettings = getSettings;
    this.#getHostContext = getHostContext;
    this.#buildPrompt = buildPrompt;
    this.#buildPayload = buildPayload;
    this.#complete = complete;
  }

  async run({
    rawUserInput,
    recallText = "",
    history = [],
    plannerRecords = [],
    options: optionsInput = {},
    signal,
    onProgress = null,
  } = {}) {
    const options = normalizeEnaOptions(optionsInput);
    const raw = String(rawUserInput ?? "");
    if (!normalizeUserInput(raw)) throw new TypeError("rawUserInput is required");
    const settings = await this.#getSettings();
    const host = await this.#getHostContext();
    const snapshot = host?.snapshot || host || {};
    const promptAliases = host?.prompt || {};
    const runtime = await this.#loadRuntime();
    const context = {
      ...snapshot,
      ...promptAliases,
      chatMessages: toPromptMessages(history),
      userMessage: raw,
      plannerCharacterCard: formatPlannerCharacter(snapshot.character || {}),
      plannerMemory: String(recallText || "").trim()
        ? `<bme_memory>\n${String(recallText).trim()}\n</bme_memory>`
        : "",
      plannerPreviousPlots: formatPlannerHistory(
        plannerRecords,
        options.plotHistoryCount,
      ),
      plannerRecentChat: formatRecentAssistantHistory(
        history,
        options.recentAssistantMessages,
        options.chatExcludeTags,
      ),
      plannerUserInput: `以下是玩家的最新指令哦~:\n[${raw}]`,
    };
    const promptBuild = await runtime.buildPrompt(settings || {}, "planner", context);
    const payload = runtime.buildPayload(promptBuild, raw);
    const configuredMaxTokens = promptBuild.profile?.generation?.max_completion_tokens;
    const rawReply = await runtime.complete(payload.systemPrompt, payload.userPrompt, {
      taskType: "planner",
      requestSource: "planner:ena",
      promptMessages: payload.promptMessages,
      additionalMessages: payload.additionalMessages,
      debugContext: promptBuild,
      maxCompletionTokens: configuredMaxTokens !== null && configuredMaxTokens !== undefined &&
        Number.isFinite(Number(configuredMaxTokens))
        ? Number(configuredMaxTokens)
        : null,
      onStreamProgress: typeof onProgress === "function"
        ? (progress) => onProgress(progress)
        : null,
      signal,
    });
    const filtered = filterPlannerOutput(rawReply, options.responseKeepTags);
    return {
      rawReply: String(rawReply || ""),
      filtered,
      plotBlocks: extractPlotBlocks(filtered),
      promptProfileId: String(promptBuild.profile?.id || "default"),
    };
  }

  async #loadRuntime() {
    if (this.#runtime) return this.#runtime;
    if (this.#buildPrompt && this.#buildPayload && this.#complete) {
      this.#runtime = {
        buildPrompt: this.#buildPrompt,
        buildPayload: this.#buildPayload,
        complete: this.#complete,
      };
      return this.#runtime;
    }
    const [prompting, llm] = await Promise.all([
      import("../../prompting/prompt-builder.js"),
      import("../../llm/llm.js"),
    ]);
    this.#runtime = {
      buildPrompt: this.#buildPrompt || prompting.buildTaskPrompt,
      buildPayload: this.#buildPayload || prompting.buildTaskLlmPayload,
      complete: this.#complete || llm.callLLM,
    };
    return this.#runtime;
  }
}
