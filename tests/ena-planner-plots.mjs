import assert from 'node:assert/strict';

import {
  applyPlannerResultAndSend,
  createDefaultEnaPlannerConfig,
  extractLastNPlots,
  formatPlotsBlock,
  normalizeEnaPlannerConfig,
  shouldInterceptPlannerEnter,
  shouldInterceptPlannerSend,
} from '../ena-planner/ena-planner-runtime-utils.js';
import { createRerollRecallInput } from '../runtime/reroll-recall-input.js';
import {
  createStructuredPlotRecord,
  readPlannerPlotHistory,
  writeStructuredPlotRecordToMatchingUserMessage,
  writeStructuredPlotRecordToMessage,
} from '../ena-planner/planner-plot-history.js';
import {
  collectPlannerCharacterWorldbookNames,
  collectPlannerGlobalWorldbookNames,
  isPlannerWorldbookEntryConstant,
  isPlannerWorldbookEntryEnabled,
  normalizePlannerWorldbookEntries,
  shouldExcludePlannerWorldbookEntry,
} from '../ena-planner/ena-planner-worldbook-utils.js';

{
  const names = await collectPlannerGlobalWorldbookNames({
    context: {
      world_info: { globalSelect: ['old-global', 'duplicate'] },
    },
    tavernHelper: {
      getGlobalWorldbookNames: () => ['helper-global', 'duplicate'],
      getLorebookSettings: async () => ({ selected_global_lorebooks: ['settings-global'] }),
    },
    worldInfoModule: {
      selected_world_info: ['module-global'],
      world_info: { globalSelect: ['saved-global'] },
    },
    windowLike: {
      selected_world_info: ['window-global'],
    },
  });
  assert.deepEqual(names, [
    'helper-global',
    'duplicate',
    'settings-global',
    'module-global',
    'old-global',
    'saved-global',
    'window-global',
  ]);
}

{
  const names = await collectPlannerCharacterWorldbookNames({
    context: {},
    character: null,
    tavernHelper: null,
    windowLike: { selected_world_info: 'global-should-not-leak' },
  });
  assert.deepEqual(
    names,
    [],
    'global selected lorebook must not bypass includeGlobalWorldbooks through character collection',
  );
}

{
  const names = await collectPlannerCharacterWorldbookNames({
    context: {
      characterId: 0,
      characters: [{ world: 'context-char-book' }],
      worldNames: ['chat-linked-book'],
      chat: [{ extra: { world: 'chat-extra-book' } }],
    },
    character: {
      data: {
        extensions: { world: 'char-ext-book' },
        character_book: { name: 'embedded-char-book' },
      },
      world: 'char-world-book',
    },
    tavernHelper: {
      getCharWorldbookNames: () => ({
        primary: 'helper-primary-book',
        additional: ['helper-extra-book'],
      }),
      getCharLorebooks: () => ({
        primary: 'legacy-helper-primary-book',
        additional: ['legacy-helper-extra-book'],
      }),
    },
    windowLike: {},
  });
  assert.deepEqual(names, [
    'helper-primary-book',
    'helper-extra-book',
    'legacy-helper-primary-book',
    'legacy-helper-extra-book',
    'char-ext-book',
    'char-world-book',
    'embedded-char-book',
    'context-char-book',
    'chat-linked-book',
    'chat-extra-book',
  ]);
}

{
  assert.deepEqual(
    normalizePlannerWorldbookEntries('book-a', {
      entries: {
        3: { content: 'raw', comment: 'entry' },
      },
    }),
    [{ uid: 3, content: 'raw', comment: 'entry', _worldName: 'book-a' }],
  );
  assert.deepEqual(
    normalizePlannerWorldbookEntries('book-b', [
      { uid: 4, world: 'source-book', content: 'helper' },
    ]),
    [{ uid: 4, world: 'source-book', content: 'helper', _worldName: 'source-book' }],
  );
}

