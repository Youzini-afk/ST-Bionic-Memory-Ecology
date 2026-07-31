import { extension_settings } from '../host/st-extensions.js';
import { getRequestHeaders, substituteParamsExtended } from '../host/st-script.js';
import {
    addPlannerSendListeners,
    getPlannerCharacterGlobalsDebug,
    getPlannerChatMetadataVariables,
    getPlannerCurrentCharacter,
    getPlannerHostChat,
    getPlannerHostContext,
    getPlannerHostEjs,
    getPlannerHostEjsTemplate,
    getPlannerHostWindowLike,
    getPlannerLatestMessageVariables,
    getPlannerSendButton,
    getPlannerSendTextarea,
    getPlannerTavernHelper,
    getPlannerWorldInfoModule,
    removePlannerSendListeners,
    setPlannerSendBusy,
    showPlannerHostError,
} from '../host/ena-planner-host.js';
import { EnaPlannerStorage } from './ena-planner-storage.js';
import {
    applyPlannerResultAndSend,
    normalizeEnaPlannerConfig,
    shouldInterceptPlannerEnter,
    shouldInterceptPlannerSend,
} from './ena-planner-runtime-utils.js';
import {
    collectPlannerCharacterWorldbookNames,
    collectPlannerGlobalWorldbookNames,
    isPlannerWorldbookEntryConstant,
    isPlannerWorldbookEntryEnabled,
    normalizePlannerWorldbookEntries,
    shouldExcludePlannerWorldbookEntry,
} from './ena-planner-worldbook-utils.js';
import { readPlannerPlotHistory } from './planner-plot-history.js';
import { getActiveTaskProfile } from '../prompting/prompt-profiles.js';
import {
    resolveDedicatedLlmProviderConfig,
    resolveLlmConfigSelection,
} from '../llm/llm-preset-utils.js';
import { debugLog } from '../runtime/debug-logging.js';
import { showManagedBmeNotice } from '../ui/notice.js';
import jsyaml from '../vendor/js-yaml.mjs';

const BME_MODULE_NAME = 'st_bme';
const PLANNER_TASK_TYPE = 'planner';
const VECTOR_RECALL_TIMEOUT_MS = 30000;
const PLANNER_REQUEST_TIMEOUT_MS = 90000;

let _bmeRuntime = null;

function getPlannerRecallTimeoutMs() {
    const timeoutMs = Number(_bmeRuntime?.getPlannerRecallTimeoutMs?.());
    return Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : VECTOR_RECALL_TIMEOUT_MS;
}

function getPlannerRequestTimeoutMs() {
    const timeoutMs = Number(_bmeRuntime?.getPlannerRecallTimeoutMs?.());
    return Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : PLANNER_REQUEST_TIMEOUT_MS;
}

/**
 * -------------------------
 * Local state
 * --------------------------
 */
const state = {
    isPlanning: false,
    bypassNextSend: false,
    activeRun: null,
    logs: []
};

let _activePlannerNotice = null;

let config = null;
let sendListenersInstalled = false;
let sendClickHandler = null;
let sendKeydownHandler = null;

/**
 * Native UI subscribers (replaces the iframe postMessage channel).
 * Callbacks receive `(kind, payload)` where kind is 'config' or 'logs'.
 */
const nativeSubscribers = new Set();

function notifyNativeChange(kind, payload) {
    if (!nativeSubscribers.size) return;
    for (const cb of nativeSubscribers) {
        try { cb(kind, payload); }
        catch (err) { console.warn('[Ena] native subscriber error:', err); }
    }
}

function getBmeSettings() {
    const settings = extension_settings?.[BME_MODULE_NAME];
    return settings && typeof settings === 'object' ? settings : {};
}

function getPlannerTaskProfile() {
    return getActiveTaskProfile(getBmeSettings(), PLANNER_TASK_TYPE);
}

function sortPlannerProfileBlocks(blocks = []) {
    return [...(Array.isArray(blocks) ? blocks : [])]
        .map((block, index) => ({ ...block, _orderIndex: index }))
        .sort((left, right) => {
            const leftOrder = Number.isFinite(Number(left?.order))
                ? Number(left.order)
                : left._orderIndex;
            const rightOrder = Number.isFinite(Number(right?.order))
                ? Number(right.order)
                : right._orderIndex;
            return leftOrder - rightOrder;
        });
}

function normalizePlannerGenerationNumber(value) {
    if (value == null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * -------------------------
 * Helpers
 * --------------------------
 */
function ensureSettings() {
    config = normalizeEnaPlannerConfig(config);
    config.responseKeepTags = normalizeResponseKeepTags(config.responseKeepTags);
    return config;
}

function normalizeResponseKeepTags(tags) {
    const src = Array.isArray(tags) ? tags : [];
    const cleaned = [];
    for (const raw of src) {
        const t = String(raw || '')
            .trim()
            .replace(/^<+|>+$/g, '')
            .toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(t)) continue;
        if (!cleaned.includes(t)) cleaned.push(t);
    }
    return cleaned;
}

async function loadConfig() {
    const [loaded, logs] = await Promise.all([
        EnaPlannerStorage.get('config', null),
        EnaPlannerStorage.get('logs', []),
    ]);
    config = normalizeEnaPlannerConfig(loaded);
    state.logs = Array.isArray(logs) ? logs : [];
    return config;
}

async function saveConfigNow() {
    ensureSettings();
    await EnaPlannerStorage.set('config', config);
    await EnaPlannerStorage.set('logs', state.logs);
    try {
        return await EnaPlannerStorage.saveNow({ silent: false });
    } catch {
        return false;
    }
}

function toastErr(msg) {
    if (showPlannerHostError(msg)) return;
    console.error('[EnaPlanner]', msg);
}

function closeActivePlannerNotice() {
    if (_activePlannerNotice) {
        try { _activePlannerNotice.dismiss(); } catch {}
        _activePlannerNotice = null;
    }
}

function startPlannerNotice(message = '') {
    closeActivePlannerNotice();
    _activePlannerNotice = showManagedBmeNotice({
        title: '🧭 剧情规划',
        message,
        level: 'info',
        busy: true,
        persist: true,
        marquee: true,
    });
    return _activePlannerNotice;
}

function updatePlannerNotice(message = '', opts = {}) {
    const mergedOpts = {
        level: 'info',
        busy: false,
        persist: false,
        marquee: false,
        duration_ms: 3200,
        ...opts,
    };
    const payload = {
        title: '🧭 剧情规划',
        message,
        ...mergedOpts,
    };
    if (!_activePlannerNotice || _activePlannerNotice.isClosed()) {
        _activePlannerNotice = showManagedBmeNotice(payload);
        return _activePlannerNotice;
    }
    _activePlannerNotice.update(payload);
    return _activePlannerNotice;
}

function clampLogs() {
    const s = ensureSettings();
    if (state.logs.length > s.logsMax) state.logs = state.logs.slice(0, s.logsMax);
}

function persistLogsMaybe() {
    const s = ensureSettings();
    if (s.logsPersist) {
        state.logs = state.logs.slice(0, s.logsMax);
        EnaPlannerStorage.set('logs', state.logs).catch(() => {});
    }
    try { notifyNativeChange('logs', getPlannerLogsSnapshot()); } catch {}
}

function loadPersistedLogsMaybe() {
    const s = ensureSettings();
    if (!s.logsPersist) state.logs = [];
}

function nowISO() {
    return new Date().toISOString();
}

function createPlannerAbortError(message = 'ENA Planner 已终止') {
    return Object.assign(new Error(message), { name: 'AbortError' });
}

function isPlannerAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfPlannerAborted(signal, message) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : createPlannerAbortError(message);
}

