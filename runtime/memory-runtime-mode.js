export const MEMORY_RUNTIME_MODE = Object.freeze({
  WORKFLOW: "workflow",
  AGENT: "agent",
});

export function normalizeMemoryRuntimeMode(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === MEMORY_RUNTIME_MODE.AGENT
    ? MEMORY_RUNTIME_MODE.AGENT
    : MEMORY_RUNTIME_MODE.WORKFLOW;
}

export function isAgentMemoryRuntimeMode(value) {
  return normalizeMemoryRuntimeMode(value) === MEMORY_RUNTIME_MODE.AGENT;
}
