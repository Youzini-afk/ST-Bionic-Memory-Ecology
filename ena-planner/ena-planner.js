import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced, substituteParamsExtended } from '../../../../../script.js';
import { EnaPlannerStorage, migrateFromLWBIfNeeded } from './ena-planner-storage.js';
import { DEFAULT_PROMPT_BLOCKS, BUILTIN_TEMPLATES } from './ena-planner-presets.js';
import {
    createBuiltinPromptBlock,
    createCustomPromptBlock,
    createProfileId,
    ensureTaskProfiles,
    getActiveTaskProfile,
    setActiveTaskProfileId,
    upsertTaskProfile,
} from '../prompting/prompt-profiles.js';
import {
    resolveDedicatedLlmProviderConfig,
    resolveLlmConfigSelection,
} from '../llm/llm-preset-utils.js';
import { debugLog } from '../runtime/debug-logging.js';
import jsyaml from '../vendor/js-yaml.mjs';

const EXT_NAME = 'ena-planner';
const BME_MODULE_NAME = 'st_bme';
const PLANNER_TASK_TYPE = 'planner';
const LEGACY_PLANNER_TASK_PROFILE_MIGRATION_VERSION = 1;
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
 * Default settings
 * --------------------------
 */
function getDefaultSettings(options = {}) {
    const {
        enabled = false,
    } = options;
    return {
        enabled,
        skipIfPlotPresent: true,

        // Chat history: tags to strip from AI responses (besides <think>)
        chatExcludeTags: ['行动选项', 'UpdateVariable', 'StatusPlaceHolderImpl'],

        // Worldbook: always read character-linked lorebooks by default
        // User can also opt-in to include global worldbooks
        includeGlobalWorldbooks: false,
        excludeWorldbookPosition4: true,
        // Worldbook entry names containing these strings will be excluded
        worldbookExcludeNames: ['mvu_update'],

        // Plot extraction
        plotCount: 2,
        // Planner response tags to keep, in source order (empty = keep full response)
        responseKeepTags: ['plot', 'note', 'plot-log', 'state'],

        // Planner prompts (designer)
        promptBlocks: structuredClone(DEFAULT_PROMPT_BLOCKS),
        // Saved prompt templates: { name: promptBlocks[] }
        promptTemplates: structuredClone(BUILTIN_TEMPLATES),
        // Currently selected prompt template name in UI
        activePromptTemplate: '',

        // Planner API
        api: {
            llmPreset: '',
            channel: 'openai',
            baseUrl: '',
            prefixMode: 'auto',
            customPrefix: '',
            apiKey: '',
            model: '',
            stream: true,
            temperature: 1,
            top_p: 1,
            top_k: 0,
            presence_penalty: '',
            frequency_penalty: '',
            max_tokens: ''
        },

        // Logs
        logsPersist: true,
        logsMax: 20
    };
}

/**
 * -------------------------
 * Local state
 * --------------------------
 */
const state = {
    isPlanning: false,
    bypassNextSend: false,
    lastInjectedText: '',
    logs: []
};

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

