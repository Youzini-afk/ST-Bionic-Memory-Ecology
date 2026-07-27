export function readGlobalHostContext() {
  const candidates = [
    globalThis.SillyTavern?.getContext?.(),
    globalThis.getContext?.(),
    globalThis.__stBmeTestContext,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object") || null;
}

export function getHostCurrentChatId(context = null) {
  return String(
    context?.getCurrentChatId?.() ||
      globalThis.SillyTavern?.getCurrentChatId?.() ||
      globalThis.getCurrentChatId?.() ||
      "",
  ).trim();
}

export function getEventMakeFirst() {
  return globalThis.eventMakeFirst;
}

export function getHostDocument() {
  return globalThis.document || null;
}

export function getHostWindow() {
  return globalThis.window || null;
}

export function getHostMutationObserver() {
  return globalThis.MutationObserver;
}

export function hasHostEjsTemplate() {
  return Boolean(getHostWindow()?.EjsTemplate || globalThis.EjsTemplate);
}

export function getHostGlobalFunction(name) {
  const fn = globalThis[String(name || "")];
  return typeof fn === "function" ? fn : null;
}

export function readSendTextareaValue() {
  return String(getHostDocument()?.getElementById?.("send_textarea")?.value ?? "");
}

export function resolveHostSlashCommandExecutor() {
  const executor =
    globalThis.executeSlashCommands || globalThis.executeSlashCommandsOnChatInput;
  return typeof executor === "function" ? executor.bind(globalThis) : null;
}

export function readHostMvuExtraAnalysisFlag() {
  const hostWindow = getHostWindow();
  try {
    if (typeof hostWindow?.Mvu?.isDuringExtraAnalysis === "function") {
      return Boolean(hostWindow.Mvu.isDuringExtraAnalysis());
    }
  } catch {}

  try {
    if (typeof hostWindow?.parent?.Mvu?.isDuringExtraAnalysis === "function") {
      return Boolean(hostWindow.parent.Mvu.isDuringExtraAnalysis());
    }
  } catch {}

  try {
    const getActivePinia = hostWindow?.getActivePinia ?? hostWindow?.parent?.getActivePinia;
    if (typeof getActivePinia === "function") {
      const pinia = getActivePinia();
      return Boolean(
        pinia?.state?.value?.["MVU变量框架"]?.runtimes?.is_during_extra_analysis,
      );
    }
  } catch {}

  return false;
}
