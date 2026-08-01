function clone(value, fallback) {
  if (value === undefined) return fallback;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }
}

export function normalizeOpenAICompatibleToolCalls(payload = {}) {
  const message = payload?.choices?.[0]?.message || payload?.message || {};
  const source = Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : Array.isArray(payload?.tool_calls)
      ? payload.tool_calls
      : message?.function_call
        ? [{ function: message.function_call }]
        : [];
  return source.map((toolCall, index) => {
    const fn = toolCall?.function || toolCall || {};
    const rawArguments = fn.arguments ?? toolCall?.arguments ?? "{}";
    const argumentsText =
      typeof rawArguments === "string"
        ? rawArguments
        : JSON.stringify(rawArguments ?? {});
    const name = String(fn.name || toolCall?.name || "");
    return {
      id: String(toolCall?.id || `call_${index}`),
      type: "function",
      name,
      arguments: argumentsText,
      function: { name, arguments: argumentsText },
    };
  });
}

function getStreamingToolCallDeltas(payload = {}) {
  const choice = payload?.choices?.[0] || {};
  const delta = choice?.delta || choice?.message || payload?.delta || payload?.message || {};
  if (Array.isArray(delta?.tool_calls)) return delta.tool_calls;
  if (Array.isArray(payload?.tool_calls)) return payload.tool_calls;
  const legacyFunctionCall = delta?.function_call || payload?.function_call;
  return legacyFunctionCall ? [{ index: 0, function: legacyFunctionCall }] : [];
}

function normalizeStreamIndex(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

/**
 * Mutable request-local accumulator for OpenAI-compatible streamed tool calls.
 * It is deliberately transport-only: callers persist only the final assembled
 * assistant message, never one record per SSE delta.
 */
export function createOpenAICompatibleToolCallAccumulator() {
  return {
    calls: new Map(),
    idToIndex: new Map(),
  };
}

export function appendOpenAICompatibleToolCallDeltas(
  accumulator,
  payload = {},
) {
  if (!accumulator?.calls || !accumulator?.idToIndex) {
    throw new TypeError("OpenAI-compatible tool-call accumulator is required");
  }

  const source = getStreamingToolCallDeltas(payload);
  const appended = [];
  source.forEach((toolCall, sourceIndex) => {
    const incomingId = String(toolCall?.id || "");
    const explicitIndex = Number.isInteger(Number(toolCall?.index))
      ? Number(toolCall.index)
      : null;
    const knownIdIndex = incomingId && accumulator.idToIndex.has(incomingId)
      ? accumulator.idToIndex.get(incomingId)
      : null;
    const index = normalizeStreamIndex(
      explicitIndex ?? knownIdIndex,
      sourceIndex,
    );
    const current = accumulator.calls.get(index) || {
      index,
      id: "",
      type: "function",
      name: "",
      arguments: "",
    };
    if (incomingId && current.id && incomingId !== current.id) {
      throw new Error(`streamed tool-call index ${index} changed id`);
    }
    if (incomingId) {
      current.id = incomingId;
      accumulator.idToIndex.set(incomingId, index);
    }

    const fn = toolCall?.function || toolCall || {};
    const nameDelta = String(fn?.name ?? toolCall?.name ?? "");
    const rawArgumentsDelta = fn?.arguments ?? toolCall?.arguments ?? "";
    const argumentsDelta = typeof rawArgumentsDelta === "string"
      ? rawArgumentsDelta
      : JSON.stringify(rawArgumentsDelta ?? {});
    current.type = String(toolCall?.type || current.type || "function");
    current.name += nameDelta;
    current.arguments += argumentsDelta;
    accumulator.calls.set(index, current);
    appended.push({
      index,
      id: incomingId,
      type: current.type,
      nameDelta,
      argumentsDelta,
    });
  });
  return appended;
}

export function materializeOpenAICompatibleToolCalls(accumulator) {
  if (!accumulator?.calls) return [];
  return [...accumulator.calls.values()]
    .sort((left, right) => left.index - right.index)
    .map((toolCall) => {
      const name = String(toolCall.name || "");
      const argumentsText = String(toolCall.arguments || "") || "{}";
      return {
        id: String(toolCall.id || `call_${toolCall.index}`),
        type: "function",
        name,
        arguments: argumentsText,
        function: { name, arguments: argumentsText },
      };
    });
}

export function buildOpenAICompatibleTransportMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const role = String(message.role || "").trim().toLowerCase();
      if (!["system", "user", "assistant", "tool"].includes(role)) return null;
      const content = typeof message.content === "string" ? message.content : "";
      if (role === "tool") {
        const toolCallId = String(message.tool_call_id || "").trim();
        if (!toolCallId) return null;
        return {
          role,
          content,
          tool_call_id: toolCallId,
          ...(message.name ? { name: String(message.name) } : {}),
        };
      }
      const toolCalls =
        role === "assistant" && Array.isArray(message.tool_calls)
          ? clone(message.tool_calls, [])
          : [];
      if (!content.trim() && toolCalls.length === 0) return null;
      return {
        role,
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    })
    .filter(Boolean);
}

export function attachOpenAICompatibleTools(
  body,
  tools = [],
  toolChoice = "auto",
) {
  if (!body || typeof body !== "object") {
    throw new TypeError("OpenAI-compatible request body is required");
  }
  if (!Array.isArray(tools) || tools.length === 0) return body;
  body.tools = clone(tools, []);
  body.tool_choice = toolChoice || "auto";
  body.enable_function_calling = true;
  return body;
}
