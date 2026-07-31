import { DEFAULT_BME_AGENT_GUARD } from "../domain/memory-contract.js";

export const DEFAULT_BME_AGENT_CONTEXT_WINDOW_TOKENS = 128000;
export const DEFAULT_BME_AGENT_COMPLETION_RESERVE_TOKENS = 8192;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : fallback;
}

export function normalizeBmeAgentRuntimeSettings(settings = {}) {
  const contextWindowTokens = positiveInteger(
    settings.contextWindowTokens ?? settings.agentContextWindowTokens,
    DEFAULT_BME_AGENT_CONTEXT_WINDOW_TOKENS,
  );
  const requestedReserve = positiveInteger(
    settings.completionReserveTokens ?? settings.agentCompletionReserveTokens,
    DEFAULT_BME_AGENT_COMPLETION_RESERVE_TOKENS,
  );
  const completionReserveTokens =
    requestedReserve < contextWindowTokens
      ? requestedReserve
      : Math.max(1, Math.floor(contextWindowTokens / 8));

  return Object.freeze({
    contextWindowTokens,
    completionReserveTokens,
    maxToolCalls: positiveInteger(
      settings.maxToolCalls ?? settings.agentMaxToolCalls,
      DEFAULT_BME_AGENT_GUARD.maxToolCalls,
    ),
    maxRunMs: positiveInteger(
      settings.maxRunMs ?? settings.agentMaxRunMs,
      DEFAULT_BME_AGENT_GUARD.maxRunMs,
    ),
  });
}