function hasPlannerTaskProfileMigration(settings = getBmeSettings()) {
    return Number(settings?.enaPlannerTaskProfileMigrationVersion || 0) >= LEGACY_PLANNER_TASK_PROFILE_MIGRATION_VERSION;
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

function normalizeLegacyPlannerPromptBlocks(blocks = []) {
    return (Array.isArray(blocks) ? blocks : [])
        .filter((block) => block && typeof block === 'object')
        .map((block, index) => ({
            id: String(block?.id || `ena-legacy-block-${index + 1}`),
            name: String(block?.name || `提示词块 ${index + 1}`),
            role: ['system', 'user', 'assistant'].includes(String(block?.role || '').trim())
                ? String(block.role).trim()
                : 'system',
            content: String(block?.content || ''),
            order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
        }))
        .filter((block) => String(block.content || '').trim());
}

function buildPlannerProfileBlocksFromLegacy(promptBlocks = []) {
    const normalizedBlocks = normalizeLegacyPlannerPromptBlocks(promptBlocks);
    const systemBlocks = normalizedBlocks.filter((block) => block.role === 'system');
    const userBlocks = normalizedBlocks.filter((block) => block.role === 'user');
    const assistantBlocks = normalizedBlocks.filter((block) => block.role === 'assistant');
    const builtins = [
        'plannerCharacterCard',
        'plannerWorldbook',
        'plannerRecentChat',
        'plannerMemory',
        'plannerPreviousPlots',
    ];
    const result = [];
    let order = 0;

    const pushCustom = (block) => {
        result.push(createCustomPromptBlock(PLANNER_TASK_TYPE, {
            name: block.name,
            role: block.role,
            content: block.content,
            injectionMode: 'relative',
            order: order++,
        }));
    };

    systemBlocks.forEach(pushCustom);
    builtins.forEach((sourceKey) => {
        result.push(createBuiltinPromptBlock(PLANNER_TASK_TYPE, sourceKey, {
            injectionMode: 'relative',
            order: order++,
        }));
    });
    userBlocks.forEach(pushCustom);
    result.push(createBuiltinPromptBlock(PLANNER_TASK_TYPE, 'plannerUserInput', {
        injectionMode: 'relative',
        order: order++,
    }));
    assistantBlocks.forEach(pushCustom);

    return result;
}

function normalizePlannerGenerationNumber(value) {
    if (value == null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function buildPlannerGenerationFromLegacyConfig(plannerConfig = {}) {
    const api = plannerConfig?.api && typeof plannerConfig.api === 'object'
        ? plannerConfig.api
        : {};
    return {
        stream:
            typeof api.stream === 'boolean'
                ? api.stream
                : api.stream === 'true'
                    ? true
                    : api.stream === 'false'
                        ? false
                        : true,
        temperature: normalizePlannerGenerationNumber(api.temperature),
        top_p: normalizePlannerGenerationNumber(api.top_p),
        top_k: normalizePlannerGenerationNumber(api.top_k),
        frequency_penalty: normalizePlannerGenerationNumber(api.frequency_penalty),
        presence_penalty: normalizePlannerGenerationNumber(api.presence_penalty),
        max_completion_tokens: normalizePlannerGenerationNumber(api.max_tokens),
    };
}

function buildComparablePlannerGenerationSnapshot(generation = {}) {
    return {
        stream:
            generation?.stream === true
                ? true
                : generation?.stream === false
                    ? false
                    : null,
        temperature: normalizePlannerGenerationNumber(generation?.temperature),
        top_p: normalizePlannerGenerationNumber(generation?.top_p),
        top_k: normalizePlannerGenerationNumber(generation?.top_k),
        frequency_penalty: normalizePlannerGenerationNumber(generation?.frequency_penalty),
        presence_penalty: normalizePlannerGenerationNumber(generation?.presence_penalty),
        max_completion_tokens: normalizePlannerGenerationNumber(generation?.max_completion_tokens),
    };
}

function arePlannerGenerationSettingsEquivalent(left = {}, right = {}) {
    return JSON.stringify(buildComparablePlannerGenerationSnapshot(left)) === JSON.stringify(buildComparablePlannerGenerationSnapshot(right));
}

function normalizePlannerProfileBlockComparisonPayload(blocks = []) {
    return sortPlannerProfileBlocks(blocks).map((block) => ({
        role: String(block?.role || ''),
        type: String(block?.type || 'custom'),
        sourceKey: String(block?.sourceKey || ''),
        content: String(block?.content || '').trim(),
        enabled: block?.enabled !== false,
    }));
}

function arePlannerProfileBlocksEquivalent(left = [], right = []) {
    return JSON.stringify(normalizePlannerProfileBlockComparisonPayload(left)) === JSON.stringify(normalizePlannerProfileBlockComparisonPayload(right));
}

function buildPlannerMigrationProfileName(baseName = '', fallbackName = 'ENA 当前配置', usedNames = new Set()) {
    const base = String(baseName || '').trim() || fallbackName;
    let nextName = base;
    let suffix = 2;
    while (usedNames.has(nextName)) {
        nextName = `${base} ${suffix}`;
        suffix += 1;
    }
    usedNames.add(nextName);
    return nextName;
}

function createLegacyPlannerTaskProfile(name, promptBlocks, plannerConfig, options = {}) {
    return {
        id: createProfileId(PLANNER_TASK_TYPE),
        name,
        taskType: PLANNER_TASK_TYPE,
        builtin: false,
        enabled: true,
        promptMode: 'block-based',
        updatedAt: nowISO(),
        blocks: buildPlannerProfileBlocksFromLegacy(promptBlocks),
        generation: buildPlannerGenerationFromLegacyConfig(plannerConfig),
        metadata: {
            migratedFromLegacy: true,
            enaLegacyTemplateName: String(options.templateName || ''),
            enaLegacySource: String(options.source || 'legacy-ena'),
        },
    };
}

function migrateLegacyPlannerTaskProfilesIfNeeded() {
    const settings = getBmeSettings();
    if (hasPlannerTaskProfileMigration(settings)) {
        return false;
    }

    const plannerConfig = ensureSettings({ defaultEnabled: false });
    let nextTaskProfiles = ensureTaskProfiles(settings);
    const plannerBucket = nextTaskProfiles?.[PLANNER_TASK_TYPE] || {
        activeProfileId: 'default',
        profiles: [],
    };
    const hasExistingCustomProfiles = Array.isArray(plannerBucket.profiles)
        && plannerBucket.profiles.some((profile) => String(profile?.id || '') !== 'default');

    if (hasExistingCustomProfiles) {
        extension_settings[BME_MODULE_NAME] = {
            ...settings,
            taskProfiles: nextTaskProfiles,
            enaPlannerTaskProfileMigrationVersion: LEGACY_PLANNER_TASK_PROFILE_MIGRATION_VERSION,
        };
        saveSettingsDebounced?.();
        return false;
    }

    const defaultPlannerProfile = getActiveTaskProfile({}, PLANNER_TASK_TYPE);
    const defaultPlannerBlocks = Array.isArray(defaultPlannerProfile?.blocks)
        ? defaultPlannerProfile.blocks
        : [];
    const defaultPlannerGeneration = defaultPlannerProfile?.generation || {};
    const currentBlocks = Array.isArray(plannerConfig.promptBlocks)
        ? plannerConfig.promptBlocks
        : getDefaultSettings().promptBlocks;
    const promptTemplates = plannerConfig?.promptTemplates && typeof plannerConfig.promptTemplates === 'object'
        ? plannerConfig.promptTemplates
        : {};
    const activeTemplateName = String(plannerConfig.activePromptTemplate || '').trim();
    const usedNames = new Set(
        (Array.isArray(plannerBucket.profiles) ? plannerBucket.profiles : [])
            .map((profile) => String(profile?.name || '').trim())
            .filter(Boolean),
    );
    const seenSignatures = new Set();
    const profileSpecs = [];
    let activeProfileName = '';

    const appendProfileSpec = (name, promptBlocks, options = {}) => {
        const migratedBlocks = buildPlannerProfileBlocksFromLegacy(promptBlocks);
        const migratedGeneration = buildPlannerGenerationFromLegacyConfig(plannerConfig);
        if (
            arePlannerProfileBlocksEquivalent(migratedBlocks, defaultPlannerBlocks)
            && arePlannerGenerationSettingsEquivalent(migratedGeneration, defaultPlannerGeneration)
            && options.allowDefaultDuplicate !== true
        ) {
            return '';
        }

        const signature = JSON.stringify({
            blocks: normalizePlannerProfileBlockComparisonPayload(migratedBlocks),
            generation: buildComparablePlannerGenerationSnapshot(migratedGeneration),
        });
        if (seenSignatures.has(signature)) {
            return '';
        }
        seenSignatures.add(signature);

        const uniqueName = buildPlannerMigrationProfileName(name, options.fallbackName, usedNames);
        profileSpecs.push({
            name: uniqueName,
            promptBlocks,
            templateName: options.templateName || '',
            source: options.source || 'legacy-ena',
            active: options.active === true,
        });
        return uniqueName;
    };

    for (const [templateName, templateBlocks] of Object.entries(promptTemplates)) {
        if (!Array.isArray(templateBlocks)) continue;
        const appendedName = appendProfileSpec(templateName, templateBlocks, {
            fallbackName: 'ENA 模板',
            templateName,
            source: 'legacy-template',
        });
        if (
            appendedName
            && activeTemplateName === templateName
            && arePlannerProfileBlocksEquivalent(templateBlocks, currentBlocks)
        ) {
            activeProfileName = appendedName;
        }
    }

    if (!activeProfileName) {
        activeProfileName = appendProfileSpec(
            activeTemplateName ? `${activeTemplateName}（当前）` : 'ENA 当前配置',
            currentBlocks,
            {
                fallbackName: 'ENA 当前配置',
                source: 'legacy-working-copy',
                active: true,
            },
        );
    }

    let activeProfileId = '';
    for (const spec of profileSpecs) {
        const profile = createLegacyPlannerTaskProfile(spec.name, spec.promptBlocks, plannerConfig, {
            templateName: spec.templateName,
            source: spec.source,
        });
        nextTaskProfiles = upsertTaskProfile(nextTaskProfiles, PLANNER_TASK_TYPE, profile, {
            setActive: false,
        });
        if (spec.name === activeProfileName || (spec.active && !activeProfileId)) {
            activeProfileId = profile.id;
        }
    }

    if (activeProfileId) {
        nextTaskProfiles = setActiveTaskProfileId(nextTaskProfiles, PLANNER_TASK_TYPE, activeProfileId);
    }

    extension_settings[BME_MODULE_NAME] = {
        ...settings,
        taskProfiles: nextTaskProfiles,
        enaPlannerTaskProfileMigrationVersion: LEGACY_PLANNER_TASK_PROFILE_MIGRATION_VERSION,
    };
    saveSettingsDebounced?.();
    return profileSpecs.length > 0;
}

/**
 * -------------------------
 * Helpers
 * --------------------------
 */
function ensureSettings(options = {}) {
    const {
        defaultEnabled = false,
    } = options;
    const d = getDefaultSettings({ enabled: defaultEnabled });
    const s = config || structuredClone(d);

    function deepMerge(target, src) {
        for (const k of Object.keys(src)) {
            if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
                target[k] = target[k] ?? {};
                deepMerge(target[k], src[k]);
            } else if (target[k] === undefined) {
                target[k] = src[k];
            }
        }
    }
    deepMerge(s, d);
    if (!Array.isArray(s.responseKeepTags)) s.responseKeepTags = structuredClone(d.responseKeepTags);
    else s.responseKeepTags = normalizeResponseKeepTags(s.responseKeepTags);

    // Migration: remove old keys that are no longer needed
    delete s.includeCharacterLorebooks;
    delete s.includeCharDesc;
    delete s.includeCharPersonality;
    delete s.includeCharScenario;
    delete s.includeVectorRecall;
    delete s.historyMessageCount;
    delete s.worldbookActivationMode;

    config = s;
    return s;
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
    const loaded = await EnaPlannerStorage.get('config', null);
    const hasSavedConfig = !!(loaded && typeof loaded === 'object');
    config = hasSavedConfig ? loaded : getDefaultSettings({ enabled: false });
    ensureSettings({ defaultEnabled: hasSavedConfig ? true : false });
    migrateLegacyPlannerTaskProfilesIfNeeded();
    state.logs = Array.isArray(await EnaPlannerStorage.get('logs', [])) ? await EnaPlannerStorage.get('logs', []) : [];

    if (extension_settings?.[EXT_NAME]) {
        delete extension_settings[EXT_NAME];
        saveSettingsDebounced?.();
    }
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

function toastInfo(msg) {
    if (window.toastr?.info) return window.toastr.info(msg);
    debugLog('[EnaPlanner]', msg);
}
function toastErr(msg) {
    if (window.toastr?.error) return window.toastr.error(msg);
    console.error('[EnaPlanner]', msg);
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

function runWithTimeout(taskFactory, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        Promise.resolve()
            .then(taskFactory)
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timer));
    });
}

