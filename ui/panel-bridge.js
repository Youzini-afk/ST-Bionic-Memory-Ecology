import { debugLog } from "../runtime/debug-logging.js";
import { setLocale, t } from "../i18n/index.js";

const MENU_ENTRY_RETRY_MS = 400;
const MENU_ENTRY_MAX_ATTEMPTS = 30;
const OPTIONS_MENU_ENTRY_ID = "option_st_bme_panel";
const EXTENSIONS_MENU_ENTRY_ID = "st_bme_extensions_menu_entry";

function resolvePanelTheme(settings) {
  return settings?.panelTheme || "crimson";
}

function syncBridgeLocale(runtime) {
  setLocale(runtime.getSettings?.()?.uiLocale || "auto");
}

export function createNoticePanelActionController(runtime) {
  syncBridgeLocale(runtime);
  if (!runtime.getPanelModule()?.openPanel) return undefined;
  return {
    label: t("panel.entry.openPanelAction"),
    kind: "neutral",
    onClick: () => {
      runtime.getPanelModule()?.openPanel?.();
    },
  };
}

export function refreshPanelLiveStateController(runtime) {
  runtime.getPanelModule()?.refreshLiveState?.();
}

export function openPanelController(runtime) {
  runtime.getPanelModule()?.openPanel?.();
}

function bindOpenPanelClick(runtime, element) {
  element.addEventListener("click", async () => {
    try {
      await ensurePanelBridgeReady(runtime);
      openPanelController(runtime);
      runtime.$?.("#options")?.hide?.();
      runtime.$?.("#extensionsMenu")?.hide?.();
    } catch (error) {
      runtime.console.error("[ST-BME] 点击菜单打开面板失败:", error);
      globalThis.toastr?.error?.(t("panel.entry.openFailed"), "ST-BME");
    }
  });
}

function renderOptionsMenuEntry(menuItem) {
  menuItem.innerHTML =
    `<i class="fa-lg fa-solid fa-brain"></i><span>${t("panel.entry.menuLabel")}</span>`;
}

function renderExtensionsMenuEntry(menuItem) {
  menuItem.innerHTML =
    `<div class="fa-solid fa-brain extensionsMenuExtensionButton"></div><span>${t("panel.entry.menuLabel")}</span>`;
}

function renderFloatingBootstrap(fab) {
  fab.innerHTML = `
    <i class="fa-solid fa-brain bme-fab-icon"></i>
    <span class="bme-fab-tooltip">${t("panel.entry.floatingTooltip")}</span>
  `;
}

function injectOptionsMenuEntry(runtime) {
  syncBridgeLocale(runtime);
  const doc = runtime.document;
  if (!doc || doc.getElementById(OPTIONS_MENU_ENTRY_ID)) {
    const existing = doc?.getElementById(OPTIONS_MENU_ENTRY_ID);
    if (existing) renderOptionsMenuEntry(existing);
    return true;
  }
  const menuItem = doc.createElement("a");
  menuItem.id = OPTIONS_MENU_ENTRY_ID;
  renderOptionsMenuEntry(menuItem);
  bindOpenPanelClick(runtime, menuItem);

  const anchor = doc.getElementById("option_toggle_logprobs");
  const optionsContent = doc.querySelector("#options .options-content");

  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(menuItem, anchor.nextSibling);
    return true;
  }
  if (optionsContent) {
    optionsContent.appendChild(menuItem);
    return true;
  }
  return false;
}

function injectExtensionsMenuEntry(runtime) {
  syncBridgeLocale(runtime);
  const doc = runtime.document;
  if (!doc) return false;

  const existing = doc.getElementById(EXTENSIONS_MENU_ENTRY_ID);
  const menu = doc.getElementById("extensionsMenu");
  const button = doc.getElementById("extensionsMenuButton");
  if (existing) {
    renderExtensionsMenuEntry(existing);
    if (button?.style) button.style.display = "flex";
    runtime.$?.("#extensionsMenuButton")?.css?.("display", "flex");
    return true;
  }
  if (!menu) return false;

  const menuItem = doc.createElement("div");
  menuItem.id = EXTENSIONS_MENU_ENTRY_ID;
  menuItem.className = "list-group-item flex-container flexGap5";
  renderExtensionsMenuEntry(menuItem);
  bindOpenPanelClick(runtime, menuItem);
  menu.appendChild(menuItem);

  // SillyTavern shows the magic-wand button only while #extensionsMenu has
  // visible children. Its polling can stop before late third-party entries are
  // injected, so make the button visible after adding BME's entry.
  if (button?.style) button.style.display = "flex";
  runtime.$?.("#extensionsMenuButton")?.css?.("display", "flex");
  return true;
}