{
  assert.equal(isPlannerWorldbookEntryEnabled({ constant: true, enabled: false }), false);
  assert.equal(isPlannerWorldbookEntryEnabled({ type: 'constant', disabled: true }), false);
  assert.equal(isPlannerWorldbookEntryEnabled({ disable: true }), false);
  assert.equal(isPlannerWorldbookEntryEnabled({ enabled: true }), true);
  assert.equal(isPlannerWorldbookEntryConstant({ constant: true }), true);
  assert.equal(isPlannerWorldbookEntryConstant({ type: 'constant' }), true);
  assert.equal(isPlannerWorldbookEntryConstant({ type: 'selective' }), false);
}

{
  const chat = [
    { mes: 'no plot here' },
    { mes: '<plot>old one</plot>\n<plot>old two</plot>' },
    { mes: 'assistant says <plot>new one</plot>' },
  ];
  assert.deepEqual(extractLastNPlots(chat, 2), [
    '<plot>new one</plot>',
    '<plot>old two</plot>',
  ]);
  assert.deepEqual(extractLastNPlots(chat, 0), []);
  assert.deepEqual(extractLastNPlots(null, 3), []);
}

{
  const block = formatPlotsBlock([
    '<plot>newest</plot>',
    '<plot>older</plot>',
  ]);
  assert.equal(
    block,
    '<previous_plots>\n【plot -2】\n<plot>older</plot>\n\n【plot -1】\n<plot>newest</plot>\n</previous_plots>',
  );
  assert.equal(formatPlotsBlock([]), '');
}

{
  const order = [];
  const textarea = { value: 'raw' };
  const button = { click: () => order.push('click') };
  const plannerState = { bypassNextSend: false };
  const plannerRecall = {
    memoryBlock: 'planner memory',
    result: { selected: ['memory-a'] },
  };
  const runtime = {
    preparePlannerTurnHandoff(payload) {
      order.push('handoff');
      assert.deepEqual(payload, {
        rawUserInput: 'raw input',
        plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
        plannerRecall,
        plannerPlotRecord: {
          rawUserInput: 'raw input',
          plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
          plannerRecallInjectionText: 'planner memory',
          plotText: '<plot>next</plot>',
        },
        chatId: 'chat-a',
      });
      return {
        result: plannerRecall.result,
        injectionText: 'planner memory',
        plannerPlotRecord: payload.plannerPlotRecord,
      };
    },
  };

  const result = applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput: 'raw input',
    filtered: '<plot>next</plot>',
    plannerRecall,
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
    runtime,
    plannerState,
    chatId: 'chat-a',
  });

  assert.deepEqual(order, ['handoff', 'click']);
  assert.equal(result.applied, true);
  assert.equal(result.handoffPrepared, true);
  assert.equal(result.recallPrepared, true);
  assert.equal(result.plotPrepared, true);
  assert.equal(textarea.value, 'raw input\n\n<plot>next</plot>');
  assert.equal(plannerState.bypassNextSend, false);
}

{
  const defaultFilter = { nameExcludes: [], useDefaultMvuFilter: true };
  assert.equal(
    shouldExcludePlannerWorldbookEntry({ name: '[mvu_plot] 剧情状态' }, defaultFilter),
    true,
  );
  assert.equal(
    shouldExcludePlannerWorldbookEntry({ comment: '[initvar] 初始变量' }, defaultFilter),
    true,
  );
  assert.equal(
    shouldExcludePlannerWorldbookEntry({
      content: 'stat_data: { mood: calm }\ndisplay_data: { mood: calm }',
    }, defaultFilter),
    true,
  );
  assert.equal(
    shouldExcludePlannerWorldbookEntry(
      { name: '[mvu_plot] custom mode keeps explicit content' },
      { nameExcludes: [], useDefaultMvuFilter: false },
    ),
    false,
  );
  assert.equal(
    shouldExcludePlannerWorldbookEntry(
      { comment: 'manual-block entry' },
      { nameExcludes: ['manual-block'], useDefaultMvuFilter: false },
    ),
    true,
  );
}

