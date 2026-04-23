/**
 * ENA Planner - native BME panel integration
 *
 * This module binds the planner config section inside `ui/panel.html` to the
 * runtime API exposed by `ena-planner/ena-planner.js` (via `window.stBmeEnaPlanner`).
 *
 * Replaces the previous iframe + postMessage bridge with direct function calls,
 * so the planner configuration lives inside the main panel's DOM and inherits
 * BME theming automatically.
 */

import {
  isSameLlmConfigSnapshot,
  resolveDedicatedLlmProviderConfig,
  sanitizeLlmPresetSettings,
} from '../llm/llm-preset-utils.js';

const SECTION_SELECTOR = '[data-config-section="planner"]';
const AUTOSAVE_DELAY_MS = 600;

let bound = false;
let unsubscribePlanner = null;
let autoSaveTimer = null;
let cfgCache = null;
let logsCache = [];
let fetchedModels = [];
let undoState = null;
let fieldChangeHandler = null;
let autosaveInProgress = false;
let externalGetSettings = null;

/* ── DOM helpers ────────────────────────────────────────────────────────── */

function $(id) { return document.getElementById(id); }

function getPlannerApi() {
  return globalThis?.stBmeEnaPlanner || null;
}

function setHidden(el, hidden) {
  if (!el) return;
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

function setStatusChip(id, text, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = text ?? '';
  el.dataset.tone = tone || 'idle';
}

function setLocalStatus(id, text, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = text ?? '';
  el.dataset.tone = tone || '';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Type coercion ──────────────────────────────────────────────────────── */

function toBool(v, fallback = false) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function arrToCsv(arr) {
  return Array.isArray(arr) ? arr.join(', ') : '';
}

function csvToArr(text) {
  return String(text || '')
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeKeepTagsInput(text) {
  const src = csvToArr(text);
  const out = [];
  for (const item of src) {
    const tag = String(item || '').replace(/^<+|>+$/g, '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function genId() {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
}

function getSharedSettingsSnapshot() {
  return typeof externalGetSettings === 'function'
    ? (externalGetSettings() || {})
    : {};
}

function getSharedLlmPresetState() {
  const settings = getSharedSettingsSnapshot();
  return sanitizeLlmPresetSettings(settings || {});
}

function buildPlannerLlmSnapshot(source = {}) {
  return {
    llmApiUrl: String(source?.llmApiUrl || '').trim(),
    llmApiKey: String(source?.llmApiKey || '').trim(),
    llmModel: String(source?.llmModel || '').trim(),
  };
}

function getCurrentPlannerLlmSnapshot() {
  const rawUrl = String(
    $('bme-planner-api-base')?.value ?? cfgCache?.api?.baseUrl ?? '',
  ).trim();
  const resolved = resolveDedicatedLlmProviderConfig(rawUrl);
  return buildPlannerLlmSnapshot({
    llmApiUrl: resolved.apiUrl || rawUrl,
    llmApiKey: $('bme-planner-api-key')?.value ?? cfgCache?.api?.apiKey ?? '',
    llmModel: $('bme-planner-model')?.value ?? cfgCache?.api?.model ?? '',
  });
}

function normalizePlannerPresetSnapshot(preset = {}) {
  const rawUrl = String(preset?.llmApiUrl || '').trim();
  const resolved = resolveDedicatedLlmProviderConfig(rawUrl);
  return buildPlannerLlmSnapshot({
    llmApiUrl: resolved.apiUrl || rawUrl,
    llmApiKey: preset?.llmApiKey || '',
    llmModel: preset?.llmModel || '',
  });
}

function resolveMatchingPlannerLlmPresetName(snapshot = getCurrentPlannerLlmSnapshot()) {
  const { presets, activePreset } = getSharedLlmPresetState();
  const exactMatches = Object.keys(presets || {}).filter((name) =>
    isSameLlmConfigSnapshot(snapshot, normalizePlannerPresetSnapshot(presets[name])),
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1 && activePreset && exactMatches.includes(activePreset)) {
    return activePreset;
  }
  return '';
}

function populatePlannerLlmPresetSelect(selectedPreset = resolveMatchingPlannerLlmPresetName()) {
  const select = $('bme-planner-llm-preset-select');
  if (!select) return;

  while (select.options.length > 1) {
    select.remove(1);
  }

  const { presets } = getSharedLlmPresetState();
  Object.keys(presets || {})
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    .forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

  select.value = selectedPreset || '';
}

function syncPlannerLlmPresetSelect() {
  populatePlannerLlmPresetSelect(resolveMatchingPlannerLlmPresetName());
}

function inferPlannerApiConfigFromPreset(preset = {}) {
  const rawUrl = String(preset?.llmApiUrl || '').trim();
  const resolved = resolveDedicatedLlmProviderConfig(rawUrl);
  let channel = 'openai';
  if (resolved.providerId === 'google-ai-studio') channel = 'gemini';
  else if (resolved.providerId === 'anthropic-claude') channel = 'claude';

  return {
    channel,
    prefixMode: 'auto',
    customPrefix: '',
    baseUrl: resolved.apiUrl || rawUrl,
    apiKey: String(preset?.llmApiKey || '').trim(),
    model: String(preset?.llmModel || '').trim(),
  };
}

function applyPlannerLlmPresetToFields(name, preset = {}) {
  const inferred = inferPlannerApiConfigFromPreset(preset);
  const setVal = (id, value) => {
    const el = $(id);
    if (el) el.value = value;
  };

  setVal('bme-planner-api-channel', inferred.channel || 'openai');
  setVal('bme-planner-prefix-mode', inferred.prefixMode || 'auto');
  setVal('bme-planner-prefix-custom', inferred.customPrefix || '');
  setVal('bme-planner-api-base', inferred.baseUrl || '');
  setVal('bme-planner-api-key', inferred.apiKey || '');
  setVal('bme-planner-model', inferred.model || '');
  updatePrefixModeUI();
  populatePlannerLlmPresetSelect(name);
}

/* ── Prompt block editor ────────────────────────────────────────────────── */

function createPromptBlockElement(block, idx, total) {
  const wrap = document.createElement('div');
  wrap.className = 'bme-planner-prompt-block';

  const head = document.createElement('div');
  head.className = 'bme-planner-prompt-head';

  const left = document.createElement('div');
  left.className = 'bme-planner-prompt-head-left';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'bme-config-input';
  nameInput.placeholder = '块名称';
  nameInput.value = block.name || '';
  nameInput.addEventListener('change', () => {
    block.name = nameInput.value;
    scheduleSave();
  });

  const roleSelect = document.createElement('select');
  roleSelect.className = 'bme-config-input';
  for (const r of ['system', 'user', 'assistant']) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    opt.selected = (block.role || 'system') === r;
    roleSelect.appendChild(opt);
  }
  roleSelect.addEventListener('change', () => {
    block.role = roleSelect.value;
    scheduleSave();
  });

  left.append(nameInput, roleSelect);

  const right = document.createElement('div');
  right.className = 'bme-planner-prompt-head-right';

  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'bme-config-secondary-btn bme-planner-icon-btn';
  upBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
  upBtn.title = '上移';
  upBtn.disabled = idx === 0;
  upBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!cfgCache?.promptBlocks || idx === 0) return;
    const blocks = cfgCache.promptBlocks;
    [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]];
    renderPromptList();
    scheduleSave();
  });

  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'bme-config-secondary-btn bme-planner-icon-btn';
  downBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
  downBtn.title = '下移';
  downBtn.disabled = idx === total - 1;
  downBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!cfgCache?.promptBlocks || idx >= total - 1) return;
    const blocks = cfgCache.promptBlocks;
    [blocks[idx], blocks[idx + 1]] = [blocks[idx + 1], blocks[idx]];
    renderPromptList();
    scheduleSave();
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'bme-config-secondary-btn bme-config-danger-btn bme-planner-icon-btn';
  delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
  delBtn.title = '删除块';
  delBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!cfgCache?.promptBlocks) return;
    cfgCache.promptBlocks.splice(idx, 1);
    renderPromptList();
    scheduleSave();
  });

  right.append(upBtn, downBtn, delBtn);

  const content = document.createElement('textarea');
  content.className = 'bme-config-input bme-planner-textarea';
  content.placeholder = '提示词内容...';
  content.rows = 4;
  content.value = block.content || '';
  content.addEventListener('change', () => {
    block.content = content.value;
    scheduleSave();
  });

  head.append(left, right);
  wrap.append(head, content);
  return wrap;
}