function normalizeUrlBase(u) {
    if (!u) return '';
    return u.replace(/\/+$/g, '');
}

function hasPlannerLegacyDedicatedApiConfig(api = {}) {
    return Boolean(
        String(api?.baseUrl || '').trim() &&
        String(api?.model || '').trim(),
    );
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
        mode: selection?.requestedPresetName ? 'preset' : 'global',
        source: String(selection?.source || ''),
        requestedPresetName: String(selection?.requestedPresetName || ''),
        presetName: String(selection?.presetName || ''),
        fallbackReason: String(selection?.fallbackReason || ''),
        channel: inferPlannerChannelFromUrl(baseUrl),
        prefixMode: 'auto',
        customPrefix: '',
        baseUrl,
        apiKey: String(snapshot?.llmApiKey || '').trim(),
        model: String(snapshot?.llmModel || '').trim(),
    };
}

function buildLegacyPlannerApiConfig(api = {}) {
    return {
        mode: 'legacy',
        source: 'legacy-ena-config',
        requestedPresetName: '',
        presetName: '',
        fallbackReason: '',
        channel: String(api?.channel || 'openai').trim() || 'openai',
        prefixMode: String(api?.prefixMode || 'auto').trim() || 'auto',
        customPrefix: String(api?.customPrefix || '').trim(),
        baseUrl: String(api?.baseUrl || '').trim(),
        apiKey: String(api?.apiKey || '').trim(),
        model: String(api?.model || '').trim(),
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
    if (hasPlannerLegacyDedicatedApiConfig(s?.api)) {
        return buildLegacyPlannerApiConfig(s.api);
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
    if (apiConfig?.prefixMode === 'custom' && apiConfig?.customPrefix?.trim()) return apiConfig.customPrefix.trim();
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
    const sendBtn = document.getElementById('send_but') || document.getElementById('send_button');
    const textarea = document.getElementById('send_textarea');
    if (sendBtn) sendBtn.disabled = !!busy;
    if (textarea) textarea.disabled = !!busy;
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
    try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function getCurrentCharSafe() {
    try {
        // Method 1: via getContext()
        const ctx = getContextSafe();
        if (ctx) {
            const cid = ctx.characterId ?? ctx.this_chid;
            const chars = ctx.characters;
            if (chars && cid != null && chars[cid]) return chars[cid];
        }
        // Method 2: global this_chid + characters
        const st = window.SillyTavern;
        if (st) {
            const chid = st.this_chid ?? window.this_chid;
            const chars = st.characters ?? window.characters;
            if (chars && chid != null && chars[chid]) return chars[chid];
        }
        // Method 3: bare globals (some ST versions)
        if (window.this_chid != null && window.characters) {
            return window.characters[window.this_chid] ?? null;
        }
    } catch { }
    return null;
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
function extractLastNPlots(chat, n) {
    if (!Array.isArray(chat) || chat.length === 0) return [];
    const want = Math.max(0, Number(n) || 0);
    if (!want) return [];

    const plots = [];
    const plotRe = /<plot\b[^>]*>[\s\S]*?<\/plot>/gi;

    for (let i = chat.length - 1; i >= 0; i--) {
        const text = chat[i]?.mes ?? '';
        if (!text) continue;
        const matches = [...text.matchAll(plotRe)];
        for (let j = matches.length - 1; j >= 0; j--) {
            plots.push(matches[j][0]);
            if (plots.length >= want) return plots;
        }
    }
    return plots;
}

function formatPlotsBlock(plotList) {
    if (!Array.isArray(plotList) || plotList.length === 0) return '';
    // plotList is [newest, ..., oldest] from extractLastNPlots
    // Reverse to chronological: oldest first, newest last
    const chrono = [...plotList].reverse();
    const lines = [];
    chrono.forEach((p, idx) => {
        lines.push(`【plot -${chrono.length - idx}】\n${p}`);
    });
    return `<previous_plots>\n${lines.join('\n\n')}\n</previous_plots>`;
}

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
    const worldNames = [];

    // From character object (multiple paths)
    if (charObj) {
        const paths = [
            charObj?.data?.extensions?.world,
            charObj?.world,
            charObj?.data?.character_book?.name,
        ];
        for (const w of paths) {
            if (w && !worldNames.includes(w)) worldNames.push(w);
        }
    }

    // From context
    if (ctx) {
        try {
            const cid = ctx.characterId ?? ctx.this_chid;
            const chars = ctx.characters ?? window.characters;
            if (chars && cid != null) {
                const c = chars[cid];
                const paths = [
                    c?.data?.extensions?.world,
                    c?.world,
                ];
                for (const w of paths) {
                    if (w && !worldNames.includes(w)) worldNames.push(w);
                }
            }
        } catch { }

        // ST context may expose chat-linked worldbooks via world_names
        try {
            if (ctx.worldNames && Array.isArray(ctx.worldNames)) {
                for (const w of ctx.worldNames) {
                    if (w && !worldNames.includes(w)) worldNames.push(w);
                }
            }
        } catch { }
    }

    // Fallback: try ST's selected character world info
    try {
        const sw = window.selected_world_info;
        if (typeof sw === 'string' && sw && !worldNames.includes(sw)) {
            worldNames.push(sw);
        }
    } catch { }

    // Fallback: try reading from chat metadata
    try {
        const chat = ctx?.chat ?? [];
        if (chat.length > 0 && chat[0]?.extra?.world) {
            const w = chat[0].extra.world;
            if (!worldNames.includes(w)) worldNames.push(w);
        }
    } catch { }

    debugLog('[EnaPlanner] Character worldbook names found:', worldNames);
    return worldNames.filter(Boolean);
}

async function getGlobalWorldbooks() {
    // Try to get the list of currently active global worldbooks
    try {
        // ST stores active worldbooks in world_info settings
        const ctx = getContextSafe();
        if (ctx?.world_info?.globalSelect) {
            return Array.isArray(ctx.world_info.globalSelect) ? ctx.world_info.globalSelect : [];
        }
    } catch { }

    // Fallback: try window.selected_world_info
    try {
        if (window.selected_world_info && Array.isArray(window.selected_world_info)) {
            return window.selected_world_info;
        }
    } catch { }

    return [];
}

async function getWorldbookData(worldName) {
    if (!worldName) return null;
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName }),
        });
        if (response.ok) {
            const data = await response.json();
            // ST returns { entries: {...} } or { entries: [...] }
            let entries = data?.entries;
            if (entries && !Array.isArray(entries)) {
                entries = Object.values(entries);
            }
            return { name: worldName, entries: entries || [] };
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
    let entries = allEntries.filter(e => !e?.disable && !e?.disabled);

    // Filter: exclude entries whose name contains any of the configured exclude patterns
    const nameExcludes = s.worldbookExcludeNames ?? ['mvu_update'];
    entries = entries.filter(e => {
        const comment = String(e?.comment || e?.name || e?.title || '');
        for (const pat of nameExcludes) {
            if (pat && comment.includes(pat)) return false;
        }
        return true;
    });

    // Filter: exclude position=4 if configured
    if (s.excludeWorldbookPosition4) {
        entries = entries.filter(e => Number(e?.position) !== 4);
    }

    if (!entries.length) return '';

    // Activation: constant (blue) + keyword scan (green) only
    const active = [];
    for (const e of entries) {
        // Blue light: constant entries always included
        if (e?.constant) {
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
      if (window.chat_metadata?.variables) vars = { ...window.chat_metadata.variables };
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
    const vars = getChatVariables();

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

function renderEjsTemplate(template, ctx, templateLabel = '') {
    const labelSuffix = templateLabel ? ` (${templateLabel})` : '';

    if (shouldSkipSyncEjsPreRender(template)) {
        return template;
    }

    // Try window.ejs first (ST loads this library)
    if (window.ejs?.render) {
        try {
            return window.ejs.render(template, ctx, { async: false });
        } catch (e) {
            console.warn(`[EnaPlanner] EJS render failed${labelSuffix}, template returned as-is:`, e?.message);
            return template;
        }
    }

    // Safe degradation when ejs is not available.
    console.warn(`[EnaPlanner] window.ejs not available${labelSuffix}, template returned as-is.`);
    return template;
}

/**
 * -------------------------
 * Template rendering helpers
 * --------------------------
 */
async function prepareEjsEnv() {
    try {
        const et = window.EjsTemplate;
        if (!et) return null;
        const fn = et.prepareContext || et.preparecontext;
        if (typeof fn !== 'function') return null;
        return await fn.call(et, {});
    } catch { return null; }
}

async function evalEjsIfPossible(text, env) {
    try {
        const et = window.EjsTemplate;
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
    try {
        if (window.Mvu?.getMvuData) {
            return window.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
        }
    } catch { }
    try {
        const getVars = window.TavernHelper?.getVariables || window.Mvu?.getMvuData;
        if (typeof getVars === 'function') {
            return getVars({ type: 'message', message_id: 'latest' });
        }
    } catch { }
    return {};
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

function filterPlannerPreview(rawPartial) {
    return stripThinkBlocks(rawPartial);
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

    const controller = new AbortController();
    const plannerRequestTimeoutMs = getPlannerRequestTimeoutMs();
    const timeoutId = setTimeout(() => controller.abort(), plannerRequestTimeoutMs);
    try {
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
            signal: controller.signal
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
                    try {
                        const j = JSON.parse(payload);
                        const delta = j?.choices?.[0]?.delta;
                        const piece = delta?.content ?? delta?.text ?? '';
                        if (piece) {
                            full += piece;
                            options?.onDelta?.(piece, full);
                        }
                    } catch { }
                }
            }
        }
        return full;
    } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') {
            throw new Error(`规划请求超时（>${Math.floor(plannerRequestTimeoutMs / 1000)}s）`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchModelsForUi() {
    const apiConfig = resolvePlannerApiConfig();
    if (!apiConfig.baseUrl) throw new Error('当前没有可用的 API URL');
    const url = buildUrl('/models', apiConfig);
    const headers = {
        ...getRequestHeaders(),
    };
    if (apiConfig.apiKey) {
        headers.Authorization = `Bearer ${apiConfig.apiKey}`;
    }
    const res = await fetch(url, {
        method: 'GET',
        headers
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`拉取模型失败: ${res.status} ${text}`.slice(0, 300));
    }
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map(x => x?.id).filter(Boolean);
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
        return [
            '⚠️ 未检测到角色。',
            `ctx: ${!!ctx}, ctx.characterId: ${ctx?.characterId}, ctx.this_chid: ${ctx?.this_chid}`,
            `window.this_chid: ${window.this_chid}`,
            `window.characters count: ${window.characters?.length ?? 'N/A'}`
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
    const s = ensureSettings();
    for (const key of Object.keys(patch)) {
        if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) {
            s[key] = { ...(s[key] || {}), ...patch[key] };
        } else {
            s[key] = patch[key];
        }
    }
    const ok = await saveConfigNow();
    if (ok) {
        notifyNativeChange('config', getPlannerConfigSnapshot());
        return { ok: true, config: getPlannerConfigSnapshot() };
    }
    return { ok: false, error: '保存失败' };
}

async function resetPlannerPromptToDefault() {
    const s = ensureSettings();
    s.promptBlocks = getDefaultSettings().promptBlocks;
    const ok = await saveConfigNow();
    if (ok) {
        notifyNativeChange('config', getPlannerConfigSnapshot());
        return { ok: true, config: getPlannerConfigSnapshot() };
    }
    return { ok: false, error: '重置失败' };
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

async function fetchPlannerModelsFromUi() {
    try {
        const models = await fetchModelsForUi();
        return { ok: true, models };
    } catch (err) {
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
    const s = ensureSettings();
    const profile = getPlannerTaskProfile();
    const generation = profile?.generation && typeof profile.generation === 'object'
        ? profile.generation
        : {};

    const pickNumber = (profileValue, fallbackValue) => {
        const normalizedProfileValue = normalizePlannerGenerationNumber(profileValue);
        if (normalizedProfileValue != null) return normalizedProfileValue;
        return normalizePlannerGenerationNumber(fallbackValue);
    };

    const stream =
        generation?.stream === true
            ? true
            : generation?.stream === false
                ? false
                : Boolean(s.api.stream);

    return {
        profile,
        stream,
        temperature: pickNumber(generation?.temperature, s.api.temperature),
        top_p: pickNumber(generation?.top_p, s.api.top_p),
        top_k: pickNumber(generation?.top_k, s.api.top_k),
        presence_penalty: pickNumber(generation?.presence_penalty, s.api.presence_penalty),
        frequency_penalty: pickNumber(generation?.frequency_penalty, s.api.frequency_penalty),
        max_tokens: pickNumber(generation?.max_completion_tokens, s.api.max_tokens),
    };
}

function getPlannerPromptBlocksForRuntime() {
    const profile = getPlannerTaskProfile();
    const blocks = sortPlannerProfileBlocks(profile?.blocks || []).filter(
        (block) => block?.enabled !== false,
    );
    if (blocks.length > 0) {
        return {
            source: 'task-profile',
            profile,
            blocks,
        };
    }

    return {
        source: 'legacy-config',
        profile: null,
        blocks: normalizeLegacyPlannerPromptBlocks(ensureSettings().promptBlocks || []).map(
            (block, index) => ({
                id: block.id,
                name: block.name,
                role: block.role,
                type: 'custom',
                sourceKey: '',
                content: block.content,
                order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
                enabled: true,
            }),
        ),
    };
}

function resolvePlannerBuiltinBlockContent(block = {}, context = {}) {
    const sourceKey = String(block?.sourceKey || '').trim();
    switch (sourceKey) {
        case 'plannerCharacterCard':
            return String(context.charBlock || '');
        case 'plannerWorldbook':
            return String(context.worldbook || '');
        case 'plannerRecentChat':
            return String(context.recentChat || '');
        case 'plannerMemory':
            return String(context.bmeMemory || '').trim()
                ? `<bme_memory>\n${String(context.bmeMemory || '').trim()}\n</bme_memory>`
                : '';
        case 'plannerPreviousPlots':
            return String(context.plots || '');
        case 'plannerUserInput':
            return String(context.userMsgContent || '');
        default:
            return '';
    }
}

async function buildPlannerMessages(rawUserInput) {
    const s = ensureSettings();
    const ctx = getContextSafe();
    const chat = ctx?.chat ?? window.SillyTavern?.chat ?? [];
    const charObj = getCurrentCharSafe();
    const env = await prepareEjsEnv();
    const messageVars = getLatestMessageVarTable();
    const plannerPromptConfig = getPlannerPromptBlocksForRuntime();

    const charBlockRaw = formatCharCardBlock(charObj);

    // --- BME memory: full recall with history/vector guards ---
    let memoryBlock = '';
    let memorySource = 'none';
    let plannerRecall = null;
    if (_bmeRuntime?.runPlannerRecallForEna) {
        const controller = new AbortController();
        const recallTimeoutMs = getPlannerRecallTimeoutMs();
        const recallStartedAt = Date.now();
        const timeoutId = setTimeout(() => controller.abort(), recallTimeoutMs);
        try {
            const recall = await _bmeRuntime.runPlannerRecallForEna({
                rawUserInput,
                signal: controller.signal,
            });
            plannerRecall = recall ?? null;
            if (recall?.ok && recall.memoryBlock) {
                memoryBlock = recall.memoryBlock;
                memorySource = 'bme';
            }
        } catch (e) {
            if (e?.name === 'AbortError') {
                console.warn(`[Ena] BME recall timed out (> ${Math.floor(recallTimeoutMs / 1000)}s)`);
            } else {
                console.warn('[Ena] BME planner recall failed:', e);
            }
        } finally {
            clearTimeout(timeoutId);
            debugLog(
                `[Ena] Planner recall finished in ${Date.now() - recallStartedAt}ms (source=${memorySource}, timeout=${recallTimeoutMs}ms)`,
            );
        }
    }
    debugLog(`[Ena] Memory source: ${memorySource}`);

    // --- Chat history: last 2 AI messages (floors N-1 & N-3) ---
    // Two messages instead of one to avoid cross-device cache miss:
    // Keep two recent assistant messages so planner prompt still has
    // a little continuity even when memory recall returns empty.
    const recentChatRaw = collectRecentChatSnippet(chat, 2);

    const plotsRaw = formatPlotsBlock(extractLastNPlots(chat, s.plotCount));

    // Build scanText for worldbook keyword activation
    const scanText = [charBlockRaw, recentChatRaw, plotsRaw, rawUserInput].join('\n\n');

    const worldbookRaw = await buildWorldbookBlock(scanText);

    // Render templates/macros
    const charBlock = await renderTemplateAll(charBlockRaw, env, messageVars);
    const recentChat = await renderTemplateAll(recentChatRaw, env, messageVars);
    const plots = await renderTemplateAll(plotsRaw, env, messageVars);
    const bmeMemory = memoryBlock || '';
    const worldbook = await renderTemplateAll(worldbookRaw, env, messageVars);
    const userInput = await renderTemplateAll(rawUserInput, env, messageVars);
    const userMsgContent = `以下是玩家的最新指令哦~:\n[${userInput}]`;

    const plannerBlockContext = {
        charBlock,
        worldbook,
        recentChat,
        bmeMemory,
        plots,
        userInput,
        userMsgContent,
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
        const { messages, meta } = await buildPlannerMessages(rawUserInput);
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
function getSendTextarea() { return document.getElementById('send_textarea'); }
function getSendButton() { return document.getElementById('send_but') || document.getElementById('send_button'); }

function isTrivialPlannerInput(text) {
    return _bmeRuntime?.isTrivialUserInput?.(text)?.trivial === true;
}

function shouldInterceptNow() {
    const s = ensureSettings();
    if (!s.enabled || state.isPlanning) return false;
    const ta = getSendTextarea();
    if (!ta) return false;
    const txt = String(ta.value ?? '').trim();
    if (!txt) return false;
    if (isTrivialPlannerInput(txt)) return false;
    if (state.bypassNextSend) return false;
    if (s.skipIfPlotPresent && /<plot\b/i.test(txt)) return false;
    return true;
}

async function doInterceptAndPlanThenSend() {
    const ta = getSendTextarea();
    const btn = getSendButton();
    if (!ta || !btn) return;

    const raw = String(ta.value ?? '').trim();
    if (!raw) return;
    if (isTrivialPlannerInput(raw)) return;

    state.isPlanning = true;
    setSendUIBusy(true);

    try {
        toastInfo('Ena Planner：正在规划…');
        const { filtered, plannerRecall } = await runPlanningOnce(raw, false, {
            onDelta(_piece, full) {
                if (!state.isPlanning) return;
                if (!resolvePlannerGenerationSettings().stream) return;
                const preview = filterPlannerPreview(full);
                ta.value = `${raw}\n\n${preview}`.trim();
            }
        });
        const merged = `${raw}\n\n${filtered}`.trim();
        ta.value = merged;
        state.lastInjectedText = merged;

        // Ordering requirement: register the one-shot planner recall handoff
        // synchronously before btn.click(), with no await/timer hop in between.
        if (_bmeRuntime?.preparePlannerRecallHandoff && plannerRecall?.result) {
            _bmeRuntime.preparePlannerRecallHandoff({
                rawUserInput: raw,
                plannerAugmentedMessage: merged,
                plannerRecall,
            });
        }

        state.bypassNextSend = true;
        btn.click();
    } catch (err) {
        ta.value = raw;
        state.lastInjectedText = '';
        throw err;
    } finally {
        state.isPlanning = false;
        setSendUIBusy(false);
        setTimeout(() => { state.bypassNextSend = false; }, 800);
    }
}

function installSendInterceptors() {
    if (sendListenersInstalled) return;
    sendClickHandler = (e) => {
        const btn = getSendButton();
        if (!btn) return;
        if (e.target !== btn && !btn.contains(e.target)) return;
        if (!shouldInterceptNow()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        doInterceptAndPlanThenSend().catch(err => toastErr(String(err?.message ?? err)));
    };
    sendKeydownHandler = (e) => {
        const ta = getSendTextarea();
        if (!ta || e.target !== ta) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            if (!shouldInterceptNow()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            doInterceptAndPlanThenSend().catch(err => toastErr(String(err?.message ?? err)));
        }
    };
    document.addEventListener('click', sendClickHandler, true);
    document.addEventListener('keydown', sendKeydownHandler, true);
    sendListenersInstalled = true;
}

function uninstallSendInterceptors() {
    if (!sendListenersInstalled) return;
    if (sendClickHandler) document.removeEventListener('click', sendClickHandler, true);
    if (sendKeydownHandler) document.removeEventListener('keydown', sendKeydownHandler, true);
    sendClickHandler = null;
    sendKeydownHandler = null;
    sendListenersInstalled = false;
}

export async function initEnaPlanner(bmeRuntime) {
    _bmeRuntime = bmeRuntime || null;
    await migrateFromLWBIfNeeded();
    await loadConfig();
    loadPersistedLogsMaybe();
    installSendInterceptors();
    window.stBmeEnaPlanner = {
        getConfig: getPlannerConfigSnapshot,
        getLogs: getPlannerLogsSnapshot,
        subscribe: subscribePlannerChanges,
        patchConfig: patchPlannerConfig,
        resetPromptToDefault: resetPlannerPromptToDefault,
        runTest: runPlannerTestFromUi,
        fetchModels: fetchPlannerModelsFromUi,
        debugWorldbook: debugPlannerWorldbookFromUi,
        debugChar: debugPlannerCharFromUi,
        clearLogs: clearPlannerLogs,
    };
}

export function cleanupEnaPlanner() {
    uninstallSendInterceptors();
    nativeSubscribers.clear();
    delete window.stBmeEnaPlanner;
    _bmeRuntime = null;
}

