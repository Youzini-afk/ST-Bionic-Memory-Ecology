import { stableStringify } from "../domain/memory-id.js";
import { formatAgentToolCatalog } from "./tool-catalog.js";

async function loadPromptBuilder() {
  return (await import("../prompting/prompt-builder.js")).buildTaskPrompt;
}

async function loadStPromptContext() {
  return (await import("../host/st-context.js")).getSTContextForPrompt();
}

export async function buildAgentProfileMessages({
  settings = {},
  taskType,
  toolSnapshot,
  assignment = {},
  context = {},
  promptBuilder = null,
  stPromptContext = null,
} = {}) {
  const buildPrompt =
    typeof promptBuilder === "function" ? promptBuilder : await loadPromptBuilder();
  const hostContext =
    stPromptContext && typeof stPromptContext === "object"
      ? stPromptContext
      : await loadStPromptContext();
  const promptBuild = await buildPrompt(settings, taskType, {
    taskName: String(taskType || ""),
    ...hostContext,
    ...context,
    agentToolCatalog: formatAgentToolCatalog(toolSnapshot),
    agentAssignment:
      typeof assignment === "string" ? assignment : stableStringify(assignment),
  });
  const messages = (promptBuild?.executionMessages || [])
    .map((message) => ({
      role: String(message?.role || "").trim(),
      content: String(message?.content || ""),
    }))
    .filter((message) => message.role && message.content.trim());
  if (!messages.length) {
    throw new Error(`Agent task profile rendered no messages: ${String(taskType || "")}`);
  }
  return {
    messages,
    profileId: String(promptBuild?.profile?.id || ""),
    profileName: String(promptBuild?.profile?.name || ""),
    toolSnapshotFingerprint: String(toolSnapshot?.fingerprint || ""),
  };
}
