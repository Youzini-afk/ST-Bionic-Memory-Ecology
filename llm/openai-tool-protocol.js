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
  body.stream = false;
  return body;
}
