import {
  cloneDomainValue,
  hashDomainValue,
  stableStringify,
} from "../domain/memory-id.js";
import { BmeAgentProtocolError } from "./errors.js";

function normalizeContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      typeof part === "string" ? part : String(part?.text || part?.content || ""),
    )
    .join("");
}

export function normalizeAgentToolCall(toolCall = {}, index = 0) {
  const fn = toolCall?.function && typeof toolCall.function === "object"
    ? toolCall.function
    : toolCall;
  const name = String(fn?.name || toolCall?.name || "").trim();
  if (!name) throw new BmeAgentProtocolError("model returned a tool call without a name");
  const rawArguments = fn?.arguments ?? toolCall?.arguments ?? "{}";
  const argumentsText =
    typeof rawArguments === "string" ? rawArguments : stableStringify(rawArguments);
  const id = String(toolCall?.id || "").trim() ||
    `call_${index}_${hashDomainValue({ name, arguments: argumentsText })}`;
  return {
    id,
    type: "function",
    name,
    arguments: argumentsText || "{}",
    function: { name, arguments: argumentsText || "{}" },
  };
}

export function normalizeAgentModelResponse(response = {}) {
  const content = normalizeContent(response?.content);
  const sourceCalls = Array.isArray(response?.toolCalls)
    ? response.toolCalls
    : Array.isArray(response?.tool_calls)
      ? response.tool_calls
      : [];
  const toolCalls = sourceCalls.map(normalizeAgentToolCall);
  const ids = new Set();
  for (const toolCall of toolCalls) {
    if (ids.has(toolCall.id)) {
      throw new BmeAgentProtocolError(`model returned duplicate tool call id: ${toolCall.id}`);
    }
    ids.add(toolCall.id);
  }
  if (!content.trim() && toolCalls.length === 0) {
    throw new BmeAgentProtocolError("model returned neither content nor tool calls");
  }
  return {
    content,
    toolCalls,
    finishReason: String(response?.finishReason || response?.finish_reason || ""),
    reasoningContent: String(response?.reasoningContent || response?.reasoning_content || ""),
    usage: cloneDomainValue(response?.usage, null),
    raw: response?.raw,
  };
}

export function toAgentAssistantMessage(response = {}) {
  const normalized = normalizeAgentModelResponse(response);
  const message = { role: "assistant", content: normalized.content };
  if (normalized.toolCalls.length > 0) {
    message.tool_calls = normalized.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));
  }
  return { response: normalized, message };
}

export function toAgentToolMessage(toolCall, result) {
  return {
    role: "tool",
    tool_call_id: String(toolCall?.id || ""),
    name: String(toolCall?.name || toolCall?.function?.name || ""),
    content: String(result?.content ?? ""),
  };
}