function renderPromptList() {
  const list = $('bme-planner-prompt-list');
  const empty = $('bme-planner-prompt-empty');
  if (!list || !empty) return;
  const blocks = cfgCache?.promptBlocks || [];
  list.innerHTML = '';
  if (!blocks.length) {
    setHidden(empty, false);
    return;
  }
  setHidden(empty, true);
  blocks.forEach((block, idx) => {
    list.appendChild(createPromptBlockElement(block, idx, blocks.length));
  });
}

function renderTemplateSelect(selected = '') {
  const sel = $('bme-planner-tpl-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 选择模板 --</option>';
  const names = Object.keys(cfgCache?.promptTemplates || {});
  const selectedName = names.includes(selected) ? selected : '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === selectedName;
    sel.appendChild(opt);
  }
}

/* ── Undo for template delete ───────────────────────────────────────────── */

function clearUndo() {
  if (undoState?.timer) clearTimeout(undoState.timer);
  undoState = null;
  const bar = $('bme-planner-tpl-undo');
  setHidden(bar, true);
}

function showUndoBar(name, blocks) {
  clearUndo();
  undoState = {
    name,
    blocks,
    timer: setTimeout(() => {
      undoState = null;
      setHidden($('bme-planner-tpl-undo'), true);
    }, 5000),
  };
  const nameEl = $('bme-planner-tpl-undo-name');
  if (nameEl) nameEl.textContent = name;
  setHidden($('bme-planner-tpl-undo'), false);
}

