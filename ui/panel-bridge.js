import { debugLog } from "../runtime/debug-logging.js";

const MENU_ENTRY_RETRY_MS = 400;
const MENU_ENTRY_MAX_ATTEMPTS = 30;

function resolvePanelTheme(settings) {
  return settings?.panelTheme || "crimson";
}

export function createNoticePanelActionController(runtime) {
  if (!runtime.getPanelModule()?.openPanel) return undefined;
  return {
    label: "打开面板",
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

function injectOptionsMenuEntry(runtime) {
  const doc = runtime.document;
  if (!doc || doc.getElementById("option_st_bme_panel")) {
    return true;
  }
  const menuItem = doc.createElement("a");
  menuItem.id = "option_st_bme_panel";
  menuItem.innerHTML =
    '<i class="fa-lg fa-solid fa-brain"></i><span>记忆图谱</span>';
  menuItem.addEventListener("click", async () => {
    try {
      await ensurePanelBridgeReady(runtime);
      openPanelController(runtime);
      runtime.$?.("#options")?.hide?.();
    } catch (error) {
      runtime.console.error("[ST-BME] 点击菜单打开面板失败:", error);
      globalThis.toastr?.error?.("记忆图谱面板加载失败，请查看控制台报错", "ST-BME");
    }
  });

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

function injectFloatingBootstrap(runtime) {
  const doc = runtime.document;
  if (!doc) return false;
  let fab = doc.getElementById("bme-floating-ball");
  if (!fab) {
    fab = doc.createElement("div");
    fab.id = "bme-floating-ball";
    fab.setAttribute("data-status", "idle");
    fab.setAttribute("data-bme-bootstrap", "true");
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME 记忆图谱</span>
    `;
    const mountTarget = doc.body || doc.documentElement;
    if (!mountTarget) return false;
    mountTarget.appendChild(fab);
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
      globalThis.toastr?.error?.("记忆图谱面板加载失败，请查看控制台报错", "ST-BME");
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
    if (injectOptionsMenuEntry(runtime)) {
      return;
    }
  } catch (error) {
    runtime.console.warn("[ST-BME] 菜单入口注入失败，稍后重试:", error);
  }

  if (attempt >= MENU_ENTRY_MAX_ATTEMPTS) {
    runtime.console.warn(
      "[ST-BME] 操控面板菜单入口注入失败：宿主 options DOM 长时间未就绪",
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
    updateSettings: (patch) => {
      const nextSettings = runtime.updateSettings(patch);
      if (Object.prototype.hasOwnProperty.call(patch || {}, "panelTheme")) {
        const nextTheme = resolvePanelTheme(nextSettings);
        runtime.getThemesModule()?.applyTheme?.(nextTheme);
        runtime.getPanelModule()?.updatePanelTheme?.(nextTheme);
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
    globalThis.toastr?.error?.("记忆图谱面板预加载失败，可稍后重试点击菜单", "ST-BME");
  }
}