function injectFloatingBootstrap(runtime) {
  syncBridgeLocale(runtime);
  const doc = runtime.document;
  if (!doc) return false;
  let fab = doc.getElementById("bme-floating-ball");
  if (!fab) {
    fab = doc.createElement("div");
    fab.id = "bme-floating-ball";
    fab.setAttribute("data-status", "idle");
    fab.setAttribute("data-bme-bootstrap", "true");
    renderFloatingBootstrap(fab);
    const mountTarget = doc.body || doc.documentElement;
    if (!mountTarget) return false;
    mountTarget.appendChild(fab);
  } else if (!fab.querySelector?.(".bme-fab-icon")) {
    renderFloatingBootstrap(fab);
  } else {
    const tip = fab.querySelector?.(".bme-fab-tooltip");
    if (tip) tip.textContent = t("panel.entry.floatingTooltip");
  }
  if (fab.dataset.bmeBridgeBound === "true") {
    return true;
  }
  fab.dataset.bmeBridgeBound = "true";
  fab.addEventListener("click", async () => {
    try {
      await ensurePanelBridgeReady(runtime);
      openPanelController(runtime);
    } catch (error) {
      runtime.console.error("[ST-BME] 点击悬浮球打开面板失败:", error);
      globalThis.toastr?.error?.(t("panel.entry.openFailed"), "ST-BME");
    }
  });
  return true;
}

function scheduleOptionsMenuInjection(runtime, attempt = 0) {
  try {
    injectFloatingBootstrap(runtime);
  } catch (error) {
    runtime.console.warn("[ST-BME] 悬浮球入口预注入失败:", error);
  }

  try {
    const optionsReady = injectOptionsMenuEntry(runtime);
    const extensionsReady = injectExtensionsMenuEntry(runtime);
    if (optionsReady && extensionsReady) {
      return;
    }
  } catch (error) {
    runtime.console.warn("[ST-BME] 菜单入口注入失败，稍后重试:", error);
  }

  if (attempt >= MENU_ENTRY_MAX_ATTEMPTS) {
    runtime.console.warn(
      "[ST-BME] 操控面板菜单入口注入失败：宿主菜单 DOM 长时间未就绪",
    );
    return;
  }

  globalThis.setTimeout(() => {
    scheduleOptionsMenuInjection(runtime, attempt + 1);
  }, MENU_ENTRY_RETRY_MS);
}

async function ensurePanelBridgeReady(runtime) {
  const hasPanelDom = Boolean(
    runtime.document.getElementById("st-bme-panel-overlay") &&
      runtime.document.getElementById("st-bme-panel"),
  );
  if (runtime.getPanelModule()?.openPanel && hasPanelDom) {
    return runtime.getPanelModule();
  }

  const panelModule = await runtime.importPanelModule();
  const themesModule = await runtime.importThemesModule();
  runtime.setPanelModule(panelModule);
  runtime.setThemesModule(themesModule);

  const settings = runtime.getSettings();
  const theme = resolvePanelTheme(settings);
  themesModule.applyTheme(theme);

  await panelModule.initPanel({
    getGraph: runtime.getGraph,
    getSettings: runtime.getSettings,
    getLastExtract: runtime.getLastExtract,
    getLastRecall: runtime.getLastRecall,
    getRuntimeStatus: runtime.getRuntimeStatus,
    getLastExtractionStatus: runtime.getLastExtractionStatus,
    getLastVectorStatus: runtime.getLastVectorStatus,
    getLastRecallStatus: runtime.getLastRecallStatus,
    getLastBatchStatus: runtime.getLastBatchStatus,
    getLastInjection: runtime.getLastInjection,
    getRuntimeDebugSnapshot: runtime.getRuntimeDebugSnapshot,
    getGraphPersistenceState: runtime.getGraphPersistenceState,
    getHideStateSnapshot: runtime.getHideStateSnapshot,
    updateSettings: (patch) => {
      const nextSettings = runtime.updateSettings(patch);
      if (Object.prototype.hasOwnProperty.call(patch || {}, "panelTheme")) {
        const nextTheme = resolvePanelTheme(nextSettings);
        runtime.getThemesModule()?.applyTheme?.(nextTheme);
        runtime.getPanelModule()?.updatePanelTheme?.(nextTheme);
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "uiLocale")) {
        syncBridgeLocale(runtime);
        injectOptionsMenuEntry(runtime);
        injectExtensionsMenuEntry(runtime);
        injectFloatingBootstrap(runtime);
        runtime.getPanelModule()?.updatePanelLocale?.(nextSettings.uiLocale || "auto");
      }
      return nextSettings;
    },
    actions: runtime.actions,
  });

  return panelModule;
}

export async function initializePanelBridgeController(runtime) {
  try {
    scheduleOptionsMenuInjection(runtime);
    await ensurePanelBridgeReady(runtime);
    debugLog("[ST-BME] 操控面板初始化完成");
  } catch (panelError) {
    runtime.console.error(
      "[ST-BME] 操控面板加载失败（核心功能不受影响）:",
      panelError,
    );
    globalThis.toastr?.error?.(t("panel.entry.preloadFailed"), "ST-BME");
  }
}
