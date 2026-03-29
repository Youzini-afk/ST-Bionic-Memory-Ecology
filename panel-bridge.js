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
  if (runtime.document.getElementById("option_st_bme_panel")) {
    return;
  }

  const $menuItem = runtime.$(`
    <a id="option_st_bme_panel">
      <i class="fa-lg fa-solid fa-brain"></i>
      <span>记忆图谱</span>
    </a>
  `).on("click", () => {
    openPanelController(runtime);
    runtime.$("#options").hide();
  });

  const $optionsContent = runtime.$("#options .options-content");
  const $anchor = runtime.$("#option_toggle_logprobs");

  if ($anchor.length > 0) {
    $anchor.after($menuItem);
  } else if ($optionsContent.length > 0) {
    $optionsContent.append($menuItem);
  }
}

export async function initializePanelBridgeController(runtime) {
  try {
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

    injectOptionsMenuEntry(runtime);
    runtime.console.log("[ST-BME] 操控面板初始化完成");
  } catch (panelError) {
    runtime.console.error(
      "[ST-BME] 操控面板加载失败（核心功能不受影响）:",
      panelError,
    );
  }
}
