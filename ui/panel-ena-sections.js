/**
 * ENA Planner - native BME panel integration
 *
 * This module binds the planner config section inside `ui/panel.html` to the
 * runtime API exposed by `ena-planner/ena-planner.js`.
 *
 * Replaces the previous iframe + postMessage bridge with direct function calls,
 * so the planner configuration lives inside the main panel's DOM and inherits
 * BME theming automatically.
 */

import { t } from '../i18n/index.js';
import { sanitizeLlmPresetSettings } from '../llm/llm-preset-utils.js';

const SECTION_SELECTOR = '[data-config-section="planner"]';
const AUTOSAVE_DELAY_MS = 600;

let bound = false;
let unsubscribePlanner = null;
let autoSaveTimer = null;
let cfgCache = null;
let logsCache = [];
let fieldChangeHandler = null;
let autosaveInProgress = false;
let externalGetSettings = null;
let externalGetPlannerApi = null;
let pendingSavePatch = null;

/* ── DOM helpers ────────────────────────────────────────────────────────── */

function $(id) { return document.getElementById(id); }

function getPlannerApi() {
  return typeof externalGetPlannerApi === 'function'
    ? externalGetPlannerApi() || null
    : null;
}

function formatPlannerDebugFailure(res, fallbackKey = 'planner.debug.failed') {
  const detail = String(res?.output || res?.error || '').trim();
  if (detail) return `${t(fallbackKey)}\n${detail}`;
  return t(fallbackKey);
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

function getSharedSettingsSnapshot() {
  return typeof externalGetSettings === 'function'
    ? (externalGetSettings() || {})
    : {};
}

function getSharedLlmPresetState() {
  const settings = getSharedSettingsSnapshot();
  return sanitizeLlmPresetSettings(settings || {});
}

function openPlannerTaskPresetWorkspace() {
  const configTabBtn = document.querySelector('.bme-tab-btn[data-tab="config"]');
  configTabBtn?.click();

  const promptsSectionBtn = document.querySelector(
    '.bme-config-nav-btn[data-config-section="prompts"]',
  );
  promptsSectionBtn?.click();

  const activatePlannerTaskType = () => {
    const plannerBtn = document.querySelector(
      '[data-task-action="switch-task-type"][data-task-type="planner"]',
    );
    plannerBtn?.click();
    return Boolean(plannerBtn);
  };

  if (activatePlannerTaskType()) {
    return true;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      promptsSectionBtn?.click();
      activatePlannerTaskType();
    });
  });
  return Boolean(configTabBtn || promptsSectionBtn);
}

function resolvePlannerLlmSelectState(config = cfgCache || {}) {
  const api = config?.api && typeof config.api === 'object' ? config.api : {};
  const selectedPresetName = String(api?.llmPreset || '').trim();
  const { presets } = getSharedLlmPresetState();

  if (selectedPresetName) {
    if (Object.prototype.hasOwnProperty.call(presets || {}, selectedPresetName)) {
      return {
        value: selectedPresetName,
        mode: 'preset',
      };
    }
    return {
      value: '',
      mode: 'global',
      missingPresetName: selectedPresetName,
    };
  }

  return {
    value: '',
    mode: 'global',
  };
}

function populatePlannerLlmPresetSelect(selectedPreset = resolvePlannerLlmSelectState().value) {
  const select = $('bme-planner-llm-preset-select');
  if (!select) return;

  if (select.options.length > 0) {
    select.options[0].textContent = t('planner.llmPreset.global');
  }

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
  populatePlannerLlmPresetSelect(resolvePlannerLlmSelectState().value);
}

/* ── Logs rendering ─────────────────────────────────────────────────────── */

function renderLogs() {
  const body = $('bme-planner-log-body');
  if (!body) return;
  const list = Array.isArray(logsCache) ? logsCache : [];
  if (!list.length) {
    body.innerHTML = `<div class="bme-planner-log-empty">${t('planner.log.noLogs')}</div>`;
    return;
  }
  body.innerHTML = list
    .map((item) => {
      const time = item.time ? new Date(item.time).toLocaleString() : '-';
      const cls = item.ok ? 'success' : 'error';
      const label = item.ok ? t('planner.log.success') : t('planner.log.failure');
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
        msgHtml = `<div class="bme-planner-log-empty">${t('planner.log.noMessages')}</div>`;
      }
      return `
        <div class="bme-planner-log-item">
          <div class="bme-planner-log-meta">
            <span>${escapeHtml(time)} · <span class="${cls}">${label}</span></span>
            <span>${escapeHtml(item.model || '-')}</span>
          </div>
          ${item.error ? `<div class="bme-planner-log-error">${escapeHtml(item.error)}</div>` : ''}
          <details><summary>${t('planner.log.requestMessages', { count: (item.requestMessages || []).length })}</summary>
            <div class="bme-planner-msg-list">${msgHtml}</div>
          </details>
          <details><summary>${t('planner.log.rawReply')}</summary>
            <pre class="bme-planner-log-pre">${escapeHtml(item.rawReply || '')}</pre>
          </details>
          <details open><summary>${t('planner.log.filteredReply')}</summary>
            <pre class="bme-planner-log-pre">${escapeHtml(item.filteredReply || '')}</pre>
          </details>
        </div>`;
    })
    .join('');
}

