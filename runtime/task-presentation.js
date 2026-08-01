export const MEMORY_TASK_PRESENTATION_MODE = Object.freeze({
  FOREGROUND: "foreground",
  AGENT_BACKGROUND: "agent-background",
});

export function normalizeMemoryTaskPresentation(value = null) {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { mode: value };
  const mode =
    String(source.mode || "").trim() ===
    MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND
      ? MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND
      : MEMORY_TASK_PRESENTATION_MODE.FOREGROUND;
  return {
    mode,
    runId: String(source.runId || "").trim(),
    observer: source.observer || null,
  };
}

export function createAgentBackgroundPresentation({ runId = "", observer = null } = {}) {
  return Object.freeze({
    mode: MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND,
    runId: String(runId || "").trim(),
    observer,
  });
}

function reportStage(presentation, stage, text, meta, level) {
  if (!presentation.runId) return;
  try {
    presentation.observer?.recordStageStatus?.({
      runId: presentation.runId,
      stage,
      text: String(text || ""),
      meta: String(meta || ""),
      level: String(level || "info"),
    });
  } catch {
    // Presentation must never affect memory execution.
  }
}

function withBackgroundOptions(options = {}) {
  return {
    ...(options && typeof options === "object" ? options : {}),
    presentationMode: MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND,
  };
}

function silentToastr() {
  const ignore = () => undefined;
  return Object.freeze({
    info: ignore,
    success: ignore,
    warning: ignore,
    error: ignore,
    clear: ignore,
    remove: ignore,
  });
}

export function createMemoryTaskPresentationBindings({
  presentation = null,
  setLastExtractionStatus = null,
  setLastVectorStatus = null,
  setLastRecallStatus = null,
  notifyExtractionIssue = null,
  toastr = null,
} = {}) {
  const normalized = normalizeMemoryTaskPresentation(presentation);
  if (normalized.mode !== MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND) {
    return {
      presentation: normalized,
      setLastExtractionStatus,
      setLastVectorStatus,
      setLastRecallStatus,
      notifyExtractionIssue,
      toastr,
    };
  }
  const wrapStatus = (stage, target) => (text, meta, level = "info", options = {}) => {
    reportStage(normalized, stage, text, meta, level);
    return target?.(text, meta, level, withBackgroundOptions(options));
  };
  const backgroundExtractionStatus = wrapStatus(
    "extraction",
    setLastExtractionStatus,
  );
  return {
    presentation: normalized,
    setLastExtractionStatus: backgroundExtractionStatus,
    setLastVectorStatus: wrapStatus("vector", setLastVectorStatus),
    setLastRecallStatus: wrapStatus("recall", setLastRecallStatus),
    notifyExtractionIssue: (message) =>
      backgroundExtractionStatus(
        String(message || "Agent memory task issue"),
        "",
        "error",
        { syncRuntime: false },
      ),
    toastr: silentToastr(),
  };
}