/* ── Logs rendering ─────────────────────────────────────────────────────── */

function renderLogs() {
  const body = $('bme-planner-log-body');
  if (!body) return;
  const list = Array.isArray(logsCache) ? logsCache : [];
  if (!list.length) {
    body.innerHTML = '<div class="bme-planner-log-empty">暂无日志</div>';
    return;
  }
  body.innerHTML = list
    .map((item) => {
      const time = item.time ? new Date(item.time).toLocaleString() : '-';
      const cls = item.ok ? 'success' : 'error';
      const label = item.ok ? '成功' : '失败';
      let msgHtml = '';
      if (Array.isArray(item.requestMessages) && item.requestMessages.length) {
        msgHtml = item.requestMessages
          .map((m, i) => {
            const role = escapeHtml(m.role || 'unknown');
            const roleClass =
              role === 'system'
                ? 'msg-system'
                : role === 'user'
                  ? 'msg-user'
                  : 'msg-assistant';
            const content = escapeHtml(m.content || '');
            return `<div class="bme-planner-msg-card ${roleClass}">
              <div class="bme-planner-msg-role">[${i + 1}] ${role}</div>
              <pre class="bme-planner-msg-content">${content}</pre>
            </div>`;
          })
          .join('');
      } else {
        msgHtml = '<div class="bme-planner-log-empty">无消息</div>';
      }
      return `
        <div class="bme-planner-log-item">
          <div class="bme-planner-log-meta">
            <span>${escapeHtml(time)} · <span class="${cls}">${label}</span></span>
            <span>${escapeHtml(item.model || '-')}</span>
          </div>
          ${item.error ? `<div class="bme-planner-log-error">${escapeHtml(item.error)}</div>` : ''}
          <details><summary>请求消息 (${(item.requestMessages || []).length} 条)</summary>
            <div class="bme-planner-msg-list">${msgHtml}</div>
          </details>
          <details><summary>原始回复</summary>
            <pre class="bme-planner-log-pre">${escapeHtml(item.rawReply || '')}</pre>
          </details>
          <details open><summary>过滤后回复</summary>
            <pre class="bme-planner-log-pre">${escapeHtml(item.filteredReply || '')}</pre>
          </details>
        </div>`;
    })
    .join('');
}

/* ── Apply / collect ────────────────────────────────────────────────────── */

