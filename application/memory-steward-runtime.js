import { MemoryStewardToolset } from "../agent/memory-steward-tools.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { createBmeAgentRuntime } from "./bme-agent-runtime.js";
import { MemoryStewardService } from "./memory-steward-service.js";

export function createMemoryStewardRuntime({
  memoryLedgerRepository,
  settings = {},
  model,
  countTokens,
  semanticSearch = null,
  instructions = "",
  workerId = "memory-steward",
  now = () => Date.now(),
  onStatus = null,
} = {}) {
  if (!memoryLedgerRepository) {
    throw new TypeError("createMemoryStewardRuntime requires memoryLedgerRepository");
  }
  const registry = new AgentToolRegistry();
  const toolset = new MemoryStewardToolset({
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
  const service = new MemoryStewardService({
    repository: memoryLedgerRepository,
    agentRuntime,
    toolset,
    workerId,
    instructions,
    now,
    onStatus,
  });
  return Object.freeze({
    service,
    agentRuntime,
    toolset,
    tools: registry,
    wake: (chatId, options) => service.wake(chatId, options),
    recover: (chatId) => service.recover(chatId),
    dispose: () => unregisterTools(),
  });
}