function createCombinedAbortSignal(...signals) {
    const validSignals = signals.filter(Boolean);
    if (validSignals.length <= 1) return validSignals[0];
    if (
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.any === 'function'
    ) {
        return AbortSignal.any(validSignals);
    }

    const controller = new AbortController();
    for (const signal of validSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

function normalizeUrlBase(u) {
    if (!u) return '';
    return u.replace(/\/+$/g, '');
}

function inferPlannerChannelFromUrl(url) {
    const resolved = resolveDedicatedLlmProviderConfig(String(url || '').trim());
    if (resolved.providerId === 'google-ai-studio') return 'gemini';
    if (resolved.providerId === 'anthropic-claude') return 'claude';
    return 'openai';
}

function buildResolvedPlannerApiConfigFromLlmSelection(selection = {}) {
    const snapshot = selection?.config && typeof selection.config === 'object'
        ? selection.config
        : {};
    const inputUrl = String(snapshot?.llmApiUrl || '').trim();
    const resolved = resolveDedicatedLlmProviderConfig(inputUrl);
    const baseUrl = String(resolved.apiUrl || inputUrl).trim();
    return {
        channel: inferPlannerChannelFromUrl(baseUrl),
        baseUrl,
        apiKey: String(snapshot?.llmApiKey || '').trim(),
        model: String(snapshot?.llmModel || '').trim(),
    };
}

function resolvePlannerApiConfig() {
    const s = ensureSettings();
    const selectedPresetName = String(s?.api?.llmPreset || '').trim();
    if (selectedPresetName) {
        return buildResolvedPlannerApiConfigFromLlmSelection(
            resolveLlmConfigSelection(getBmeSettings(), selectedPresetName),
        );
    }
    return buildResolvedPlannerApiConfigFromLlmSelection(
        resolveLlmConfigSelection(getBmeSettings(), ''),
    );
}

function getDefaultPrefixByChannel(channel) {
    if (channel === 'gemini') return '/v1beta';
    return '/v1';
}

function buildApiPrefix(apiConfig = resolvePlannerApiConfig()) {
    return getDefaultPrefixByChannel(apiConfig?.channel);
}

function buildUrl(path, apiConfig = resolvePlannerApiConfig()) {
    const base = normalizeUrlBase(apiConfig?.baseUrl);
    const prefix = buildApiPrefix(apiConfig);
    const p = prefix.startsWith('/') ? prefix : `/${prefix}`;
    const finalPrefix = p.replace(/\/+$/g, '');
    const finalPath = path.startsWith('/') ? path : `/${path}`;
    const escapedPrefix = finalPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasSameSuffix = !!finalPrefix && new RegExp(`${escapedPrefix}$`, 'i').test(base);
    const normalizedBase = hasSameSuffix ? base.slice(0, -finalPrefix.length) : base;
    return `${normalizedBase}${finalPrefix}${finalPath}`;
}

function setSendUIBusy(busy) {
    setPlannerSendBusy(busy);
}

function safeStringify(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    try { return JSON.stringify(val, null, 2); } catch { return String(val); }
}

/**
 * -------------------------
 * ST context helpers
 * --------------------------
 */
function getContextSafe() {
    return getPlannerHostContext();
}

async function getStWorldInfoModuleSafe() {
    return await getPlannerWorldInfoModule();
}

function getTavernHelperSafe() {
    return getPlannerTavernHelper();
}

function getCurrentCharSafe() {
    return getPlannerCurrentCharacter();
}

/**
 * -------------------------
 * Character card — always include desc/personality/scenario
 * --------------------------
 */
function formatCharCardBlock(charObj) {
    if (!charObj) return '';
    const name = charObj?.name ?? '';
    const description = charObj?.description ?? '';
    const personality = charObj?.personality ?? '';
    const scenario = charObj?.scenario ?? '';

    const parts = [];
    parts.push(`【角色卡】${name}`.trim());
    if (description) parts.push(`【description】\n${description}`);
    if (personality) parts.push(`【personality】\n${personality}`);
    if (scenario) parts.push(`【scenario】\n${scenario}`);
    return parts.join('\n\n');
}

/**
 * -------------------------
 * Chat history — ALL unhidden, AI responses ONLY
 * Strip: unclosed think blocks, configurable tags
 * --------------------------
 */
function cleanAiMessageText(text) {
    let out = String(text ?? '');

    // 1) Strip everything before and including </think> (handles unclosed think blocks)
    out = out.replace(/^[\s\S]*?<\/think>/i, '');
    out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
    out = out.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '');

    // 2) Strip user-configured exclude tags
    //    NOTE: JS \b does NOT work after CJK characters, so we use [^>]*> instead.
    //    Order matters: try block match first (greedy), then mop up orphan open/close tags.
    const s = ensureSettings();
    const tags = s.chatExcludeTags ?? [];
    for (const tag of tags) {
        if (!tag) continue;
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // First: match full block <tag ...>...</tag>
        const blockRe = new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi');
        out = out.replace(blockRe, '');
        // Then: mop up any orphan closing tags </tag>
        const closeRe = new RegExp(`<\\/${escaped}>`, 'gi');
        out = out.replace(closeRe, '');
        // Finally: mop up orphan opening or self-closing tags <tag ...> or <tag/>
        const openRe = new RegExp(`<${escaped}(?:[^>]*)\\/?>`, 'gi');
        out = out.replace(openRe, '');
    }

    return out.trim();
}

function collectRecentChatSnippet(chat, maxMessages) {
    if (!Array.isArray(chat) || chat.length === 0) return '';

    // Filter: not system, not hidden, and NOT user messages (AI only)
    const aiMessages = chat.filter(m =>
        !m?.is_system && !m?.is_user && !m?.extra?.hidden
    );

    if (!aiMessages.length) return '';

    // If maxMessages specified, only take the last N
    const selected = (maxMessages && maxMessages > 0)
        ? aiMessages.slice(-maxMessages)
        : aiMessages;

    const lines = [];
    for (const m of selected) {
        const name = m?.name ? `${m.name}` : 'assistant';
        const raw = (m?.mes ?? '').trim();
        if (!raw) continue;
        const cleaned = cleanAiMessageText(raw);
        if (!cleaned) continue;
        lines.push(`[${name}] ${cleaned}`);
    }

    if (!lines.length) return '';
    return `<chat_history>\n${lines.join('\n')}\n</chat_history>`;
}

/**
 * -------------------------
 * Plot extraction
 * --------------------------
 */
/**
 * -------------------------
 * Worldbook — read via ST API (like idle-watcher)
 * Always read character-linked worldbooks.
 * Optionally include global worldbooks.
 * Activation: constant (blue) + keyword scan (green) only.
 * --------------------------
 */

async function getCharacterWorldbooks() {
    const ctx = getContextSafe();
    const charObj = getCurrentCharSafe();
    const worldNames = await collectPlannerCharacterWorldbookNames({
        context: ctx,
        character: charObj,
        tavernHelper: getTavernHelperSafe(),
        windowLike: getPlannerHostWindowLike(),
    });

    debugLog('[EnaPlanner] Character worldbook names found:', worldNames);
    return worldNames.filter(Boolean);
}

async function getGlobalWorldbooks() {
    const ctx = getContextSafe();
    const worldInfoModule = await getStWorldInfoModuleSafe();
    const worldNames = await collectPlannerGlobalWorldbookNames({
        context: ctx,
        tavernHelper: getTavernHelperSafe(),
        worldInfoModule,
        windowLike: getPlannerHostWindowLike(),
    });
    debugLog('[EnaPlanner] Global worldbook names found:', worldNames);
    return worldNames;
}

async function getWorldbookData(worldName) {
    if (!worldName) return null;
    const ctx = getContextSafe();
    const helper = getTavernHelperSafe();

    try {
        if (typeof helper?.getWorldbook === 'function') {
            return {
                name: worldName,
                entries: normalizePlannerWorldbookEntries(worldName, await helper.getWorldbook(worldName)),
            };
        }
    } catch (e) {
        console.warn(`[EnaPlanner] TavernHelper getWorldbook failed for "${worldName}":`, e);
    }

    try {
        if (typeof helper?.getLorebookEntries === 'function') {
            return {
                name: worldName,
                entries: normalizePlannerWorldbookEntries(worldName, await helper.getLorebookEntries(worldName)),
            };
        }
    } catch (e) {
        console.warn(`[EnaPlanner] TavernHelper getLorebookEntries failed for "${worldName}":`, e);
    }

    try {
        if (typeof ctx?.loadWorldInfo === 'function') {
            return {
                name: worldName,
                entries: normalizePlannerWorldbookEntries(worldName, await ctx.loadWorldInfo(worldName)),
            };
        }
    } catch (e) {
        console.warn(`[EnaPlanner] ST loadWorldInfo failed for "${worldName}":`, e);
    }

    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName }),
        });
        if (response.ok) {
            const data = await response.json();
            return { name: worldName, entries: normalizePlannerWorldbookEntries(worldName, data) };
        }
    } catch (e) {
        console.warn(`[EnaPlanner] Failed to load worldbook "${worldName}":`, e);
    }
    return null;
}

