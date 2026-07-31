import { GRAPH_STEWARD_SYSTEM_PROMPT } from "../agent/graph-steward-prompt.js";
import { RECALL_AGENT_SYSTEM_PROMPT } from "../agent/recall-agent-prompt.js";

function customBlock(id, name, role, content, order) {
  return {
    id,
    name,
    type: "custom",
    enabled: true,
    role,
    sourceKey: "",
    sourceField: "",
    content,
    injectionMode: "relative",
    order,
  };
}

function builtinBlock(id, name, role, sourceKey, order) {
  return {
    id,
    name,
    type: "builtin",
    enabled: true,
    role,
    sourceKey,
    sourceField: "",
    content: "",
    injectionMode: "relative",
    order,
  };
}

function buildAgentProfile({ taskType, name, description, rolePrompt }) {
  return {
    id: "default",
    name,
    taskType,
    version: 1,
    builtin: true,
    enabled: true,
    description,
    promptMode: "block-based",
    updatedAt: "2026-07-31T00:00:00.000Z",
    blocks: [
      customBlock(`${taskType}-default-role`, "Agent 角色与策略", "system", rolePrompt, 0),
      builtinBlock(`${taskType}-default-char-desc`, "角色描述", "system", "charDescription", 1),
      builtinBlock(`${taskType}-default-user-persona`, "用户设定", "system", "userPersona", 2),
      builtinBlock(`${taskType}-default-wi-before`, "世界书前块", "system", "worldInfoBefore", 3),
      builtinBlock(`${taskType}-default-wi-after`, "世界书后块", "system", "worldInfoAfter", 4),
      builtinBlock(`${taskType}-default-tool-catalog`, "Agent 工具目录", "system", "agentToolCatalog", 5),
      builtinBlock(`${taskType}-default-assignment`, "Agent 当前任务", "user", "agentAssignment", 6),
    ],
    generation: {
      llm_preset: "",
      max_context_tokens: null,
      max_completion_tokens: null,
      reply_count: 1,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      top_a: null,
      min_p: null,
      seed: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
      squash_system_messages: null,
      reasoning_effort: null,
      request_thoughts: null,
      enable_function_calling: true,
      enable_web_search: false,
      character_name_prefix: null,
      wrap_user_messages_in_quotes: null,
    },
    input: {
      rawChatContextFloors: 0,
      rawChatSourceMode: "ignore_bme_hide",
    },
    regex: {
      enabled: true,
      inheritStRegex: true,
      sources: { global: true, preset: true, character: true },
      stages: {
        "input.userMessage": true,
        "input.recentMessages": true,
        "input.candidateText": true,
        "input.finalPrompt": false,
        "output.rawResponse": false,
        "output.beforeParse": false,
        input: true,
        output: false,
      },
      localRules: [],
    },
    metadata: {
      migratedFromLegacy: false,
      legacyPromptField: "",
    },
  };
}

export const DEFAULT_AGENT_TASK_PROFILE_TEMPLATES = Object.freeze({
  agent_recall: buildAgentProfile({
    taskType: "agent_recall",
    name: "默认 Agent 召回预设",
    description: "独立控制召回 Agent 的调查策略、工具使用与注入计划。",
    rolePrompt: RECALL_AGENT_SYSTEM_PROMPT,
  }),
  agent_steward: buildAgentProfile({
    taskType: "agent_steward",
    name: "默认 Agent 记忆管家预设",
    description: "独立控制后台 Agent 对提取与维护任务的判断和调度。",
    rolePrompt: GRAPH_STEWARD_SYSTEM_PROMPT,
  }),
});
