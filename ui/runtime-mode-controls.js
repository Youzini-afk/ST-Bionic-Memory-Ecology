import {
  getMaintenanceExecutionModeLevel,
  normalizeMaintenanceExecutionMode,
} from "../runtime/concurrency.js";
import {
  MEMORY_RUNTIME_MODE,
  normalizeMemoryRuntimeMode,
} from "../runtime/memory-runtime-mode.js";

const AGENT_NUMBER_CONTROLS = Object.freeze([
  Object.freeze({
    id: "bme-setting-agent-context-window",
    settingKey: "agentContextWindowTokens",
    fallback: 128000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  }),
  Object.freeze({
    id: "bme-setting-agent-max-tool-calls",
    settingKey: "agentMaxToolCalls",
    fallback: 500,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  }),
  Object.freeze({
    id: "bme-setting-agent-max-run-minutes",
    settingKey: "agentMaxRunMs",
    fallback: 8,
    min: 1,
    max: Math.floor(Number.MAX_SAFE_INTEGER / 60000),
    read: (settings) =>
      Math.max(1, Math.round(Number(settings.agentMaxRunMs ?? 480000) / 60000)),
    write: (value) => value * 60000,
  }),
]);

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (element && element.value !== String(value ?? "")) {
    element.value = String(value ?? "");
  }
}

function getMaintenanceModeMeta(modeValue = "strict") {
  const mode = normalizeMaintenanceExecutionMode(modeValue);
  switch (mode) {
    case "balanced":
      return {
        mode,
        title: "2 均衡加速",
        desc: "2 均衡加速：提取主链同步，只读查询限流并发，维护任务逐步后台化。",
      };
    case "fast":
      return {
        mode,
        title: "3 快速后台",
        desc: "3 快速后台：核心写入优先完成，其余维护后台最终一致。",
      };
    case "strict":
    default:
      return {
        mode: "strict",
        title: "1 严格串行",
        desc: "1 严格串行：全部同步执行，稳定优先。",
      };
  }
}

function refreshMaintenanceMode(settings) {
  const meta = getMaintenanceModeMeta(
    settings.maintenanceExecutionMode || "strict",
  );
  const segmented = document.getElementById(
    "bme-setting-maintenance-execution-mode",
  );
  const desc = document.getElementById("bme-maintenance-mode-desc");
  const card = document.getElementById("bme-maintenance-mode-card");
  const level = getMaintenanceExecutionModeLevel(meta.mode);
  if (desc) desc.textContent = meta.desc;
  if (segmented) segmented.dataset.mode = meta.mode;
  if (card) {
    card.dataset.mode = meta.mode;
    card.title = `${meta.title}；1 严格串行 / 2 均衡加速 / 3 快速后台（最终一致）`;
  }
  segmented?.querySelectorAll("button[data-mode]").forEach((button) => {
    const active =
      normalizeMaintenanceExecutionMode(button.dataset.mode) === meta.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = active
      ? `${level} · ${meta.title}`
      : button.getAttribute("aria-label") || "";
  });
}

function refreshMemoryMode(settings, panel, translate) {
  const mode = normalizeMemoryRuntimeMode(settings.memoryRuntimeMode);
  document
    .getElementById("bme-memory-runtime-mode")
    ?.querySelectorAll("button[data-memory-runtime-mode]")
    .forEach((button) => {
      const active =
        normalizeMemoryRuntimeMode(button.dataset.memoryRuntimeMode) === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  const hint = document.getElementById("bme-memory-runtime-mode-hint");
  if (hint) {
    const key =
      mode === MEMORY_RUNTIME_MODE.AGENT
        ? "panel.runtimeMode.agentHint"
        : "panel.runtimeMode.workflowHint";
    hint.dataset.i18n = key;
    hint.textContent = translate(key);
  }
  document
    .getElementById("bme-agent-runtime-settings")
    ?.classList.toggle("is-active-mode", mode === MEMORY_RUNTIME_MODE.AGENT);
  if (panel) panel.dataset.memoryRuntimeMode = mode;
}

function refreshAgentNumberControls(settings) {
  for (const control of AGENT_NUMBER_CONTROLS) {
    const value = control.read
      ? control.read(settings)
      : settings[control.settingKey] ?? control.fallback;
    setInputValue(control.id, value);
  }
}

export function refreshRuntimeModeControls({
  settings = {},
  panel = null,
  translate = (key) => key,
} = {}) {
  refreshMaintenanceMode(settings);
  refreshMemoryMode(settings, panel, translate);
  refreshAgentNumberControls(settings);
}

export function bindRuntimeModeControls({
  patchSettings,
  bindNumber,
  panel = null,
  translate = (key) => key,
} = {}) {
  if (typeof patchSettings !== "function" || typeof bindNumber !== "function") {
    throw new TypeError("Runtime mode controls require patchSettings and bindNumber");
  }
  const refresh = (settings) =>
    refreshRuntimeModeControls({ settings, panel, translate });
  const bindSegmented = (id, selector, buildPatch) => {
    const element = document.getElementById(id);
    if (!element || element.dataset.bmeBound === "true") return;
    element.addEventListener("click", (event) => {
      const button = event.target?.closest?.(selector);
      if (!button) return;
      refresh(patchSettings(buildPatch(button)) || {});
    });
    element.dataset.bmeBound = "true";
  };

  bindSegmented(
    "bme-memory-runtime-mode",
    "button[data-memory-runtime-mode]",
    (button) => ({
      memoryRuntimeMode: normalizeMemoryRuntimeMode(
        button.dataset.memoryRuntimeMode,
      ),
    }),
  );
  bindSegmented(
    "bme-setting-maintenance-execution-mode",
    "button[data-mode]",
    (button) => ({
      maintenanceExecutionMode: normalizeMaintenanceExecutionMode(
        button.dataset.mode,
      ),
    }),
  );
  for (const control of AGENT_NUMBER_CONTROLS) {
    bindNumber(
      control.id,
      control.fallback,
      control.min,
      control.max,
      (value) =>
        patchSettings({
          [control.settingKey]: control.write ? control.write(value) : value,
        }),
    );
  }
}
