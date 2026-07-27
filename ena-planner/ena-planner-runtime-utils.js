export function extractLastNPlots(chat, n) {
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

export function formatPlotsBlock(plotList) {
    if (!Array.isArray(plotList) || plotList.length === 0) return '';
    const chrono = [...plotList].reverse();
    const lines = [];
    chrono.forEach((p, idx) => {
        lines.push(`【plot -${chrono.length - idx}】\n${p}`);
    });
    return `<previous_plots>\n${lines.join('\n\n')}\n</previous_plots>`;
}

const DEFAULT_PLANNER_CONFIG = Object.freeze({
    enabled: false,
    skipIfPlotPresent: true,
    chatExcludeTags: ['行动选项', 'UpdateVariable', 'StatusPlaceHolderImpl'],
    includeGlobalWorldbooks: false,
    excludeWorldbookPosition4: true,
    worldbookExcludeNames: ['mvu_update'],
    plotCount: 2,
    responseKeepTags: ['plot', 'note', 'plot-log', 'state'],
    api: Object.freeze({ llmPreset: '' }),
    logsPersist: true,
    logsMax: 20,
});

function normalizeStringList(value, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];
    return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

export function createDefaultEnaPlannerConfig() {
    return {
        ...DEFAULT_PLANNER_CONFIG,
        chatExcludeTags: [...DEFAULT_PLANNER_CONFIG.chatExcludeTags],
        worldbookExcludeNames: [...DEFAULT_PLANNER_CONFIG.worldbookExcludeNames],
        responseKeepTags: [...DEFAULT_PLANNER_CONFIG.responseKeepTags],
        api: { ...DEFAULT_PLANNER_CONFIG.api },
    };
}

export function normalizeEnaPlannerConfig(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaults = createDefaultEnaPlannerConfig();
    const plotCount = Number(source.plotCount);
    const logsMax = Number(source.logsMax);
    return {
        enabled: source.enabled === true,
        skipIfPlotPresent: source.skipIfPlotPresent !== false,
        chatExcludeTags: normalizeStringList(source.chatExcludeTags, defaults.chatExcludeTags),
        includeGlobalWorldbooks: source.includeGlobalWorldbooks === true,
        excludeWorldbookPosition4: source.excludeWorldbookPosition4 !== false,
        worldbookExcludeNames: normalizeStringList(
            source.worldbookExcludeNames,
            defaults.worldbookExcludeNames,
        ),
        plotCount: Number.isFinite(plotCount)
            ? Math.max(0, Math.min(10, Math.floor(plotCount)))
            : defaults.plotCount,
        responseKeepTags: normalizeStringList(
            source.responseKeepTags,
            defaults.responseKeepTags,
        ),
        api: {
            llmPreset: String(source.api?.llmPreset || '').trim(),
        },
        logsPersist: source.logsPersist !== false,
        logsMax: Number.isFinite(logsMax)
            ? Math.max(1, Math.min(200, Math.floor(logsMax)))
            : defaults.logsMax,
    };
}

export function applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput = '',
    filtered = '',
    plannerRecall = null,
    plannerPlotRecord = null,
    runtime = null,
    plannerState = null,
    chatId = '',
} = {}) {
    if (!textarea || !button) return { applied: false, reason: 'missing-target' };

    const raw = String(rawUserInput ?? '').trim();
    const merged = `${raw}\n\n${String(filtered ?? '')}`.trim();
    textarea.value = merged;
    const plotRecordPayload = plannerPlotRecord && typeof plannerPlotRecord === 'object'
        ? {
            ...plannerPlotRecord,
            rawUserInput: raw,
            plannerAugmentedMessage: merged,
        }
        : null;

    const handoff = runtime?.preparePlannerTurnHandoff?.({
        rawUserInput: raw,
        plannerAugmentedMessage: merged,
        plannerRecall,
        plannerPlotRecord: plotRecordPayload,
        chatId,
    }) || null;

    if (plannerState && typeof plannerState === 'object') {
        plannerState.bypassNextSend = true;
    }
    try {
        button.click();
    } finally {
        if (plannerState && typeof plannerState === 'object') {
            plannerState.bypassNextSend = false;
        }
    }
    return {
        applied: true,
        merged,
        handoffPrepared: Boolean(handoff),
        recallPrepared: Boolean(handoff?.result && String(handoff?.injectionText || '').trim()),
        plotPrepared: Boolean(handoff?.plannerPlotRecord),
    };
}

export function shouldInterceptPlannerEnter(event = {}, shouldSendOnEnter = true) {
    return Boolean(
        shouldSendOnEnter
        && event.key === 'Enter'
        && event.isComposing !== true
        && event.shiftKey !== true
        && event.ctrlKey !== true
        && event.altKey !== true
    );
}

export function shouldInterceptPlannerSend({
    enabled = false,
    isPlanning = false,
    hasTextarea = false,
    textareaValue = '',
    isTrivial = false,
    bypassNextSend = false,
    skipIfPlotPresent = false,
} = {}) {
    if (!enabled) return { shouldIntercept: false, reason: 'disabled' };
    if (isPlanning) return { shouldIntercept: false, reason: 'planning' };
    if (!hasTextarea) return { shouldIntercept: false, reason: 'missing-textarea' };
    const text = String(textareaValue ?? '').trim();
    if (!text) return { shouldIntercept: false, reason: 'empty-input' };
    if (isTrivial) return { shouldIntercept: false, reason: 'trivial' };
    if (bypassNextSend) return { shouldIntercept: false, reason: 'bypass' };
    if (skipIfPlotPresent && /<plot\b/i.test(text)) {
        return { shouldIntercept: false, reason: 'plot-present' };
    }
    return { shouldIntercept: true, reason: 'ok' };
}