function applyConfigToFields(cfg) {
  cfgCache = cfg || {};
  const api = cfgCache.api || {};

  const setVal = (id, value) => {
    const el = $(id);
    if (el) el.value = value;
  };

  setVal('bme-planner-enabled', String(toBool(cfgCache.enabled, false)));
  setVal('bme-planner-skip-plot', String(toBool(cfgCache.skipIfPlotPresent, true)));

  setVal('bme-planner-api-channel', api.channel || 'openai');
  setVal('bme-planner-prefix-mode', api.prefixMode || 'auto');
  setVal('bme-planner-api-base', api.baseUrl || '');
  setVal('bme-planner-prefix-custom', api.customPrefix || '');
  setVal('bme-planner-api-key', api.apiKey || '');
  setVal('bme-planner-model', api.model || '');
  setVal('bme-planner-stream', String(toBool(api.stream, false)));
  setVal('bme-planner-temp', String(toNum(api.temperature, 1)));
  setVal('bme-planner-top-p', String(toNum(api.top_p, 1)));
  setVal('bme-planner-top-k', String(toNum(api.top_k, 0)));
  setVal('bme-planner-pp', api.presence_penalty ?? '');
  setVal('bme-planner-fp', api.frequency_penalty ?? '');
  setVal('bme-planner-mt', api.max_tokens ?? '');

  setVal('bme-planner-include-global-wb', String(toBool(cfgCache.includeGlobalWorldbooks, false)));
  setVal('bme-planner-wb-pos4', String(toBool(cfgCache.excludeWorldbookPosition4, true)));
  setVal('bme-planner-wb-exclude-names', arrToCsv(cfgCache.worldbookExcludeNames));
  setVal('bme-planner-plot-n', String(toNum(cfgCache.plotCount, 2)));
  setVal(
    'bme-planner-keep-tags',
    arrToCsv(
      cfgCache.responseKeepTags || ['plot', 'note', 'plot-log', 'state'],
    ),
  );
  setVal('bme-planner-exclude-tags', arrToCsv(cfgCache.chatExcludeTags));

  setVal('bme-planner-logs-persist', String(toBool(cfgCache.logsPersist, true)));
  setVal('bme-planner-logs-max', String(toNum(cfgCache.logsMax, 20)));

  setStatusChip(
    'bme-planner-state-chip',
    toBool(cfgCache.enabled, false) ? '已启用' : '未启用',
    toBool(cfgCache.enabled, false) ? 'active' : 'idle',
  );
  updatePrefixModeUI();
  syncPlannerLlmPresetSelect();

  const keepSelected = cfgCache.activePromptTemplate || $('bme-planner-tpl-select')?.value || '';
  renderTemplateSelect(keepSelected);
  renderPromptList();
}

function collectPatch() {
  const getVal = (id) => $(id)?.value ?? '';

  return {
    enabled: toBool(getVal('bme-planner-enabled'), false),
    skipIfPlotPresent: toBool(getVal('bme-planner-skip-plot'), true),
    api: {
      channel: getVal('bme-planner-api-channel'),
      prefixMode: getVal('bme-planner-prefix-mode'),
      baseUrl: getVal('bme-planner-api-base').trim(),
      customPrefix: getVal('bme-planner-prefix-custom').trim(),
      apiKey: getVal('bme-planner-api-key'),
      model: getVal('bme-planner-model').trim(),
      stream: toBool(getVal('bme-planner-stream'), false),
      temperature: toNum(getVal('bme-planner-temp'), 1),
      top_p: toNum(getVal('bme-planner-top-p'), 1),
      top_k: Math.floor(toNum(getVal('bme-planner-top-k'), 0)),
      presence_penalty: getVal('bme-planner-pp').trim(),
      frequency_penalty: getVal('bme-planner-fp').trim(),
      max_tokens: getVal('bme-planner-mt').trim(),
    },
    includeGlobalWorldbooks: toBool(getVal('bme-planner-include-global-wb'), false),
    excludeWorldbookPosition4: toBool(getVal('bme-planner-wb-pos4'), true),
    worldbookExcludeNames: csvToArr(getVal('bme-planner-wb-exclude-names')),
    plotCount: Math.max(0, Math.floor(toNum(getVal('bme-planner-plot-n'), 2))),
    responseKeepTags: normalizeKeepTagsInput(getVal('bme-planner-keep-tags')),
    chatExcludeTags: csvToArr(getVal('bme-planner-exclude-tags')),
    logsPersist: toBool(getVal('bme-planner-logs-persist'), true),
    logsMax: Math.max(1, Math.min(200, Math.floor(toNum(getVal('bme-planner-logs-max'), 20)))),
    promptBlocks: cfgCache?.promptBlocks || [],
    promptTemplates: cfgCache?.promptTemplates || {},
    activePromptTemplate: $('bme-planner-tpl-select')?.value || '',
  };
}