function keywordPresent(text, kw) {
    if (!kw) return false;
    return text.toLowerCase().includes(kw.toLowerCase());
}

function matchSelective(entry, scanText) {
    const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean) : [];
    const keys2 = Array.isArray(entry?.keysecondary) ? entry.keysecondary.filter(Boolean) : [];

    const total = keys.length;
    if (total === 0) return false;
    const hit = keys.reduce((acc, kw) => acc + (keywordPresent(scanText, kw) ? 1 : 0), 0);

    let ok = false;
    const logic = entry?.selectiveLogic ?? 0;
    if (logic === 0) ok = (total === 0) ? true : hit > 0;       // and_any
    else if (logic === 1) ok = (total === 0) ? true : hit < total; // not_all
    else if (logic === 2) ok = (total === 0) ? true : hit === 0;  // not_any
    else if (logic === 3) ok = (total === 0) ? true : hit === total; // and_all

    if (!ok) return false;

    if (keys2.length) {
        const hit2 = keys2.reduce((acc, kw) => acc + (keywordPresent(scanText, kw) ? 1 : 0), 0);
        if (hit2 <= 0) return false;
    }
    return true;
}

function sortWorldEntries(entries) {
    // Sort to mimic ST insertion order within our worldbook block.
    // Position priority: 0 (before char def) → 1 (after char def) → 4 (system depth)
    // Within pos=4: depth descending (bigger depth = further from chat = earlier)
    // Same position+depth: order ascending (higher order = closer to chat_history = later)
    const posPriority = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 };
    return [...entries].sort((a, b) => {
        const pa = posPriority[Number(a?.position ?? 0)] ?? 99;
        const pb = posPriority[Number(b?.position ?? 0)] ?? 99;
        if (pa !== pb) return pa - pb;
        // For same position (especially pos=4): bigger depth = earlier
        const da = Number(a?.depth ?? 0);
        const db = Number(b?.depth ?? 0);
        if (da !== db) return db - da;
        // Same position+depth: order ascending (smaller order first, bigger order later)
        const oa = Number(a?.order ?? 0);
        const ob = Number(b?.order ?? 0);
        return oa - ob;
    });
}

