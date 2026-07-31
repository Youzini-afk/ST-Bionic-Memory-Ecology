import { stableStringify } from "../domain/memory-id.js";
import { getBmeHostAdapter } from "./runtime-host-adapter.js";

export async function countBmeAgentContextTokens({ messages = [], tools = [] } = {}) {
  const context = getBmeHostAdapter()?.context || null;
  const counter = context?.getTokenCountAsync;
  if (typeof counter !== "function") return null;
  const serialized = stableStringify({ messages, tools });
  const count = Number(await counter(serialized, 0));
  return Number.isFinite(count) && count > 0 ? count : null;
}