function updatePrefixModeUI() {
  const mode = $('bme-planner-prefix-mode')?.value || 'auto';
  setHidden($('bme-planner-prefix-custom-row'), mode !== 'custom');
}

/* ── Save flow ──────────────────────────────────────────────────────────── */

function scheduleSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(doSave, AUTOSAVE_DELAY_MS);
}

async function doSave() {
  if (autosaveInProgress) return;
  const api = getPlannerApi();
  if (!api?.patchConfig) {
    setStatusChip('bme-planner-save-chip', 'API 未就绪', 'error');
    return;
  }
  autosaveInProgress = true;
  setStatusChip('bme-planner-save-chip', '保存中…', 'loading');
  try {
    const patch = collectPatch();
    const res = await api.patchConfig(patch);
    if (res?.ok) {
      setStatusChip('bme-planner-save-chip', '已保存', 'success');
      setTimeout(() => {
        if ($('bme-planner-save-chip')?.dataset?.tone === 'success') {
          setStatusChip('bme-planner-save-chip', '就绪', 'idle');
        }
      }, 2000);
    } else {
      setStatusChip('bme-planner-save-chip', res?.error || '保存失败', 'error');
    }
  } catch (err) {
    setStatusChip('bme-planner-save-chip', String(err?.message ?? err), 'error');
  } finally {
    autosaveInProgress = false;
  }
}

/* ── Event wiring ───────────────────────────────────────────────────────── */

function onKeepTagsBlur() {
  const el = $('bme-planner-keep-tags');
  if (!el) return;
  const normalized = normalizeKeepTagsInput(el.value);
  el.value = normalized.join(', ');
}

