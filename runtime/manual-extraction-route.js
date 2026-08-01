import { isAgentMemoryRuntimeMode } from "./memory-runtime-mode.js";

export async function runManualExtractionByMode({
  mode = "workflow",
  options = {},
  runAgent,
  runWorkflow,
} = {}) {
  if (!isAgentMemoryRuntimeMode(mode)) {
    if (typeof runWorkflow !== "function") {
      throw new TypeError("Workflow manual extraction runner is unavailable");
    }
    return await runWorkflow(options);
  }
  if (typeof runAgent !== "function") {
    throw new TypeError("Agent manual extraction runner is unavailable");
  }
  return await runAgent({
    ...options,
    manual: true,
    drainAll: options?.drainAll !== false,
    triggerSource: String(options?.triggerSource || "manual-extract"),
  });
}

export function resolveAgentExtractionTargetEndFloor({
  lockedEndFloor = null,
  drainAll = false,
  assistantTurns = [],
} = {}) {
  if (lockedEndFloor !== null && lockedEndFloor !== "" && Number.isFinite(Number(lockedEndFloor))) {
    return Math.floor(Number(lockedEndFloor));
  }
  if (drainAll !== true || !Array.isArray(assistantTurns)) return null;
  const latest = assistantTurns.at(-1);
  return Number.isFinite(Number(latest)) ? Math.floor(Number(latest)) : null;
}

export function shouldContinueAgentExtractionDrain({
  drainAll = false,
  result = null,
  beforeFloor = -1,
  afterFloor = -1,
  targetEndFloor = null,
} = {}) {
  return drainAll === true &&
    result?.success === true &&
    result?.skipped !== true &&
    targetEndFloor !== null && targetEndFloor !== "" &&
    Number.isFinite(Number(targetEndFloor)) &&
    Number(afterFloor) > Number(beforeFloor) &&
    Number(afterFloor) < Number(targetEndFloor);
}

export function mergeAgentExtractionWorkerRequest(worker, options = {}, targetEndFloor = null) {
  if (!worker || typeof worker !== "object") return worker;
  if (targetEndFloor !== null && targetEndFloor !== "" && Number.isFinite(Number(targetEndFloor)) &&
    (worker.targetEndFloor == null || Number(targetEndFloor) > worker.targetEndFloor)) {
    worker.targetEndFloor = Math.floor(Number(targetEndFloor));
    worker.rerun = true;
  }
  if (options?.drainAll === true) worker.drainAll = true;
  if (options?.manual === true) worker.manual = true;
  if (options?.skipHistoryRecovery === true) worker.skipHistoryRecovery = true;
  if (String(options?.triggerSource || "").trim()) {
    worker.triggerSource = String(options.triggerSource).trim();
  }
  return worker;
}