{
  const order = [];
  const textarea = { value: 'raw' };
  const button = { click: () => order.push('click') };
  const plannerState = { bypassNextSend: false };
  const runtime = {
    preparePlannerTurnHandoff(payload) {
      order.push('handoff');
      return { plannerPlotRecord: payload.plannerPlotRecord };
    },
  };

  const result = applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput: 'raw input',
    filtered: '<plot>next</plot>',
    plannerRecall: null,
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
    runtime,
    plannerState,
  });

  assert.deepEqual(order, ['handoff', 'click']);
  assert.equal(result.applied, true);
  assert.equal(result.handoffPrepared, true);
  assert.equal(result.plotPrepared, true);
  assert.equal(result.recallPrepared, false);
  assert.equal(textarea.value, 'raw input\n\n<plot>next</plot>');
  assert.equal(plannerState.bypassNextSend, false);
}

{
  const defaults = createDefaultEnaPlannerConfig();
  assert.equal(defaults.enabled, false, 'planner must be explicit opt-in');
  assert.equal(normalizeEnaPlannerConfig({}).enabled, false);
  assert.equal(normalizeEnaPlannerConfig({ enabled: 1 }).enabled, false);
  assert.equal(normalizeEnaPlannerConfig({ enabled: true }).enabled, true);
  assert.deepEqual(normalizeEnaPlannerConfig({ api: { llmPreset: '  planner  ', baseUrl: 'legacy' } }).api, {
    llmPreset: 'planner',
  });
}

{
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter' }, true), true);
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter', isComposing: true }, true), false);
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter', shiftKey: true }, true), false);
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter', ctrlKey: true }, true), false);
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter', altKey: true }, true), false);
  assert.equal(shouldInterceptPlannerEnter({ key: 'Enter' }, false), false);
  assert.equal(shouldInterceptPlannerEnter({ key: 'a' }, true), false);
}

{
  const cases = [
    [{ enabled: false, hasTextarea: true, textareaValue: 'go' }, false, 'disabled'],
    [{ enabled: true, isPlanning: true, hasTextarea: true, textareaValue: 'go' }, false, 'planning'],
    [{ enabled: true, hasTextarea: false, textareaValue: 'go' }, false, 'missing-textarea'],
    [{ enabled: true, hasTextarea: true, textareaValue: '   ' }, false, 'empty-input'],
    [{ enabled: true, hasTextarea: true, textareaValue: 'go', isTrivial: true }, false, 'trivial'],
    [{ enabled: true, hasTextarea: true, textareaValue: 'go', bypassNextSend: true }, false, 'bypass'],
    [{ enabled: true, hasTextarea: true, textareaValue: '<plot>done</plot>', skipIfPlotPresent: true }, false, 'plot-present'],
    [{ enabled: true, hasTextarea: true, textareaValue: '<plotter>not a plot tag</plotter>', skipIfPlotPresent: true }, true, 'ok'],
    [{ enabled: true, hasTextarea: true, textareaValue: '<plot id="x">done</plot>', skipIfPlotPresent: false }, true, 'ok'],
    [{ enabled: true, hasTextarea: true, textareaValue: 'continue the scene' }, true, 'ok'],
  ];
  for (const [input, expectedShouldIntercept, expectedReason] of cases) {
    const result = shouldInterceptPlannerSend(input);
    assert.equal(result.shouldIntercept, expectedShouldIntercept, expectedReason);
    assert.equal(result.reason, expectedReason);
  }
}

