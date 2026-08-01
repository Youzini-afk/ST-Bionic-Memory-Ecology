import { TokenAwareAgentContext } from "../agent/context-window.js";
import { DurableAgentJournal } from "../agent/journal.js";
import { BmeAgentLoop } from "../agent/loop.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";

async function callDefaultBmeAgentModel(request) {
  const { callBmeAgentModel } = await import("../llm/llm.js");
  return await callBmeAgentModel(request);
}

async function countDefaultBmeAgentContextTokens(request) {
  const { countBmeAgentContextTokens } = await import(
    "../host/agent-token-counter.js"
  );
  return await countBmeAgentContextTokens(request);
}

export function createBmeAgentRuntime({
  memoryLedgerRepository,
  journal = null,
  settings = {},
  model = callDefaultBmeAgentModel,
  countTokens = countDefaultBmeAgentContextTokens,
  toolRegistry = new AgentToolRegistry(),
  observer = null,
  now = () => Date.now(),
} = {}) {
  if (!journal && !memoryLedgerRepository) {
    throw new TypeError(
      "createBmeAgentRuntime requires a journal or memoryLedgerRepository",
    );
  }
  const resolvedJournal =
    journal ||
    new DurableAgentJournal({
      repository: memoryLedgerRepository,
      now,
    });
  const context = new TokenAwareAgentContext({ countTokens, settings });
  const loop = new BmeAgentLoop({
    model,
    toolRegistry,
    journal: resolvedJournal,
    context,
    observer,
    settings,
    now,
  });
  return Object.freeze({
    tools: toolRegistry,
    journal: resolvedJournal,
    context,
    loop,
    run: (request) => loop.run(request),
    recoverInterruptedRuns: (chatId, options) =>
      resolvedJournal.recoverInterruptedRuns(chatId, options),
  });
}
