import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
} from "../prompting/prompt-builder.js";

export function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal, message = "操作已终止") {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError(message);
  }
}

export function createTaskLlmDebugContext(promptBuild, regexInput) {
  return buildTaskExecutionDebugContext(promptBuild, { regexInput });
}

export function resolveTaskPromptPayload(promptBuild, fallbackUserPrompt = "") {
  return buildTaskLlmPayload(promptBuild, fallbackUserPrompt);
}

export function resolveTaskLlmSystemPrompt(
  promptPayload,
  fallbackSystemPrompt = "",
) {
  const hasPromptMessages =
    Array.isArray(promptPayload?.promptMessages) &&
    promptPayload.promptMessages.length > 0;
  return String(
    promptPayload?.systemPrompt ||
      (hasPromptMessages ? "" : fallbackSystemPrompt) ||
      "",
  );
}
