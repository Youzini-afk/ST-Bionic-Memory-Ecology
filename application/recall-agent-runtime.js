import { RecallAgentToolset } from "../agent/recall-agent-tools.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { createBmeAgentRuntime } from "./bme-agent-runtime.js";
import { RecallAgentService } from "./recall-agent-service.js";

export function createRecallAgentRuntime({
  memoryLedgerRepository,
  settings = {},
  model,
  countTokens,
  semanticSearch = null,
  resultBuilder = null,
  candidateBuilder,
  instructions = "",
  now = () => Date.now(),
  onStatus = null,
} = {}) {
  if (!memoryLedgerRepository) {
    throw new TypeError("createRecallAgentRuntime requires memoryLedgerRepository");
  }
  const registry = new AgentToolRegistry();
  const toolset = new RecallAgentToolset({
    repository: memoryLedgerRepository,
    semanticSearch,
    now,
  });
  const unregisterTools = toolset.registerInto(registry);
  const agentRuntime = createBmeAgentRuntime({
    memoryLedgerRepository,
    settings,
    ...(model ? { model } : {}),
    ...(countTokens ? { countTokens } : {}),
    toolRegistry: registry,
    now,
  });
  const service = new RecallAgentService({
    repository: memoryLedgerRepository,
    agentRuntime,
    toolset,
    ...(candidateBuilder ? { candidateBuilder } : {}),
    ...(resultBuilder ? { resultBuilder } : {}),
    instructions,
    now,
    onStatus,
  });
  return Object.freeze({
    service,
    agentRuntime,
    toolset,
    tools: registry,
    recall: (request) => service.recall(request),
    recover: (chatId) => service.recover(chatId),
    dispose: () => unregisterTools(),
  });
}