async function buildWorldbookBlock(scanText) {
    const s = ensureSettings();

    // 1. Always get character-linked worldbooks
    const charWorldNames = await getCharacterWorldbooks();

    // 2. Optionally get global worldbooks
    let globalWorldNames = [];
    if (s.includeGlobalWorldbooks) {
        globalWorldNames = await getGlobalWorldbooks();
    }

    // Deduplicate
    const allWorldNames = [...new Set([...charWorldNames, ...globalWorldNames])];

    if (!allWorldNames.length) {
        debugLog('[EnaPlanner] No worldbooks to load');
        return '';
    }

    debugLog('[EnaPlanner] Loading worldbooks:', allWorldNames);

    // Fetch all worldbook data
    const worldbookResults = await Promise.all(allWorldNames.map(name => getWorldbookData(name)));
    const allEntries = [];

    for (const wb of worldbookResults) {
        if (!wb || !wb.entries) continue;
        for (const entry of wb.entries) {
            if (!entry) continue;
            allEntries.push({ ...entry, _worldName: wb.name });
        }
    }

    // Filter: not disabled
    let entries = allEntries.filter(isPlannerWorldbookEntryEnabled);

    // Filter explicit exclusions and, in the default BME mode, MVU-owned entries.
    const nameExcludes = s.worldbookExcludeNames ?? ['mvu_update'];
    const useDefaultMvuFilter = String(
        _bmeRuntime?.getSettings?.()?.worldInfoFilterMode || 'default',
    ).trim() !== 'custom';
    entries = entries.filter(e => !shouldExcludePlannerWorldbookEntry(e, {
        nameExcludes,
        useDefaultMvuFilter,
    }));

    // Filter: exclude position=4 if configured
    if (s.excludeWorldbookPosition4) {
        entries = entries.filter(e => Number(e?.position) !== 4);
    }

    if (!entries.length) return '';

    // Activation: constant (blue) + keyword scan (green) only
    const active = [];
    for (const e of entries) {
        // Blue light: constant entries always included
        if (isPlannerWorldbookEntryConstant(e)) {
            active.push(e);
            continue;
        }
        // Green light: keyword-triggered entries
        if (matchSelective(e, scanText)) {
            active.push(e);
            continue;
        }
    }

    if (!active.length) return '';

    // Build EJS context for rendering worldbook templates
    const ejsCtx = buildEjsContext();

    const sorted = sortWorldEntries(active);
    const parts = [];
    for (const e of sorted) {
        const comment = e?.comment || e?.name || e?.title || '';
        const head = `【WorldBook:${e._worldName}】${comment ? ' ' + comment : ''}`.trim();
        let body = String(e?.content ?? '').trim();
        if (!body) continue;

        // Try EJS rendering if the entry contains EJS tags
        if (body.includes('<%')) {
            body = renderEjsTemplate(
                body,
                ejsCtx,
                `${e._worldName || 'unknown-worldbook'}${comment ? ` / ${comment}` : ''}`,
            );
        }

        parts.push(`${head}\n${body}`);
    }

    if (!parts.length) return '';
    return `<worldbook>\n${parts.join('\n\n---\n\n')}\n</worldbook>`;
}

/**
 * -------------------------
 * EJS rendering for worldbook entries
 * --------------------------
 */
function getChatVariables() {
  let vars = {};

  // 1) Chat-level variables
  try {
    const ctx = getContextSafe();
    if (ctx?.chatMetadata?.variables) vars = { ...ctx.chatMetadata.variables };
  } catch {}
  if (!Object.keys(vars).length) {
    try {
      const hostVariables = getPlannerChatMetadataVariables();
      if (hostVariables) vars = { ...hostVariables };
    } catch {}
  }
  if (!Object.keys(vars).length) {
    try {
      const ctx = getContextSafe();
      if (ctx?.chat_metadata?.variables) vars = { ...ctx.chat_metadata.variables };
    } catch {}
  }

  // 2) Always merge message-level variables (some presets store vars here instead of chat-level)
  try {
    const msgVars = getLatestMessageVarTable();
    if (msgVars && typeof msgVars === 'object') {
      for (const key of Object.keys(msgVars)) {
        // Skip MVU internal metadata keys
        if (key === 'schema' || key === 'display_data' || key === 'delta_data') continue;
        if (vars[key] === undefined) {
          // Chat-level doesn't have this key at all — take from message-level
          vars[key] = msgVars[key];
        } else if (
          vars[key] && typeof vars[key] === 'object' && !Array.isArray(vars[key]) &&
          msgVars[key] && typeof msgVars[key] === 'object' && !Array.isArray(msgVars[key])
        ) {
          // Both have this key as objects — shallow merge (message-level fills gaps)
          for (const subKey of Object.keys(msgVars[key])) {
            if (vars[key][subKey] === undefined) {
              vars[key][subKey] = msgVars[key][subKey];
            }
          }
        }
      }
    }
  } catch {}

  return vars;
}

function buildEjsContext() {
    return createEnaPlannerEjsContext(getChatVariables());
}

export function createEnaPlannerEjsContext(varsInput = {}) {
    const vars = varsInput && typeof varsInput === 'object' ? { ...varsInput } : {};

    // getvar: read a chat variable (supports dot-path for nested objects)
    function getvar(name) {
        if (!name) return '';
        let val;
        if (vars[name] !== undefined) {
            val = vars[name];
        } else {
            const parts = String(name).split('.');
            let cur = vars;
            for (const p of parts) {
                if (cur == null || typeof cur !== 'object') return '';
                cur = cur[p];
            }
            val = cur ?? '';
        }
        // 字符串布尔值转为真正的布尔值
        if (val === 'false' || val === 'False' || val === 'FALSE') return false;
        if (val === 'true' || val === 'True' || val === 'TRUE') return true;
        return val;
    }

    // setvar: write a chat variable (no-op for our purposes, just to avoid errors)
    function setvar(name, value) {
        if (name) vars[name] = value;
        return value;
    }

    return {
        getvar, setvar,
        vars,
        Number, Math, JSON, String, Array, Object, parseInt, parseFloat,
        console: { log: () => { }, warn: () => { }, error: () => { } },
    };
}

function shouldSkipSyncEjsPreRender(template) {
    const src = String(template ?? '');
    if (!src.includes('<%')) return false;

    // Planner worldbook entries are rendered again later with ST's async EJS env.
    // Skip the lightweight sync pre-pass for async templates/helpers so we don't
    // emit misleading warnings for entries that will render correctly downstream.
    if (/\bawait\b/.test(src)) return true;
    if (/\b(getwi|getWorldInfo|evalTemplate)\s*\(/.test(src)) return true;

    return false;
}

export function renderEjsTemplate(template, ctx, templateLabel = '') {
    const labelSuffix = templateLabel ? ` (${templateLabel})` : '';

    if (shouldSkipSyncEjsPreRender(template)) {
        return template;
    }

    const hostEjs = getPlannerHostEjs();
    if (hostEjs?.render) {
        try {
            const renderCtx = ctx && typeof ctx === 'object' ? { ...ctx } : ctx;
            if (renderCtx && typeof renderCtx === 'object') {
                delete renderCtx.__append;
                delete renderCtx.print;
            }
            return hostEjs.render(template, renderCtx, {
                async: false,
                outputFunctionName: 'print',
            });
        } catch (e) {
            console.warn(`[EnaPlanner] EJS render failed${labelSuffix}, template returned as-is:`, e?.message);
            return template;
        }
    }

    // Safe degradation when ejs is not available.
    console.warn(`[EnaPlanner] host EJS not available${labelSuffix}, template returned as-is.`);
    return template;
}

/**
 * -------------------------
 * Template rendering helpers
 * --------------------------
 */
async function prepareEjsEnv() {
    try {
        const et = getPlannerHostEjsTemplate();
        if (!et) return null;
        const fn = et.prepareContext || et.preparecontext;
        if (typeof fn !== 'function') return null;
        return await fn.call(et, {});
    } catch { return null; }
}

async function evalEjsIfPossible(text, env) {
    try {
        const et = getPlannerHostEjsTemplate();
        if (!et || !env) return text;
        const fn = et.evalTemplate || et.evaltemplate;
        if (typeof fn !== 'function') return text;
        return await fn.call(et, text, env);
    } catch { return text; }
}

function substituteMacrosViaST(text) {
    try { return substituteParamsExtended(text); } catch { return text; }
}

function deepGet(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

function resolveGetMessageVariableMacros(text, messageVars) {
    return text.replace(/{{\s*get_message_variable::([^}]+)\s*}}/g, (_, rawPath) => {
        const path = String(rawPath || '').trim();
        if (!path) return '';
        return safeStringify(deepGet(messageVars, path));
    });
}

function resolveFormatMessageVariableMacros(text, messageVars) {
    return text.replace(/{{\s*format_message_variable::([^}]+)\s*}}/g, (_, rawPath) => {
        const path = String(rawPath || '').trim();
        if (!path) return '';
        const val = deepGet(messageVars, path);
        if (val == null) return '';
        if (typeof val === 'string') return val;
        try { return jsyaml.dump(val, { lineWidth: -1, noRefs: true }); } catch { return safeStringify(val); }
    });
}

