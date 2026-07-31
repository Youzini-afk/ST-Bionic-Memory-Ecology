import { TokenAwareAgentContext } from "../agent/context-window.js";
import { DurableAgentJournal } from "../agent/journal.js";
import { BmeAgentLoop } from "../agent/loop.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { countBmeAgentContextTokens } from "../host/agent-token-counter.js";
import { callBmeAgentModel } from "../llm/llm.js";

export function createBmeAgentRuntime({
  memoryLedgerRepository,
  settings = {},
  model = callBmeAgentModel,
  countTokens = countBmeAgentContextTokens,
  toolRegistry = new AgentToolRegistry(),
  now = () => Date.now(),
} = {}) {
  if (!memoryLedgerRepository) {
    throw new TypeError("createBmeAgentRuntime requires memoryLedgerRepository");
  }
  const journal = new DurableAgentJournal({
    repository: memoryLedgerRepository,
    now,
  });
  const context = new TokenAwareAgentContext({ countTokens, settings });
  const loop = new BmeAgentLoop({
    model,
    toolRegistry,
    journal,
    context,
    settings,
    now,
  });
  return Object.freeze({
    tools: toolRegistry,
    journal,
    context,
    loop,
    run: (request) => loop.run(request),
    recoverInterruptedRuns: (chatId, options) =>
      journal.recoverInterruptedRuns(chatId, options),
  });
}
