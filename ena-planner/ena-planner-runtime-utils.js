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

export function applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput = '',
    filtered = '',
    plannerRecall = null,
    plannerPlotRecord = null,
    runtime = null,
    plannerState = null,
} = {}) {
    if (!textarea || !button) return { applied: false, reason: 'missing-target' };

    const raw = String(rawUserInput ?? '').trim();
    const merged = `${raw}\n\n${String(filtered ?? '')}`.trim();
    textarea.value = merged;
    if (plannerState && typeof plannerState === 'object') {
        plannerState.lastInjectedText = merged;
    }

    const plotRecordPayload = plannerPlotRecord && typeof plannerPlotRecord === 'object'
        ? {
            ...plannerPlotRecord,
            rawUserInput: raw,
            plannerAugmentedMessage: merged,
        }
        : null;

    let plotHandoffPrepared = false;
    if (runtime?.preparePlannerPlotRecordHandoff && plotRecordPayload) {
        runtime.preparePlannerPlotRecordHandoff(plotRecordPayload);
        plotHandoffPrepared = true;
    }

    let handoffPrepared = false;
    if (runtime?.preparePlannerRecallHandoff && plannerRecall?.result) {
        runtime.preparePlannerRecallHandoff({
            rawUserInput: raw,
            plannerAugmentedMessage: merged,
            plannerRecall,
            plannerPlotRecord: plotRecordPayload,
        });
        handoffPrepared = true;
    }

    if (plannerState && typeof plannerState === 'object') {
        plannerState.bypassNextSend = true;
    }
    button.click();
    return { applied: true, merged, handoffPrepared, plotHandoffPrepared };
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