function getLatestMessageVarTable() {
    return getPlannerLatestMessageVariables();
}

async function renderTemplateAll(text, env, messageVars) {
    let out = String(text ?? '');
    out = await evalEjsIfPossible(out, env);
    out = substituteMacrosViaST(out);
    out = resolveGetMessageVariableMacros(out, messageVars);
    out = resolveFormatMessageVariableMacros(out, messageVars);
    return out;
}

/**
 * -------------------------
 * Planner response filtering
 * --------------------------
 */
function stripThinkBlocks(text) {
    let out = String(text ?? '');
    out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
    out = out.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '');
    return out.trim();
}

function extractSelectedBlocksInOrder(text, tagNames) {
    const names = normalizeResponseKeepTags(tagNames);
    if (!Array.isArray(names) || names.length === 0) return '';
    const src = String(text ?? '');
    const blocks = [];
    const escapedNames = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`<(${escapedNames.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
    let m;
    while ((m = re.exec(src)) !== null) {
        blocks.push(m[0]);
    }
    return blocks.join('\n\n').trim();
}

function filterPlannerForInput(rawFull) {
    const noThink = stripThinkBlocks(rawFull);
    const tags = ensureSettings().responseKeepTags;
    const selected = extractSelectedBlocksInOrder(noThink, tags);
    if (selected) return selected;
    return noThink;
}

/**
 * -------------------------
 * Planner API calls
 * --------------------------
 */
async function callPlanner(messages, options = {}) {
    const apiConfig = resolvePlannerApiConfig();
    if (!apiConfig.baseUrl) throw new Error('未配置可用的 API URL');
    if (!apiConfig.model) throw new Error('未配置可用的模型');
    const generation = resolvePlannerGenerationSettings();

    const url = buildUrl('/chat/completions', apiConfig);

    const body = {
        model: apiConfig.model,
        messages,
        stream: generation.stream === true
    };

    if (generation.temperature != null) body.temperature = generation.temperature;
    if (generation.top_p != null) body.top_p = generation.top_p;
    if (generation.top_k != null && generation.top_k > 0) body.top_k = generation.top_k;
    if (generation.presence_penalty != null) body.presence_penalty = generation.presence_penalty;
    if (generation.frequency_penalty != null) body.frequency_penalty = generation.frequency_penalty;
    if (generation.max_tokens != null && generation.max_tokens > 0) body.max_tokens = generation.max_tokens;

    const timeoutController = new AbortController();
    const plannerRequestTimeoutMs = getPlannerRequestTimeoutMs();
    const timeoutMessage = `规划请求超时（>${Math.floor(plannerRequestTimeoutMs / 1000)}s）`;
    const timeoutId = setTimeout(
        () => timeoutController.abort(createPlannerAbortError(timeoutMessage)),
        plannerRequestTimeoutMs,
    );
    const signal = createCombinedAbortSignal(options.signal, timeoutController.signal);
    try {
        throwIfPlannerAborted(options.signal);
        const headers = {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
        };
        if (apiConfig.apiKey) {
            headers.Authorization = `Bearer ${apiConfig.apiKey}`;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`规划请求失败: ${res.status} ${text}`.slice(0, 500));
        }

        if (!generation.stream) {
            const data = await res.json();
            const text = String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '');
            if (text) options?.onDelta?.(text, text);
            return text;
        }

        // SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        let full = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const chunks = buf.split('\n\n');
            buf = chunks.pop() ?? '';

            for (const ch of chunks) {
                const lines = ch.split('\n').map(x => x.trim()).filter(Boolean);
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') continue;
                    let event;
                    try { event = JSON.parse(payload); }
                    catch { continue; }
                    const delta = event?.choices?.[0]?.delta;
                    const piece = delta?.content ?? delta?.text ?? '';
                    if (piece) {
                        full += piece;
                        options?.onDelta?.(piece, full);
                    }
                }
            }
        }
        return full;
    } catch (err) {
        throwIfPlannerAborted(options.signal);
        if (timeoutController.signal.aborted) throw new Error(timeoutMessage);
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function debugWorldbookForUi() {
    let out = '正在诊断世界书读取...\n';
    const charWb = await getCharacterWorldbooks();
    out += `角色世界书名称: ${JSON.stringify(charWb)}\n`;
    const globalWb = await getGlobalWorldbooks();
    out += `全局世界书名称: ${JSON.stringify(globalWb)}\n`;
    const all = [...new Set([...charWb, ...globalWb])];
    for (const name of all) {
        const data = await getWorldbookData(name);
        const count = data?.entries?.length ?? 0;
        const enabled = data?.entries?.filter(e => !e?.disable && !e?.disabled)?.length ?? 0;
        out += `  "${name}": ${count} 条目, ${enabled} 已启用\n`;
    }
    if (!all.length) {
        out += '⚠️ 未找到任何世界书。请检查角色卡是否绑定了世界书。\n';
        const charObj = getCurrentCharSafe();
        out += `charObj存在: ${!!charObj}\n`;
        if (charObj) {
            out += `charObj.world: ${charObj?.world}\n`;
            out += `charObj.data.extensions.world: ${charObj?.data?.extensions?.world}\n`;
        }
        const ctx = getContextSafe();
        out += `ctx存在: ${!!ctx}\n`;
        if (ctx) {
            out += `ctx.characterId: ${ctx?.characterId}\n`;
            out += `ctx.this_chid: ${ctx?.this_chid}\n`;
        }
    }
    return out;
}

function debugCharForUi() {
    const charObj = getCurrentCharSafe();
    if (!charObj) {
        const ctx = getContextSafe();
        const globals = getPlannerCharacterGlobalsDebug();
        return [
            '⚠️ 未检测到角色。',
            `ctx: ${!!ctx}, ctx.characterId: ${ctx?.characterId}, ctx.this_chid: ${ctx?.this_chid}`,
            `host character id: ${globals.characterId}`,
            `host character count: ${globals.characterCount}`
        ].join('\n');
    }
    const block = formatCharCardBlock(charObj);
    return [
        `角色名: ${charObj?.name}`,
        `desc长度: ${(charObj?.description ?? '').length}`,
        `personality长度: ${(charObj?.personality ?? '').length}`,
        `scenario长度: ${(charObj?.scenario ?? '').length}`,
        `world: ${charObj?.world ?? charObj?.data?.extensions?.world ?? '(无)'}`,
        `---\n${block.slice(0, 500)}...`
    ].join('\n');
}

/**
 * -------------------------
 * Native UI API (consumed by ui/panel-ena-sections.js)
 * These replace the iframe postMessage channel with direct function calls.
 * --------------------------
 */
function getPlannerConfigSnapshot() {
    return structuredClone(ensureSettings());
}

function getPlannerLogsSnapshot() {
    return Array.isArray(state.logs) ? structuredClone(state.logs) : [];
}

function subscribePlannerChanges(cb) {
    if (typeof cb !== 'function') return () => {};
    nativeSubscribers.add(cb);
    return () => nativeSubscribers.delete(cb);
}

async function patchPlannerConfig(patch) {
    if (!patch || typeof patch !== 'object') {
        return { ok: false, error: '无效的补丁' };
    }
    const current = ensureSettings();
    config = normalizeEnaPlannerConfig({
        ...current,
        ...patch,
        api: {
            ...current.api,
            ...(patch.api && typeof patch.api === 'object' ? patch.api : {}),
        },
    });
    config.responseKeepTags = normalizeResponseKeepTags(config.responseKeepTags);
    const ok = await saveConfigNow();
    if (ok) {
        notifyNativeChange('config', getPlannerConfigSnapshot());
        return { ok: true, config: getPlannerConfigSnapshot() };
    }
    return { ok: false, error: '保存失败' };
}

async function runPlannerTestFromUi(text) {
    const fake = String(text || '').trim() || '（测试输入）我想让你帮我规划下一步剧情。';
    try {
        await runPlanningOnce(fake, true);
        notifyNativeChange('logs', getPlannerLogsSnapshot());
        return { ok: true };
    } catch (err) {
        notifyNativeChange('logs', getPlannerLogsSnapshot());
        return { ok: false, error: String(err?.message ?? err) };
    }
}

async function debugPlannerWorldbookFromUi() {
    try {
        return { ok: true, output: await debugWorldbookForUi() };
    } catch (err) {
        return { ok: false, output: String(err?.message ?? err) };
    }
}

function debugPlannerCharFromUi() {
    try {
        return { ok: true, output: debugCharForUi() };
    } catch (err) {
        return { ok: false, output: String(err?.message ?? err) };
    }
}

async function clearPlannerLogs() {
    state.logs = [];
    const ok = await saveConfigNow();
    notifyNativeChange('logs', getPlannerLogsSnapshot());
    return { ok };
}

/**
 * -------------------------
 * Build planner messages
 * --------------------------
 */
function resolvePlannerGenerationSettings() {
    const profile = getPlannerTaskProfile();
    const generation = profile?.generation && typeof profile.generation === 'object'
        ? profile.generation
        : {};

    const pickNumber = (profileValue, fallbackValue = null) => {
        const normalizedProfileValue = normalizePlannerGenerationNumber(profileValue);
        if (normalizedProfileValue != null) return normalizedProfileValue;
        return normalizePlannerGenerationNumber(fallbackValue);
    };

    const stream =
        generation?.stream === true
            ? true
            : generation?.stream === false
                ? false
                : true;

    return {
        profile,
        stream,
        temperature: pickNumber(generation?.temperature, 1),
        top_p: pickNumber(generation?.top_p, 1),
        top_k: pickNumber(generation?.top_k, 0),
        presence_penalty: pickNumber(generation?.presence_penalty),
        frequency_penalty: pickNumber(generation?.frequency_penalty),
        max_tokens: pickNumber(generation?.max_completion_tokens),
    };
}

function getPlannerPromptBlocksForRuntime() {
    const profile = getPlannerTaskProfile();
    const blocks = sortPlannerProfileBlocks(profile?.blocks || []).filter(
        (block) => block?.enabled !== false,
    );
    return {
        source: 'task-profile',
        profile,
        blocks,
    };
}

function resolvePlannerBuiltinBlockContent(block = {}, context = {}) {
    const sourceKey = String(block?.sourceKey || '').trim();
    switch (sourceKey) {
        case 'plannerCharacterCard':
        case 'charDescription':
            return String(context.charBlock || '');
        case 'plannerWorldbook':
        case 'worldInfoBefore':
        case 'worldInfoAfter':
            return String(context.worldbook || '');
        case 'plannerRecentChat':
        case 'recentMessages':
            return String(context.recentChat || '');
        case 'plannerMemory':
        case 'activeSummaries':
            return String(context.bmeMemory || '').trim()
                ? `<bme_memory>\n${String(context.bmeMemory || '').trim()}\n</bme_memory>`
                : '';
        case 'plannerPreviousPlots':
            return String(context.plots || '');
        case 'plannerUserInput':
        case 'userMessage':
            return String(context.userMsgContent || '');
        case 'userPersona':
            return String(context.userPersona || '');
        case 'storyTimeContext':
            return String(context.storyTimeContext || '');
        default:
            return '';
    }
}

async function buildPlannerMessages(rawUserInput, options = {}) {
    throwIfPlannerAborted(options.signal);
    const s = ensureSettings();
    const ctx = getContextSafe();
    const chat = ctx?.chat ?? getPlannerHostChat();
    const charObj = getCurrentCharSafe();
    const env = await prepareEjsEnv();
    const messageVars = getLatestMessageVarTable();
    const plannerPromptConfig = getPlannerPromptBlocksForRuntime();

    const charBlockRaw = formatCharCardBlock(charObj);

    const startPlannerRecall = () => {
        if (!_bmeRuntime?.runPlannerRecallForEna) {
            return Promise.resolve({ memoryBlock: '', memorySource: 'none', plannerRecall: null });
        }
        const timeoutController = new AbortController();
        const recallTimeoutMs = getPlannerRecallTimeoutMs();
        const recallStartedAt = Date.now();
        const timeoutId = setTimeout(
            () => timeoutController.abort(createPlannerAbortError('ENA Planner 召回超时')),
            recallTimeoutMs,
        );
        const signal = createCombinedAbortSignal(options.signal, timeoutController.signal);
        return _bmeRuntime.runPlannerRecallForEna({
            rawUserInput,
            signal,
        }).then((recall) => ({
            memoryBlock: recall?.ok && recall.memoryBlock ? recall.memoryBlock : '',
            memorySource: recall?.ok && recall.memoryBlock ? 'bme' : 'none',
            plannerRecall: recall ?? null,
        })).catch((e) => {
            throwIfPlannerAborted(options.signal);
            if (timeoutController.signal.aborted) {
                console.warn(`[Ena] BME recall timed out (> ${Math.floor(recallTimeoutMs / 1000)}s)`);
            } else if (isPlannerAbortError(e)) {
                throw e;
            } else {
                console.warn('[Ena] BME planner recall failed:', e);
            }
            return { memoryBlock: '', memorySource: 'none', plannerRecall: null };
        }).finally(() => {
            clearTimeout(timeoutId);
            debugLog(
                `[Ena] Planner recall finished in ${Date.now() - recallStartedAt}ms (timeout=${recallTimeoutMs}ms)`,
            );
        });
    };

    // --- BME memory: full recall with history/vector guards ---
    // Start recall as early as possible and let it overlap with chat/worldbook
    // context construction. The result is still awaited before template render.
    const plannerRecallPromise = startPlannerRecall();

    // --- Chat history: last 2 AI messages (floors N-1 & N-3) ---
    // Two messages instead of one to avoid cross-device cache miss:
    // Keep two recent assistant messages so planner prompt still has
    // a little continuity even when memory recall returns empty.
    const recentChatRaw = collectRecentChatSnippet(chat, 2);

    const plotsRaw = readPlannerPlotHistory(chat, { count: s.plotCount }).block;

    // Build scanText for worldbook keyword activation
    const scanText = [charBlockRaw, recentChatRaw, plotsRaw, rawUserInput].join('\n\n');

    const [worldbookRaw, plannerRecallInfo] = await Promise.all([
        buildWorldbookBlock(scanText),
        plannerRecallPromise,
    ]);
    throwIfPlannerAborted(options.signal);

    const memoryBlock = plannerRecallInfo.memoryBlock || '';
    const memorySource = plannerRecallInfo.memorySource || 'none';
    const plannerRecall = plannerRecallInfo.plannerRecall || null;
    debugLog(`[Ena] Memory source: ${memorySource}`);

    // Render templates/macros
    const charBlock = await renderTemplateAll(charBlockRaw, env, messageVars);
    const recentChat = await renderTemplateAll(recentChatRaw, env, messageVars);
    const plots = await renderTemplateAll(plotsRaw, env, messageVars);
    const bmeMemory = memoryBlock || '';
    const worldbook = await renderTemplateAll(worldbookRaw, env, messageVars);
    const userInput = await renderTemplateAll(rawUserInput, env, messageVars);
    const userMsgContent = `以下是玩家的最新指令哦~:\n[${userInput}]`;

    // --- User persona (optional, for generic userPersona builtin) ---
    let userPersona = '';
    try {
        userPersona = ctx?.powerUserSettings?.persona_description
            || ctx?.extensionSettings?.persona_description
            || ctx?.name1_description
            || ctx?.persona
            || '';
    } catch { /* graceful */ }

    // --- Story time context (optional, for generic storyTimeContext builtin) ---
    let storyTimeContext = '';
    try {
        if (_bmeRuntime?.buildStoryTimeContextText) {
            storyTimeContext = _bmeRuntime.buildStoryTimeContextText() || '';
        }
    } catch { /* graceful */ }

    const plannerBlockContext = {
        charBlock,
        worldbook,
        recentChat,
        bmeMemory,
        plots,
        userInput,
        userMsgContent,
        userPersona,
        storyTimeContext,
    };

    const messages = [];

    for (const block of plannerPromptConfig.blocks) {
        if (!block || block.enabled === false) continue;
        let content = '';
        if (String(block.type || 'custom') === 'builtin') {
            if (String(block.content || '').trim()) {
                content = await renderTemplateAll(block.content, env, messageVars);
            } else {
                content = resolvePlannerBuiltinBlockContent(block, plannerBlockContext);
            }
        } else {
            content = await renderTemplateAll(block.content, env, messageVars);
        }
        if (!String(content || '').trim()) continue;
        messages.push({
            role: ['system', 'user', 'assistant'].includes(String(block.role || '').trim())
                ? String(block.role).trim()
                : 'system',
            content,
        });
    }
    throwIfPlannerAborted(options.signal);

    return {
        messages,
        meta: {
            promptSource: plannerPromptConfig.source,
            profileId: plannerPromptConfig.profile?.id || '',
            profileName: plannerPromptConfig.profile?.name || '',
            charBlockRaw,
            worldbookRaw,
            recentChatRaw,
            memoryBlockLen: memoryBlock.length,
            plannerRecall,
            plotsRaw,
        }
    };
}

/**
 * -------------------------
 * Planning runner + logging
 * --------------------------
 */
async function runPlanningOnce(rawUserInput, silent = false, options = {}) {
    const apiConfig = resolvePlannerApiConfig();

    const log = {
        time: nowISO(), ok: false, model: apiConfig.model,
        requestMessages: [], rawReply: '', filteredReply: '', error: ''
    };

    try {
        const { messages, meta } = await buildPlannerMessages(rawUserInput, options);
        log.requestMessages = messages;
        if (meta && typeof meta === 'object') {
            log.promptSource = String(meta.promptSource || '');
            log.profileId = String(meta.profileId || '');
            log.profileName = String(meta.profileName || '');
        }

        const rawReply = await callPlanner(messages, options);
        log.rawReply = rawReply;

        const filtered = filterPlannerForInput(rawReply);
        log.filteredReply = filtered;
        log.ok = true;

        state.logs.unshift(log); clampLogs(); persistLogsMaybe();
        return { rawReply, filtered, plannerRecall: meta?.plannerRecall ?? null };
    } catch (e) {
        if (isPlannerAbortError(e)) throw e;
        log.error = String(e?.message ?? e);
        state.logs.unshift(log); clampLogs(); persistLogsMaybe();
        if (!silent) toastErr(log.error);
        throw e;
    }
}

/**
 * -------------------------
 * Intercept send
 * --------------------------
 */
function getSendTextarea() { return getPlannerSendTextarea(); }
function getSendButton() { return getPlannerSendButton(); }

function isTrivialPlannerInput(text) {
    return _bmeRuntime?.isTrivialUserInput?.(text)?.trivial === true;
}

function shouldInterceptNow() {
    const s = ensureSettings();
    const ta = getSendTextarea();
    const txt = String(ta?.value ?? '').trim();
    return shouldInterceptPlannerSend({
        enabled: Boolean(s.enabled),
        isPlanning: Boolean(state.isPlanning),
        hasTextarea: Boolean(ta),
        textareaValue: txt,
        isTrivial: Boolean(txt && isTrivialPlannerInput(txt)),
        bypassNextSend: Boolean(state.bypassNextSend),
        skipIfPlotPresent: Boolean(s.skipIfPlotPresent),
    }).shouldIntercept;
}

function isPlanningRunCurrent(run, { checkInput = true } = {}) {
    if (!run || state.activeRun !== run || run.controller.signal.aborted) return false;
    if (
        run.lease &&
        !_bmeRuntime?.isConversationLeaseCurrent?.(run.lease, { requireGeneration: false })
    ) {
        return false;
    }
    if (getSendTextarea() !== run.textarea || getSendButton() !== run.button) return false;
    return !checkInput || String(run.textarea.value ?? '') === run.originalValue;
}

function assertPlanningRunCurrent(run, options) {
    throwIfPlannerAborted(run?.controller?.signal);
    if (!isPlanningRunCurrent(run, options)) {
        throw createPlannerAbortError('ENA Planner 所属聊天或输入已改变');
    }
}

function cancelActivePlanning(reason = 'cancelled') {
    const run = state.activeRun;
    if (!run) return false;
    state.activeRun = null;
    state.isPlanning = false;
    setSendUIBusy(false);
    closeActivePlannerNotice();
    run.controller.abort(createPlannerAbortError(`ENA Planner 已取消：${reason}`));
    return true;
}

async function doInterceptAndPlanThenSend() {
    const ta = getSendTextarea();
    const btn = getSendButton();
    if (!ta || !btn) return;

    const originalValue = String(ta.value ?? '');
    const raw = originalValue.trim();
    if (!raw) return;
    if (isTrivialPlannerInput(raw)) return;

    const run = {
        controller: new AbortController(),
        lease: _bmeRuntime?.captureConversationLease?.() || null,
        textarea: ta,
        button: btn,
        originalValue,
    };
    let releasedForSend = false;
    let applyingPlannerResult = false;
    state.activeRun = run;
    state.isPlanning = true;
    setSendUIBusy(true);
    closeActivePlannerNotice();

    try {
        startPlannerNotice('ENA 正在规划剧情推进…');
        assertPlanningRunCurrent(run);
        const { filtered, plannerRecall } = await runPlanningOnce(raw, false, {
            signal: run.controller.signal,
            onDelta(_piece, full) {
                assertPlanningRunCurrent(run);
                if (!resolvePlannerGenerationSettings().stream) return;
                updatePlannerNotice(
                    `正在生成剧情规划…（已生成 ${full.length} 字）`,
                    { busy: true, persist: true, marquee: true },
                );
            }
        });
        assertPlanningRunCurrent(run);
        updatePlannerNotice(
            '剧情规划已附加，将随本轮消息发送',
            { busy: false, level: 'success', persist: false, marquee: false, duration_ms: 5000 },
        );
        // Ordering requirement: write the merged textarea, register the
        // one-shot planner recall handoff synchronously, then click send with
        // no await/timer hop in between.
        setSendUIBusy(false);
        releasedForSend = true;
        applyingPlannerResult = true;
        applyPlannerResultAndSend({
            textarea: ta,
            button: btn,
            rawUserInput: raw,
            filtered,
            plannerRecall,
            plannerPlotRecord: {
                rawUserInput: raw,
                plotText: filtered,
            },
            runtime: _bmeRuntime,
            plannerState: state,
            chatId: run.lease?.chatId || getContextSafe()?.chatId || '',
        });
        applyingPlannerResult = false;
    } catch (err) {
        if (
            isPlannerAbortError(err) ||
            !isPlanningRunCurrent(run, { checkInput: !applyingPlannerResult })
        ) {
            closeActivePlannerNotice();
            return;
        }
        ta.value = originalValue;
        updatePlannerNotice(
            '规划失败，已按原文继续发送',
            { busy: false, level: 'warning', persist: false, marquee: false, duration_ms: 5000 },
        );
        setSendUIBusy(false);
        releasedForSend = true;
        state.bypassNextSend = true;
        try {
            btn.click();
        } finally {
            state.bypassNextSend = false;
        }
    } finally {
        if (state.activeRun === run) {
            state.activeRun = null;
            state.isPlanning = false;
            if (!releasedForSend) setSendUIBusy(false);
        }
    }
}

function installSendInterceptors() {
    if (sendListenersInstalled) return;
    sendClickHandler = (e) => {
        const btn = getSendButton();
        if (!btn) return;
        if (e.target !== btn && !btn.contains(e.target)) return;
        if (state.isPlanning && !state.bypassNextSend) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        if (!shouldInterceptNow()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        doInterceptAndPlanThenSend().catch(err => toastErr(String(err?.message ?? err)));
    };
    sendKeydownHandler = (e) => {
        const ta = getSendTextarea();
        if (!ta || e.target !== ta) return;
        const shouldSendOnEnter = _bmeRuntime?.shouldSendOnEnter?.() ?? true;
        if (!shouldInterceptPlannerEnter(e, shouldSendOnEnter)) return;
        if (state.isPlanning) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        if (!shouldInterceptNow()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        doInterceptAndPlanThenSend().catch(err => toastErr(String(err?.message ?? err)));
    };
    addPlannerSendListeners(sendClickHandler, sendKeydownHandler);
    sendListenersInstalled = true;
}

function uninstallSendInterceptors() {
    if (!sendListenersInstalled) return;
    removePlannerSendListeners(sendClickHandler, sendKeydownHandler);
    sendClickHandler = null;
    sendKeydownHandler = null;
    sendListenersInstalled = false;
}

export async function initEnaPlanner(bmeRuntime) {
    _bmeRuntime = bmeRuntime || null;
    await loadConfig();
    loadPersistedLogsMaybe();
    installSendInterceptors();
    const api = {
        getConfig: getPlannerConfigSnapshot,
        getLogs: getPlannerLogsSnapshot,
        subscribe: subscribePlannerChanges,
        patchConfig: patchPlannerConfig,
        runTest: runPlannerTestFromUi,
        debugWorldbook: debugPlannerWorldbookFromUi,
        debugChar: debugPlannerCharFromUi,
        clearLogs: clearPlannerLogs,
        cancelPlanning: cancelActivePlanning,
    };
    return api;
}

export function cleanupEnaPlanner() {
    cancelActivePlanning('cleanup');
    uninstallSendInterceptors();
    nativeSubscribers.clear();
    _bmeRuntime = null;
}