{
  const chat = [
    { is_user: true, mes: 'raw old', extra: {} },
    { is_user: false, mes: '<plot>legacy stale</plot>' },
    { is_user: true, mes: 'raw latest', extra: {} },
  ];
  writeStructuredPlotRecordToMessage(chat[2], createStructuredPlotRecord({
    rawUserInput: 'raw latest',
    plannerAugmentedMessage: 'raw latest\n\n<note>private</note>\n<plot>structured</plot>\n<state>hidden</state>',
    plannerRecallInjectionText: 'planner memory snapshot',
    plotText: '<note>private</note>\n<plot>structured</plot>\n<state>hidden</state>',
  }));
  assert.equal(chat[2].extra.st_bme_plot.plannerRecallInjectionText, 'planner memory snapshot');
  const history = readPlannerPlotHistory(chat, { count: 2 });
  assert.equal(history.source, 'structured+legacy');
  assert.deepEqual(history.plots, ['<plot>structured</plot>', '<plot>legacy stale</plot>']);
  assert.ok(history.block.includes('<plot>structured</plot>'));
  assert.ok(history.block.includes('legacy stale'));
  assert.ok(!history.block.includes('<note>private</note>'));
  assert.ok(!history.block.includes('<state>hidden</state>'));
}

{
  const chat = [
    { is_user: true, mes: 'raw old', extra: {} },
    { is_user: false, mes: '<plot>legacy old</plot>' },
  ];
  chat[0].extra.st_bme_plot = { version: 999, plotText: '<plot>bad</plot>' };
  const history = readPlannerPlotHistory(chat, { count: 1 });
  assert.equal(history.source, 'legacy');
  assert.deepEqual(history.plots, ['<plot>legacy old</plot>']);
}

{
  const chat = [
    { is_user: true, mes: 'first input', extra: {} },
    { is_user: false, mes: 'assistant' },
    { is_user: true, mes: 'second input', extra: {} },
  ];
  const result = writeStructuredPlotRecordToMatchingUserMessage(chat, {
    rawUserInput: 'first input',
    plannerAugmentedMessage: 'first input\n\n<plot>first plan</plot>',
    plotText: '<plot>first plan</plot>',
  });
  assert.equal(result.index, 0);
  assert.equal(chat[0].extra.st_bme_plot.plotText, '<plot>first plan</plot>');
  assert.equal(chat[2].extra.st_bme_plot, undefined);
}

{
  const runtime = createRerollRecallInput({
    getCurrentChatId: () => 'chat-a',
    normalizeChatIdCandidate: (value) => String(value || '').trim(),
    normalizeRecallInputText: (value) => String(value || '').trim(),
    hashRecallInput: (value) => `hash:${String(value || '').length}`,
  });
  const handoff = runtime.preparePlannerTurnHandoff({
    chatId: 'chat-a',
    rawUserInput: 'raw input',
    plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
  });
  assert.ok(handoff?.id?.startsWith('chat-a:hash:'));
  assert.equal(handoff.plannerPlotRecord.plotText, '<plot>next</plot>');
  assert.equal(runtime.peekPlannerTurnHandoff('chat-a')?.plannerPlotRecord?.plotText, '<plot>next</plot>');
  assert.equal(runtime.consumePlannerTurnHandoff('chat-a')?.plannerPlotRecord?.plotText, '<plot>next</plot>');
  assert.equal(runtime.peekPlannerTurnHandoff('chat-a'), null);
}

{
  const runtime = createRerollRecallInput({
    getCurrentChatId: () => 'chat-a',
    normalizeChatIdCandidate: (value) => String(value || '').trim(),
    normalizeRecallInputText: (value) => String(value || '').trim(),
    hashRecallInput: (value) => `hash:${String(value || '').length}`,
    formatInjection: (result) => result?.injectionText || '',
    getSchema: () => ({}),
  });
  runtime.preparePlannerTurnHandoff({
    chatId: 'chat-a',
    rawUserInput: 'raw input',
    plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
    plannerRecall: {
      ok: true,
      memoryBlock: 'planner memory',
      result: { injectionText: 'planner memory', selectedNodeIds: ['n1'] },
    },
  });
  assert.equal(runtime.peekPlannerTurnHandoff('chat-a')?.injectionText, 'planner memory');
  assert.equal(runtime.clearPlannerTurnHandoffsForChat('chat-a'), 1);
  assert.equal(runtime.peekPlannerTurnHandoff('chat-a'), null);
}