function bindOnce(section) {
  if (bound) return;
  bound = true;

  const api = getPlannerApi();

  /* Basic settings */
  $('bme-planner-enabled')?.addEventListener('change', () => {
    setStatusChip(
      'bme-planner-state-chip',
      toBool($('bme-planner-enabled').value, false) ? '已启用' : '未启用',
      toBool($('bme-planner-enabled').value, false) ? 'active' : 'idle',
    );
  });

  $('bme-planner-run-test')?.addEventListener('click', async () => {
    const textEl = $('bme-planner-test-input');
    const text = (textEl?.value || '').trim();
    setLocalStatus('bme-planner-test-status', '测试中…', 'loading');
    const res = await api?.runTest?.(text);
    if (res?.ok) setLocalStatus('bme-planner-test-status', '规划测试完成', 'success');
    else setLocalStatus('bme-planner-test-status', res?.error || '规划测试失败', 'error');
  });

  /* API connection */
  $('bme-planner-toggle-key')?.addEventListener('click', () => {
    const input = $('bme-planner-api-key');
    const btn = $('bme-planner-toggle-key');
    if (!input || !btn) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.querySelector('span').textContent = '隐藏';
    } else {
      input.type = 'password';
      btn.querySelector('span').textContent = '显示';
    }
  });

  $('bme-planner-prefix-mode')?.addEventListener('change', updatePrefixModeUI);

  const handleFetchModels = async (statusText) => {
    setLocalStatus('bme-planner-api-status', statusText, 'loading');
    const res = await api?.fetchModels?.();
    if (!res) {
      setLocalStatus('bme-planner-api-status', 'API 未就绪', 'error');
      return;
    }
    if (!res.ok) {
      setLocalStatus('bme-planner-api-status', res.error || '拉取失败', 'error');
      return;
    }
    const models = Array.isArray(res.models) ? res.models : [];
    if (!models.length) {
      setLocalStatus('bme-planner-api-status', '未获取到模型', 'error');
      const sel = $('bme-planner-model-select');
      if (sel) sel.style.display = 'none';
      return;
    }
    fetchedModels = models;
    const sel = $('bme-planner-model-select');
    if (sel) {
      sel.innerHTML = '<option value="">-- 从列表选择 --</option>';
      const cur = ($('bme-planner-model')?.value || '').trim();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        opt.selected = m === cur;
        sel.appendChild(opt);
      }
      sel.style.display = '';
    }
    setLocalStatus('bme-planner-api-status', `获取到 ${models.length} 个模型`, 'success');
  };

  $('bme-planner-fetch-models')?.addEventListener('click', () => handleFetchModels('拉取中…'));
  $('bme-planner-test-conn')?.addEventListener('click', () => handleFetchModels('测试中…'));

  $('bme-planner-model-select')?.addEventListener('change', () => {
    const sel = $('bme-planner-model-select');
    const val = sel?.value;
    if (!val) return;
    const modelInput = $('bme-planner-model');
    if (modelInput) modelInput.value = val;
    syncPlannerLlmPresetSelect();
    scheduleSave();
  });

  $('bme-planner-llm-preset-select')?.addEventListener('change', () => {
    const select = $('bme-planner-llm-preset-select');
    const selectedName = String(select?.value || '');
    if (!selectedName) {
      setLocalStatus('bme-planner-api-status', '', '');
      return;
    }
    const { presets } = getSharedLlmPresetState();
    const preset = presets?.[selectedName];
    if (!preset) {
      populatePlannerLlmPresetSelect('');
      setLocalStatus('bme-planner-api-status', '选中的 BME 模板不存在，已切回手动模式', 'error');
      return;
    }
    applyPlannerLlmPresetToFields(selectedName, preset);
    setLocalStatus('bme-planner-api-status', `已套用 BME 模板：${selectedName}`, 'success');
    scheduleSave();
  });

  /* Prompts + templates */
  $('bme-planner-keep-tags')?.addEventListener('change', onKeepTagsBlur);

  $('bme-planner-add-prompt')?.addEventListener('click', () => {
    cfgCache = cfgCache || {};
    cfgCache.promptBlocks = cfgCache.promptBlocks || [];
    cfgCache.promptBlocks.push({ id: genId(), role: 'system', name: '新块', content: '' });
    renderPromptList();
    scheduleSave();
  });

  $('bme-planner-reset-prompt')?.addEventListener('click', async () => {
    if (!confirm('确定恢复默认提示词块？当前提示词块将被覆盖。')) return;
    setStatusChip('bme-planner-save-chip', '重置中…', 'loading');
    const res = await api?.resetPromptToDefault?.();
    if (res?.ok && res.config) {
      applyConfigToFields(res.config);
      setStatusChip('bme-planner-save-chip', '已恢复默认', 'success');
    } else {
      setStatusChip('bme-planner-save-chip', res?.error || '重置失败', 'error');
    }
  });

  $('bme-planner-tpl-select')?.addEventListener('change', () => {
    const name = $('bme-planner-tpl-select').value;
    if (!cfgCache) return;
    cfgCache.activePromptTemplate = name;
    if (!name) return;
    const blocks = cfgCache.promptTemplates?.[name];
    if (!Array.isArray(blocks)) return;
    cfgCache.promptBlocks = structuredClone(blocks);
    renderPromptList();
    scheduleSave();
  });

  $('bme-planner-tpl-save')?.addEventListener('click', () => {
    const name = $('bme-planner-tpl-select').value;
    if (!name) {
      setStatusChip('bme-planner-save-chip', '请先选择或新建模板', 'error');
      return;
    }
    cfgCache.promptTemplates = cfgCache.promptTemplates || {};
    cfgCache.promptTemplates[name] = structuredClone(cfgCache.promptBlocks || []);
    cfgCache.activePromptTemplate = name;
    renderTemplateSelect(name);
    scheduleSave();
  });

  $('bme-planner-tpl-saveas')?.addEventListener('click', () => {
    const name = prompt('新模板名称');
    if (!name) return;
    cfgCache.promptTemplates = cfgCache.promptTemplates || {};
    cfgCache.promptTemplates[name] = structuredClone(cfgCache.promptBlocks || []);
    cfgCache.activePromptTemplate = name;
    renderTemplateSelect(name);
    scheduleSave();
  });

  $('bme-planner-tpl-delete')?.addEventListener('click', () => {
    const name = $('bme-planner-tpl-select').value;
    if (!name) return;
    cfgCache.promptTemplates = cfgCache.promptTemplates || {};
    const backup = structuredClone(cfgCache.promptTemplates[name]);
    delete cfgCache.promptTemplates[name];
    cfgCache.activePromptTemplate = '';
    renderTemplateSelect('');
    showUndoBar(name, backup);
    scheduleSave();
  });

  $('bme-planner-tpl-undo-btn')?.addEventListener('click', () => {
    if (!undoState) return;
    cfgCache.promptTemplates = cfgCache.promptTemplates || {};
    cfgCache.promptTemplates[undoState.name] = undoState.blocks;
    cfgCache.activePromptTemplate = undoState.name;
    renderTemplateSelect(undoState.name);
    clearUndo();
    scheduleSave();
  });

  /* Debug tools */
  $('bme-planner-debug-wb')?.addEventListener('click', async () => {
    const out = $('bme-planner-debug-output');
    if (out) {
      setHidden(out, false);
      out.textContent = '诊断中…';
    }
    const res = await api?.debugWorldbook?.();
    if (out) out.textContent = res?.output ?? '诊断失败';
  });

  $('bme-planner-debug-char')?.addEventListener('click', async () => {
    const out = $('bme-planner-debug-output');
    if (out) {
      setHidden(out, false);
      out.textContent = '诊断中…';
    }
    const res = await api?.debugChar?.();
    if (out) out.textContent = res?.output ?? '诊断失败';
  });

  /* Logs */
  $('bme-planner-logs-refresh')?.addEventListener('click', () => {
    if (!api?.getLogs) return;
    logsCache = api.getLogs();
    renderLogs();
  });

  $('bme-planner-logs-clear')?.addEventListener('click', async () => {
    if (!confirm('确定清空所有日志？')) return;
    const res = await api?.clearLogs?.();
    if (res?.ok !== false) {
      logsCache = [];
      renderLogs();
    }
  });

  $('bme-planner-logs-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(logsCache || [], null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ena-planner-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  /* Generic field auto-save: every `.bme-config-input` inside this section
     except the test-input textarea and prompt block inputs saves on change. */
  fieldChangeHandler = (ev) => {
    const target = ev.target;
    if (!target) return;
    if (target.closest('.bme-planner-prompt-block')) return;
    if (target.id === 'bme-planner-test-input') return;
    if (target.id === 'bme-planner-llm-preset-select') return;
    if (!target.classList?.contains('bme-config-input')) return;
    syncPlannerLlmPresetSelect();
    scheduleSave();
  };
  section.addEventListener('change', fieldChangeHandler);
}

