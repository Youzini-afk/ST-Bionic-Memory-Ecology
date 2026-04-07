function safeClone(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
    // ignore and fall through
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

const runtimeDebugState = {
  hostCapabilities: null,
  taskPromptBuilds: {},
  taskLlmRequests: {},
  injections: {},
  updatedAt: "",
};

function touchRuntimeDebugState() {
  runtimeDebugState.updatedAt = nowIso();
}

export function resetRuntimeDebugSnapshot() {
  runtimeDebugState.hostCapabilities = null;
  runtimeDebugState.taskPromptBuilds = {};
  runtimeDebugState.taskLlmRequests = {};
  runtimeDebugState.injections = {};
  runtimeDebugState.updatedAt = nowIso();
}

export function recordHostCapabilitySnapshot(snapshot = null) {
  runtimeDebugState.hostCapabilities = safeClone(snapshot, null);
  touchRuntimeDebugState();
}

export function recordTaskPromptBuild(taskType, snapshot = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  runtimeDebugState.taskPromptBuilds[normalizedTaskType] = {
    updatedAt: nowIso(),
    ...safeClone(snapshot, {}),
  };
  touchRuntimeDebugState();
}

export function recordTaskLlmRequest(taskType, snapshot = {}) {
  const normalizedTaskType = String(taskType || "").trim() || "unknown";
  runtimeDebugState.taskLlmRequests[normalizedTaskType] = {
    updatedAt: nowIso(),
    ...safeClone(snapshot, {}),
  };
  touchRuntimeDebugState();
}

export function recordInjectionSnapshot(kind, snapshot = {}) {
  const normalizedKind = String(kind || "").trim() || "default";
  runtimeDebugState.injections[normalizedKind] = {
    updatedAt: nowIso(),
    ...safeClone(snapshot, {}),
  };
  touchRuntimeDebugState();
}

export function getRuntimeDebugSnapshot() {
  return safeClone(
    {
      hostCapabilities: runtimeDebugState.hostCapabilities,
      taskPromptBuilds: runtimeDebugState.taskPromptBuilds,
      taskLlmRequests: runtimeDebugState.taskLlmRequests,
      injections: runtimeDebugState.injections,
      updatedAt: runtimeDebugState.updatedAt,
    },
    {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      updatedAt: "",
    },
  );
}
