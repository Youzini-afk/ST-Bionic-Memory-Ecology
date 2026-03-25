// ST-BME: 任务级生成参数过滤层（Phase 1）

import { getActiveTaskProfile } from "./prompt-profiles.js";

const SUPPORTED_FIELDS = [
  "max_context_tokens",
  "max_completion_tokens",
  "reply_count",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "top_a",
  "min_p",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "squash_system_messages",
  "reasoning_effort",
  "request_thoughts",
  "enable_function_calling",
  "enable_web_search",
  "character_name_prefix",
  "wrap_user_messages_in_quotes",
];

const CONSERVATIVE_ALLOWLIST = new Set([
  "temperature",
  "top_p",
  "seed",
  "max_completion_tokens",
  "stream",
  "frequency_penalty",
  "presence_penalty",
]);

const OPENAI_COMPAT_ALLOWLIST = new Set([
  "max_completion_tokens",
  "stream",
  "temperature",
  "top_p",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "reasoning_effort",
  "request_thoughts",
  "enable_function_calling",
  "enable_web_search",
  "wrap_user_messages_in_quotes",
]);

const BOOLEAN_FIELDS = new Set([
  "stream",
  "squash_system_messages",
  "request_thoughts",
  "enable_function_calling",
  "enable_web_search",
  "wrap_user_messages_in_quotes",
]);

const INTEGER_FIELDS = new Set([
  "max_context_tokens",
  "max_completion_tokens",
  "reply_count",
  "top_k",
  "seed",
]);

const FLOAT_FIELDS = new Set([
  "temperature",
  "top_p",
  "top_a",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
]);

const REASONING_EFFORT_VALUES = new Set(["low", "medium", "high", "minimal"]);

function resolveCapabilityMode(context = {}) {
  const normalizedMode = String(context.mode || "").trim().toLowerCase();
  if (normalizedMode === "dedicated-openai-compatible") {
    return "openai-compatible";
  }

  const normalizedSource = String(context.source || "").trim().toLowerCase();
  if (
    normalizedSource &&
    ["openai", "openrouter", "mistral", "cohere", "custom", "vllm"].includes(
      normalizedSource,
    )
  ) {
    return "openai-compatible";
  }

  return "conservative";
}

function getAllowlistForCapability(capabilityMode) {
  if (capabilityMode === "openai-compatible") {
    return OPENAI_COMPAT_ALLOWLIST;
  }
  return CONSERVATIVE_ALLOWLIST;
}

function normalizeByField(field, rawValue) {
  if (rawValue == null || rawValue === "") {
    return { ok: false, reason: "empty_value" };
  }

  if (BOOLEAN_FIELDS.has(field)) {
    return { ok: true, value: Boolean(rawValue) };
  }

  if (INTEGER_FIELDS.has(field)) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) {
      return { ok: false, reason: "invalid_number" };
    }
    if (parsed < 0) {
      return { ok: false, reason: "invalid_range" };
    }
    if (field === "reply_count" && parsed < 1) {
      return { ok: false, reason: "invalid_range" };
    }
    return { ok: true, value: parsed };
  }

  if (FLOAT_FIELDS.has(field)) {
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) {
      return { ok: false, reason: "invalid_number" };
    }

    if (field === "temperature" && (parsed < 0 || parsed > 2)) {
      return { ok: false, reason: "invalid_range" };
    }
    if (
      ["top_p", "top_a", "min_p"].includes(field) &&
      (parsed < 0 || parsed > 1)
    ) {
      return { ok: false, reason: "invalid_range" };
    }
    if (
      ["frequency_penalty", "presence_penalty", "repetition_penalty"].includes(
        field,
      ) &&
      (parsed < -2 || parsed > 2)
    ) {
      return { ok: false, reason: "invalid_range" };
    }

    return { ok: true, value: parsed };
  }

  if (field === "reasoning_effort") {
    const normalized = String(rawValue || "")
      .trim()
      .toLowerCase();
    if (!normalized) {
      return { ok: false, reason: "empty_value" };
    }
    if (!REASONING_EFFORT_VALUES.has(normalized)) {
      return { ok: false, reason: "invalid_value" };
    }
    return { ok: true, value: normalized };
  }

  if (field === "character_name_prefix") {
    return { ok: true, value: String(rawValue || "").trim() };
  }

  return { ok: true, value: rawValue };
}

export function resolveTaskGenerationOptions(
  settings = {},
  taskType,
  fallback = {},
  capabilityContext = {},
) {
  const profile = getActiveTaskProfile(settings, taskType);
  const generation = { ...(profile?.generation || {}) };
  const filtered = {};
  const removed = [];
  const capabilityMode = resolveCapabilityMode(capabilityContext);
  const allowlist = getAllowlistForCapability(capabilityMode);

  for (const field of SUPPORTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(generation, field)) continue;
    const rawValue = generation[field];
    if (rawValue == null || rawValue === "") continue;

    if (!allowlist.has(field)) {
      removed.push({ field, reason: "capability_filtered", capabilityMode });
      continue;
    }

    const normalized = normalizeByField(field, rawValue);
    if (!normalized.ok) {
      removed.push({ field, reason: normalized.reason, capabilityMode });
      continue;
    }

    filtered[field] = normalized.value;
  }

  if (!Number.isFinite(filtered.max_completion_tokens)) {
    const fallbackTokens = Number.parseInt(fallback.max_completion_tokens, 10);
    if (Number.isFinite(fallbackTokens) && fallbackTokens > 0) {
      filtered.max_completion_tokens = fallbackTokens;
    }
  }

  return {
    profile,
    generation,
    filtered,
    removed,
    capabilityMode,
  };
}