/* ── Apply / collect ────────────────────────────────────────────────────── */

function applyConfigToFields(cfg) {
  cfgCache = cfg || {};

  const setVal = (id, value) => {
    const el = $(id);
    if (el) el.value = value;
  };

  setVal('bme-planner-enabled', String(toBool(cfgCache.enabled, false)));
  setVal('bme-planner-skip-plot', String(toBool(cfgCache.skipIfPlotPresent, true)));

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
    toBool(cfgCache.enabled, false) ? t('planner.status.enabled') : t('planner.status.disabled'),
    toBool(cfgCache.enabled, false) ? 'active' : 'idle',
  );
  syncPlannerLlmPresetSelect();
  const llmSelectState = resolvePlannerLlmSelectState(cfgCache);
  if (llmSelectState.missingPresetName) {
    setLocalStatus('bme-planner-api-status', t('planner.llmPreset.missingPresetFallback', { name: llmSelectState.missingPresetName }), 'error');
  } else {
    setLocalStatus('bme-planner-api-status', '', '');
  }
}

function collectPatch() {
  const getVal = (id) => $(id)?.value ?? '';
  const selectedPlannerPreset = String(getVal('bme-planner-llm-preset-select') || '').trim();

  return {
    enabled: toBool(getVal('bme-planner-enabled'), false),
    skipIfPlotPresent: toBool(getVal('bme-planner-skip-plot'), true),
    api: { llmPreset: selectedPlannerPreset },
    includeGlobalWorldbooks: toBool(getVal('bme-planner-include-global-wb'), false),
    excludeWorldbookPosition4: toBool(getVal('bme-planner-wb-pos4'), true),
    worldbookExcludeNames: csvToArr(getVal('bme-planner-wb-exclude-names')),
    plotCount: Math.max(0, Math.floor(toNum(getVal('bme-planner-plot-n'), 2))),
    responseKeepTags: normalizeKeepTagsInput(getVal('bme-planner-keep-tags')),
    chatExcludeTags: csvToArr(getVal('bme-planner-exclude-tags')),
    logsPersist: toBool(getVal('bme-planner-logs-persist'), true),
    logsMax: Math.max(1, Math.min(200, Math.floor(toNum(getVal('bme-planner-logs-max'), 20)))),
  };
}

function resetPlannerSaveStatusIfReady() {
  if (autosaveInProgress) return;
  setStatusChip('bme-planner-save-chip', t('planner.status.ready'), 'idle');
}

/* ── Save flow ──────────────────────────────────────────────────────────── */

function scheduleSave() {
  pendingSavePatch = collectPatch();
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(doSave, AUTOSAVE_DELAY_MS);
}

function flushSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  pendingSavePatch = collectPatch();
  void doSave();
}