{
  const runtime = createRerollRecallInput({
    getCurrentChatId: () => 'chat-a',
    normalizeChatIdCandidate: (value) => String(value || '').trim(),
    normalizeRecallInputText: (value) => String(value || '').trim(),
    hashRecallInput: () => 'hash',
  });
  const prepare = () => runtime.preparePlannerTurnHandoff({
    chatId: 'chat-a',
    rawUserInput: 'raw input',
    plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
  });

  const stale = prepare();
  assert.equal(
    runtime.markPlannerTurnHandoffMatched('chat-a', {
      handoffId: stale.id,
      generationId: 'generation-1',
    })?.matchedGenerationId,
    'generation-1',
  );
  assert.equal(
    runtime.markPlannerTurnHandoffMatched('chat-a', {
      handoffId: stale.id,
      generationId: 'generation-2',
    }),
    null,
    'one planner handoff cannot be rebound to a later generation',
  );
  assert.equal(runtime.consumePlannerTurnHandoffForGeneration('chat-a', 'generation-2'), null);
  assert.equal(runtime.peekPlannerTurnHandoff('chat-a'), null);

  const current = prepare();
  runtime.markPlannerTurnHandoffMatched('chat-a', {
    handoffId: current.id,
    generationId: 'generation-3',
  });
  assert.equal(
    runtime.consumePlannerTurnHandoffForGeneration('chat-a', 'generation-3')?.id,
    current.id,
    'MESSAGE_SENT can consume only the handoff matched to its generation',
  );
}

{
  const chat = [{
    is_user: true,
    mes: 'raw input\n\n<plot>next</plot>',
    extra: {},
  }];
  const runtime = createRerollRecallInput({
    getCurrentChatId: () => 'integrity-chat-id',
    getContext: () => ({ chatId: 'host-chat-id', chat }),
    getActiveGenerationId: () => 'generation-1',
    normalizeChatIdCandidate: (value) => String(value || '').trim(),
    normalizeRecallInputText: (value) => String(value || '').trim(),
    hashRecallInput: () => 'hash',
    writeStructuredPlotRecordToMessage,
  });
  const handoff = runtime.preparePlannerTurnHandoff({
    chatId: 'integrity-chat-id',
    rawUserInput: 'raw input',
    plannerAugmentedMessage: chat[0].mes,
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
  });
  runtime.markPlannerTurnHandoffMatched('integrity-chat-id', {
    handoffId: handoff.id,
    generationId: 'generation-1',
  });

  assert.equal(runtime.persistPlannerTurnHandoffToUserMessage(0), true);
  assert.equal(chat[0].extra.st_bme_plot.plotText, '<plot>next</plot>');
}

{
  const runtime = createRerollRecallInput({
    getCurrentChatId: () => 'chat-a',
    normalizeChatIdCandidate: (value) => String(value || '').trim(),
    normalizeRecallInputText: (value) => String(value || '').trim(),
    hashRecallInput: () => 'hash',
    formatInjection: () => '',
    getSchema: () => ({}),
  });
  assert.equal(runtime.preparePlannerTurnHandoff({
    chatId: 'chat-a',
    rawUserInput: 'raw input',
    plannerAugmentedMessage: 'raw input',
    plannerRecall: { result: { selectedNodeIds: [] }, memoryBlock: '' },
  }), null, 'empty planner recall must not suppress the normal recall');
}

{
  const order = [];
  const result = applyPlannerResultAndSend({
    textarea: null,
    button: { click: () => order.push('click') },
  });
  assert.deepEqual(result, { applied: false, reason: 'missing-target' });
  assert.deepEqual(order, []);
}

console.log('ena-planner-plots tests passed');
