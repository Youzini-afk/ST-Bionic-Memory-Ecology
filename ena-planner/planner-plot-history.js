import {
    extractLastNPlots,
    formatPlotsBlock,
} from './ena-planner-runtime-utils.js';

export const ST_BME_PLOT_HISTORY_KEY = 'st_bme_plot';
export const ST_BME_PLOT_HISTORY_VERSION = 1;
export const ST_BME_PLOT_RECOVERY_SUPPRESSED_KEY = 'st_bme_plot_recovery_suppressed';

export function hashPlannerPlotInput(text = '') {
    let hash = 2166136261;
    for (const char of String(text || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return String(Math.abs(hash >>> 0));
}

export function createStructuredPlotRecord({
    rawUserInput = '',
    plannerAugmentedMessage = '',
    plannerRecallInjectionText = '',
    plotText = '',
    plotBlocks = null,
    promptProfileId = '',
    recallHandoffId = '',
    recallArtifactId = '',
    recallChatId = '',
    recallTurnId = '',
    recallInputFingerprint = '',
    recallHistoryFingerprint = '',
    recallMemoryStateFingerprint = '',
    recallSelectedMemoryIds = [],
    recallCandidateMemoryIds = [],
    plannerArtifactId = '',
    taskResults = [],
    createdAt = Date.now(),
    inputHash = '',
} = {}) {
    const normalizedRaw = String(rawUserInput || '').trim();
    const normalizedPlot = String(plotText || '').trim();
    const blocks = Array.isArray(plotBlocks)
        ? plotBlocks.map((item) => String(item || '').trim()).filter(Boolean)
        : extractLastNPlots([{ mes: normalizedPlot }], 99);
    return {
        version: ST_BME_PLOT_HISTORY_VERSION,
        inputHash: String(inputHash || hashPlannerPlotInput(normalizedRaw)),
        rawUserInput: normalizedRaw,
        plannerAugmentedMessage: String(plannerAugmentedMessage || '').trim(),
        plannerRecallInjectionText: String(plannerRecallInjectionText || '').trim(),
        plotText: normalizedPlot,
        plotBlocks: blocks,
        promptProfileId: String(promptProfileId || ''),
        recallHandoffId: String(recallHandoffId || ''),
        recallArtifactId: String(recallArtifactId || ''),
        recallChatId: String(recallChatId || ''),
        recallTurnId: String(recallTurnId || ''),
        recallInputFingerprint: String(recallInputFingerprint || ''),
        recallHistoryFingerprint: String(recallHistoryFingerprint || ''),
        recallMemoryStateFingerprint: String(recallMemoryStateFingerprint || ''),
        recallSelectedMemoryIds: Array.isArray(recallSelectedMemoryIds)
            ? recallSelectedMemoryIds.map((item) => String(item || '')).filter(Boolean)
            : [],
        recallCandidateMemoryIds: Array.isArray(recallCandidateMemoryIds)
            ? recallCandidateMemoryIds.map((item) => String(item || '')).filter(Boolean)
            : [],
        plannerArtifactId: String(plannerArtifactId || ''),
        taskResults: Array.isArray(taskResults) ? taskResults : [],
        createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now(),
    };
}

export function normalizeStructuredPlotRecord(value) {
    if (!value || typeof value !== 'object') return null;
    if (Number(value.version) !== ST_BME_PLOT_HISTORY_VERSION) return null;
    const plotText = String(value.plotText || '').trim();
    const plotBlocks = Array.isArray(value.plotBlocks)
        ? value.plotBlocks.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    if (!plotText && plotBlocks.length === 0) return null;
    return createStructuredPlotRecord({
        ...value,
        plotText,
        plotBlocks,
        createdAt: value.createdAt,
    });
}

export function readStructuredPlotRecordFromMessage(message) {
    return normalizeStructuredPlotRecord(message?.extra?.[ST_BME_PLOT_HISTORY_KEY]);
}

export function recoverStructuredPlotRecordFromPlannerRecall(message, recallRecord) {
    if (!message?.is_user || String(recallRecord?.recallSource || '') !== 'planner-handoff') {
        return null;
    }
    const augmentedMessage = String(message.mes || '').trim();
    const rawUserInput = String(recallRecord?.recallInput || '').trim();
    const boundUserFloorText = String(recallRecord?.boundUserFloorText || '').trim();
    if (
        !augmentedMessage
        || !rawUserInput
        || (boundUserFloorText && boundUserFloorText !== augmentedMessage)
    ) {
        return null;
    }
    const plannerTagIndex = augmentedMessage.search(/<(?:plot|note|plot-log|state)\b/i);
    if (plannerTagIndex < 0 || augmentedMessage.slice(0, plannerTagIndex).trim() !== rawUserInput) {
        return null;
    }
    const plotText = augmentedMessage.slice(plannerTagIndex).trim();
    if (!/<plot\b[^>]*>[\s\S]*?<\/plot>/i.test(plotText)) return null;
    const createdAt = Date.parse(String(recallRecord?.createdAt || ''));
    return createStructuredPlotRecord({
        rawUserInput,
        plannerAugmentedMessage: augmentedMessage,
        plannerRecallInjectionText: String(recallRecord?.injectionText || '').trim(),
        plotText,
        recallArtifactId: String(recallRecord?.artifactId || ''),
        recallChatId: String(recallRecord?.chatId || ''),
        recallTurnId: String(recallRecord?.turnId || ''),
        recallInputFingerprint: String(recallRecord?.inputFingerprint || ''),
        recallHistoryFingerprint: String(
            recallRecord?.artifactHistoryFingerprint || recallRecord?.historyFingerprint || '',
        ),
        recallMemoryStateFingerprint: String(recallRecord?.memoryStateFingerprint || ''),
        recallSelectedMemoryIds: recallRecord?.selectedNodeIds || [],
        recallCandidateMemoryIds: recallRecord?.candidateNodeIds || [],
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    });
}

export function collectStructuredPlotRecords(chat, count = 2) {
    if (!Array.isArray(chat) || chat.length === 0) return [];
    const want = Math.max(0, Number(count) || 0);
    if (!want) return [];
    const records = [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const record = readStructuredPlotRecordFromMessage(chat[index]);
        if (
            !record?.recallArtifactId
            || !record?.plannerArtifactId
            || !record?.recallChatId
            || !record?.recallTurnId
            || !record?.recallInputFingerprint
            || !record?.recallHistoryFingerprint
            || !record?.recallMemoryStateFingerprint
        ) continue;
        records.push(record);
        if (records.length >= want) break;
    }
    return records;
}

export function formatStructuredPlotRecords(records, count = 2) {
    const want = Math.max(0, Number(count) || 0);
    if (!want || !Array.isArray(records)) {
        return { source: 'empty', records: [], plots: [], block: '' };
    }
    const normalizedRecords = records
        .map((record) => normalizeStructuredPlotRecord(record))
        .filter(Boolean)
        .slice(0, want);
    const seen = new Set();
    const plots = [];
    for (const record of normalizedRecords) {
        const recordBlocks = record.plotBlocks.length > 0
            ? record.plotBlocks
            : extractLastNPlots([{ mes: record.plotText || '' }], want);
        const plot = recordBlocks.join('\n').trim();
        if (!plot || seen.has(plot)) continue;
        plots.push(plot);
        seen.add(plot);
        if (plots.length >= want) break;
    }
    return {
        source: plots.length > 0 ? 'structured' : 'empty',
        records: normalizedRecords,
        plots,
        block: formatPlotsBlock(plots),
    };
}

export function readPlannerPlotHistory(chat, { count = 2 } = {}) {
    const want = Math.max(0, Number(count) || 0);
    if (!want) {
        return { source: 'empty', records: [], plots: [], block: '' };
    }
    return formatStructuredPlotRecords(
        collectStructuredPlotRecords(chat, count),
        want,
    );
}

export function writeStructuredPlotRecordToMessage(message, recordInput) {
    if (!message || typeof message !== 'object' || !message.is_user) return false;
    const record = normalizeStructuredPlotRecord(
        recordInput?.version ? recordInput : createStructuredPlotRecord(recordInput),
    );
    if (!record) return false;
    message.extra = message.extra && typeof message.extra === 'object'
        ? message.extra
        : {};
    delete message.extra[ST_BME_PLOT_RECOVERY_SUPPRESSED_KEY];
    message.extra[ST_BME_PLOT_HISTORY_KEY] = record;
    return true;
}

export function writeStructuredPlotRecordToMatchingUserMessage(chat, recordInput) {
    if (!Array.isArray(chat)) return null;
    const record = normalizeStructuredPlotRecord(
        recordInput?.version ? recordInput : createStructuredPlotRecord(recordInput),
    );
    if (!record) return null;
    const inputHash = String(record.inputHash || hashPlannerPlotInput(record.rawUserInput));
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message?.is_user) continue;
        if (hashPlannerPlotInput(message.mes || '') !== inputHash) continue;
        if (writeStructuredPlotRecordToMessage(message, record)) {
            return { index, record };
        }
    }
    return null;
}