async function doSave() {
  if (autosaveInProgress) return;
  const api = getPlannerApi();
  if (!api?.patchConfig) {
    setStatusChip('bme-planner-save-chip', t('planner.status.apiNotReady'), 'error');
    return;
  }
  autosaveInProgress = true;
  setStatusChip('bme-planner-save-chip', t('planner.status.saving'), 'loading');
  try {
    const patch = pendingSavePatch || collectPatch();
    const res = await api.patchConfig(patch);
    if (res?.ok) {
      pendingSavePatch = null;
      setStatusChip('bme-planner-save-chip', t('planner.status.saved'), 'success');
      setTimeout(() => {
        if ($('bme-planner-save-chip')?.dataset?.tone === 'success') {
          setStatusChip('bme-planner-save-chip', t('planner.status.ready'), 'idle');
        }
      }, 2000);
    } else {
      setStatusChip('bme-planner-save-chip', res?.error || t('planner.status.saveFailed'), 'error');
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

  /* Basic settings */
  $('bme-planner-enabled')?.addEventListener('change', () => {
    setStatusChip(
      'bme-planner-state-chip',
       toBool($('bme-planner-enabled').value, false) ? t('planner.status.enabled') : t('planner.status.disabled'),
      toBool($('bme-planner-enabled').value, false) ? 'active' : 'idle',
    );
    flushSave();
  });

  $('bme-planner-skip-plot')?.addEventListener('change', () => {
    flushSave();
  });

  $('bme-planner-run-test')?.addEventListener('click', async () => {
    const api = getPlannerApi();
    const textEl = $('bme-planner-test-input');
    const text = (textEl?.value || '').trim();
    setLocalStatus('bme-planner-test-status', t('planner.status.testing'), 'loading');
    const res = await api?.runTest?.(text);
    if (res?.ok) setLocalStatus('bme-planner-test-status', t('planner.status.testComplete'), 'success');
    else setLocalStatus('bme-planner-test-status', res?.error || t('planner.status.testFailed'), 'error');
  });

  $('bme-planner-llm-preset-select')?.addEventListener('change', () => {
    const select = $('bme-planner-llm-preset-select');
    const selectedName = String(select?.value || '');
    cfgCache = cfgCache || {};
    cfgCache.api = cfgCache.api && typeof cfgCache.api === 'object' ? cfgCache.api : {};
    const { presets } = getSharedLlmPresetState();
    if (selectedName && !presets?.[selectedName]) {
      cfgCache.api.llmPreset = '';
      syncPlannerLlmPresetSelect();
      setLocalStatus('bme-planner-api-status', t('planner.llmPreset.presetNotFound'), 'error');
      scheduleSave();
      return;
    }
    cfgCache.api.llmPreset = selectedName;
    syncPlannerLlmPresetSelect();
    setLocalStatus(
      'bme-planner-api-status',
      selectedName
        ? t('planner.llmPreset.switchedToPreset', { name: selectedName })
        : t('planner.llmPreset.switchedToGlobal'),
      'success',
    );
    scheduleSave();
  });

  $('bme-planner-open-task-presets')?.addEventListener('click', () => {
    const opened = openPlannerTaskPresetWorkspace();
    if (!opened) {
      setLocalStatus('bme-planner-api-status', t('planner.taskPreset.workspaceNotFound'), 'error');
      return;
    }
    setLocalStatus('bme-planner-api-status', t('planner.taskPreset.workspaceSwitched'), 'success');
  });

  $('bme-planner-keep-tags')?.addEventListener('change', onKeepTagsBlur);

  /* Debug tools */
  $('bme-planner-debug-wb')?.addEventListener('click', async () => {
    const api = getPlannerApi();
    const out = $('bme-planner-debug-output');
    if (out) {
      setHidden(out, false);
      out.textContent = t('planner.debug.diagnosing');
    }
    if (!api?.debugWorldbook) {
      if (out) out.textContent = formatPlannerDebugFailure({ output: t('planner.status.moduleNotLoaded') });
      return;
    }
    const res = await api.debugWorldbook();
    if (out) out.textContent = res?.ok === false ? formatPlannerDebugFailure(res) : (res?.output ?? t('planner.debug.failed'));
  });

  $('bme-planner-debug-char')?.addEventListener('click', async () => {
    const api = getPlannerApi();
    const out = $('bme-planner-debug-output');
    if (out) {
      setHidden(out, false);
      out.textContent = t('planner.debug.diagnosing');
    }
    if (!api?.debugChar) {
      if (out) out.textContent = formatPlannerDebugFailure({ output: t('planner.status.moduleNotLoaded') });
      return;
    }
    const res = await api.debugChar();
    if (out) out.textContent = res?.ok === false ? formatPlannerDebugFailure(res) : (res?.output ?? t('planner.debug.failed'));
  });

  /* Logs */
  $('bme-planner-logs-refresh')?.addEventListener('click', () => {
    const api = getPlannerApi();
    if (!api?.getLogs) return;
    logsCache = api.getLogs();
    renderLogs();
  });

  $('bme-planner-logs-clear')?.addEventListener('click', async () => {
    const api = getPlannerApi();
    if (!confirm(t('planner.log.confirmClear'))) return;
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

  /* Generic field auto-save for planner configuration controls. */
  fieldChangeHandler = (ev) => {
    const target = ev.target;
    if (!target) return;
    if (target.id === 'bme-planner-test-input') return;
    if (target.id === 'bme-planner-llm-preset-select') return;
    if (target.id === 'bme-planner-enabled') return;
    if (target.id === 'bme-planner-skip-plot') return;
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
  if (typeof options.getPlannerApi === 'function') {
    externalGetPlannerApi = options.getPlannerApi;
  }
  bindOnce(section);

  const api = getPlannerApi();
  if (!api) {
    applyConfigToFields({ enabled: false });
    setStatusChip('bme-planner-state-chip', t('planner.status.moduleNotLoaded'), 'error');
    setStatusChip('bme-planner-save-chip', t('planner.status.unavailable'), 'error');
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
  resetPlannerSaveStatusIfReady();

  if (typeof api.getLogs === 'function') {
    logsCache = api.getLogs() || [];
    renderLogs();
  }
}

export function refreshPlannerSections(options = {}) {
  initPlannerSections(document, options);
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
  pendingSavePatch = null;
  externalGetSettings = null;
  externalGetPlannerApi = null;
}