/* ── Public controller ──────────────────────────────────────────────────── */

export function initPlannerSections(rootEl, options = {}) {
  const root = rootEl || document;
  const section = root.querySelector(SECTION_SELECTOR);
  if (!section) return;
  if (typeof options.getSettings === 'function') {
    externalGetSettings = options.getSettings;
  }
  bindOnce(section);

  const api = getPlannerApi();
  if (!api) {
    setStatusChip('bme-planner-state-chip', '模块未加载', 'error');
    setStatusChip('bme-planner-save-chip', '不可用', 'error');
    return;
  }

  if (!unsubscribePlanner && typeof api.subscribe === 'function') {
    unsubscribePlanner = api.subscribe((kind, payload) => {
      if (kind === 'config') {
        applyConfigToFields(payload || {});
      } else if (kind === 'logs') {
        logsCache = Array.isArray(payload) ? payload : [];
        renderLogs();
      }
    });
  }

  const cfg = typeof api.getConfig === 'function' ? api.getConfig() : null;
  if (cfg) applyConfigToFields(cfg);

  if (typeof api.getLogs === 'function') {
    logsCache = api.getLogs() || [];
    renderLogs();
  }
}

export function refreshPlannerSections(options = {}) {
  if (typeof options.getSettings === 'function') {
    externalGetSettings = options.getSettings;
  }
  const api = getPlannerApi();
  if (!api) {
    setStatusChip('bme-planner-state-chip', '模块未加载', 'error');
    return;
  }
  if (typeof api.getConfig === 'function') applyConfigToFields(api.getConfig());
  if (typeof api.getLogs === 'function') {
    logsCache = api.getLogs() || [];
    renderLogs();
  }
}

export function cleanupPlannerSections() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (typeof unsubscribePlanner === 'function') {
    try { unsubscribePlanner(); } catch {}
  }
  unsubscribePlanner = null;
  if (fieldChangeHandler) {
    const section = document.querySelector(SECTION_SELECTOR);
    section?.removeEventListener('change', fieldChangeHandler);
    fieldChangeHandler = null;
  }
  bound = false;
  cfgCache = null;
  logsCache = [];
  fetchedModels = [];
  externalGetSettings = null;
  clearUndo();
}
