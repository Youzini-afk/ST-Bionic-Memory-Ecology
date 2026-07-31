import { cloneDomainValue, stableStringify } from "../domain/memory-id.js";
import { BmeAgentContextError } from "./errors.js";
import { normalizeBmeAgentRuntimeSettings } from "./runtime-settings.js";

const COMPACTION_TRIGGER_RATIO = 0.88;
const COMPACTION_TARGET_RATIO = 0.76;
const RECENT_CONTEXT_SHARE = 0.58;

export function serializeAgentContextForTokenCount(messages = [], tools = []) {
  return stableStringify({ messages, tools });
}

export function estimateAgentContextTokens(messages = [], tools = []) {
  const text = serializeAgentContextForTokenCount(messages, tools);
  let estimated = 0;
  for (const character of text) {
    const code = character.codePointAt(0) || 0;
    estimated += code > 0x2e7f ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(estimated));
}

function splitPinnedMessages(messages) {
  const pinned = [];
  let index = 0;
  while (
    index < messages.length &&
    messages[index]?.role === "system" &&
    messages[index]?.bmeAgentContextSummary !== true
  ) {
    pinned.push(messages[index]);
    index += 1;
  }
  return { pinned, body: messages.slice(index) };
}

function groupSafeMessages(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      const group = [message];
      while (messages[index + 1]?.role === "tool") {
        group.push(messages[index + 1]);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    if (message?.role === "tool" && groups.length > 0) {
      groups.at(-1).push(message);
      continue;
    }
    groups.push([message]);
  }
  return groups;
}

function flattenGroups(groups) {
  return groups.flatMap((group) => group);
}

function normalizedTokenCount(result) {
  const numeric = Number(
    result && typeof result === "object" ? result.tokens : result,
  );
  return Number.isFinite(numeric) && numeric >= 0 ? Math.ceil(numeric) : null;
}

function compactionSummaryText(result) {
  return String(result && typeof result === "object" ? result.summary : result).trim();
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Agent context compaction was aborted", "AbortError");
}

export class TokenAwareAgentContext {
  constructor({ countTokens, settings = {} } = {}) {
    this.settings = normalizeBmeAgentRuntimeSettings(settings);
    this.countTokens = typeof countTokens === "function" ? countTokens : null;
  }

  async measure(messages, tools = []) {
    if (this.countTokens) {
      const measured = normalizedTokenCount(
        await this.countTokens({ messages, tools }),
      );
      if (measured !== null && measured > 0) return measured;
    }
    return estimateAgentContextTokens(messages, tools);
  }

  async _measureCompactionRequest(messages, maxSummaryTokens, measureCompaction) {
    if (typeof measureCompaction === "function") {
      const measured = normalizedTokenCount(
        await measureCompaction({ messages, maxSummaryTokens }),
      );
      if (measured !== null && measured > 0) return measured;
    }
    return await this.measure(
      [{ role: "user", content: stableStringify(messages) }],
      [],
    );
  }

  async _compactionFits(messages, maxSummaryTokens, measureCompaction) {
    const requestTokens = await this._measureCompactionRequest(
      messages,
      maxSummaryTokens,
      measureCompaction,
    );
    return {
      fits:
        requestTokens + maxSummaryTokens <=
        this.settings.contextWindowTokens,
      requestTokens,
    };
  }

  async _splitCompactionMessage(
    message,
    maxSummaryTokens,
    measureCompaction,
    signal,
  ) {
    const characters = Array.from(String(message?.content || ""));
    if (characters.length === 0) {
      throw new BmeAgentContextError(
        "A structured Agent message is too large to compact safely",
        { role: String(message?.role || ""), maxSummaryTokens },
      );
    }
    const fragments = [];
    let offset = 0;
    while (offset < characters.length) {
      throwIfAborted(signal);
      let low = 1;
      let high = characters.length - offset;
      let best = 0;
      while (low <= high) {
        const size = Math.floor((low + high) / 2);
        const fragment = {
          ...cloneDomainValue(message, message),
          content: characters.slice(offset, offset + size).join(""),
          bmeAgentCompactionFragment: {
            index: fragments.length,
            sourceRole: String(message?.role || ""),
          },
        };
        const measurement = await this._compactionFits(
          [fragment],
          maxSummaryTokens,
          measureCompaction,
        );
        if (measurement.fits) {
          best = size;
          low = size + 1;
        } else {
          high = size - 1;
        }
      }
      if (best <= 0) {
        throw new BmeAgentContextError(
          "An Agent message cannot fit into a token-bounded compaction request",
          { role: String(message?.role || ""), maxSummaryTokens },
        );
      }
      fragments.push({
        ...cloneDomainValue(message, message),
        content: characters.slice(offset, offset + best).join(""),
        bmeAgentCompactionFragment: {
          index: fragments.length,
          sourceRole: String(message?.role || ""),
        },
      });
      offset += best;
    }
    return fragments;
  }

  async _compactMessages({
    messages,
    maxSummaryTokens,
    compact,
    measureCompaction,
    signal,
    depth = 0,
  }) {
    throwIfAborted(signal);
    const directMeasurement = await this._compactionFits(
      messages,
      maxSummaryTokens,
      measureCompaction,
    );
    if (directMeasurement.fits) {
      const result = await compact({
        messages,
        maxSummaryTokens,
        signal,
        stage: depth === 0 ? "direct" : "reduce",
        depth,
        chunkIndex: 0,
        chunkCount: 1,
      });
      const summary = compactionSummaryText(result);
      if (!summary) {
        throw new BmeAgentContextError("Agent context compactor returned an empty summary");
      }
      return summary;
    }

    const intermediateSummaryTokens = Math.max(
      1,
      Math.min(
        maxSummaryTokens,
        Math.floor(this.settings.contextWindowTokens * 0.12),
      ),
    );
    const units = [];
    for (const message of messages) {
      throwIfAborted(signal);
      const single = await this._compactionFits(
        [message],
        intermediateSummaryTokens,
        measureCompaction,
      );
      if (single.fits) units.push(message);
      else {
        units.push(
          ...(await this._splitCompactionMessage(
            message,
            intermediateSummaryTokens,
            measureCompaction,
            signal,
          )),
        );
      }
    }

    const chunks = [];
    let current = [];
    for (const unit of units) {
      const candidate = [...current, unit];
      const measurement = await this._compactionFits(
        candidate,
        intermediateSummaryTokens,
        measureCompaction,
      );
      if (!measurement.fits && current.length > 0) {
        chunks.push(current);
        current = [unit];
      } else if (!measurement.fits) {
        throw new BmeAgentContextError(
          "Agent context compaction produced an oversized input unit",
        );
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);
    if (chunks.length === 0) {
      throw new BmeAgentContextError("Agent context compaction could not create a safe input chunk");
    }

    const summaries = [];
    for (let index = 0; index < chunks.length; index += 1) {
      throwIfAborted(signal);
      const result = await compact({
        messages: chunks[index],
        maxSummaryTokens: intermediateSummaryTokens,
        signal,
        stage: "map",
        depth,
        chunkIndex: index,
        chunkCount: chunks.length,
      });
      const summary = compactionSummaryText(result);
      if (!summary) {
        throw new BmeAgentContextError("Agent context compactor returned an empty chunk summary", {
          chunkIndex: index,
        });
      }
      summaries.push({
        role: "system",
        content: summary,
        bmeAgentContextSummary: true,
        bmeAgentCompactionChunk: { depth, index, count: chunks.length },
      });
    }
    if (summaries.length === 1) return summaries[0].content;

    const reducedMeasurement = await this._compactionFits(
      summaries,
      maxSummaryTokens,
      measureCompaction,
    );
    if (
      !reducedMeasurement.fits &&
      reducedMeasurement.requestTokens >= directMeasurement.requestTokens
    ) {
      throw new BmeAgentContextError("Agent context summaries did not reduce the token budget", {
        beforeTokens: directMeasurement.requestTokens,
        afterTokens: reducedMeasurement.requestTokens,
      });
    }
    return await this._compactMessages({
      messages: summaries,
      maxSummaryTokens,
      compact,
      measureCompaction,
      signal,
      depth: depth + 1,
    });
  }

  async prepare({
    messages = [],
    tools = [],
    compact,
    measureCompaction,
    signal,
  } = {}) {
    const sourceMessages = cloneDomainValue(messages, []);
    const sourceTools = cloneDomainValue(tools, []);
    const { contextWindowTokens, completionReserveTokens } = this.settings;
    const inputCapacity = contextWindowTokens - completionReserveTokens;
    const currentTokens = await this.measure(sourceMessages, sourceTools);
    const triggerTokens = Math.floor(inputCapacity * COMPACTION_TRIGGER_RATIO);
    if (currentTokens <= triggerTokens) {
      return {
        messages: sourceMessages,
        compacted: false,
        currentTokens,
        projectedTokens: currentTokens,
        inputCapacity,
        removedMessages: [],
        summary: "",
      };
    }
    if (typeof compact !== "function") {
      throw new BmeAgentContextError("Agent context requires compaction but no compactor is available", {
        currentTokens,
        inputCapacity,
      });
    }

    const { pinned, body } = splitPinnedMessages(sourceMessages);
    const groups = groupSafeMessages(body);
    const targetTokens = Math.floor(inputCapacity * COMPACTION_TARGET_RATIO);
    const recentBudget = Math.floor(targetTokens * RECENT_CONTEXT_SHARE);
    const retainedGroups = [];
    let retainedStart = groups.length;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const candidateGroups = [groups[index], ...retainedGroups];
      const candidateMessages = [...pinned, ...flattenGroups(candidateGroups)];
      const candidateTokens = await this.measure(candidateMessages, sourceTools);
      if (candidateTokens > recentBudget && retainedGroups.length > 0) break;
      retainedGroups.unshift(groups[index]);
      retainedStart = index;
      if (candidateTokens > recentBudget) break;
    }

    const recentMessages = flattenGroups(retainedGroups);
    const removedMessages = flattenGroups(groups.slice(0, retainedStart));
    if (removedMessages.length === 0) {
      throw new BmeAgentContextError("The pinned prompt, tools, or latest tool result exceed the model context window", {
        currentTokens,
        inputCapacity,
      });
    }
    const baseTokens = await this.measure([...pinned, ...recentMessages], sourceTools);
    const maxSummaryTokens = Math.floor(targetTokens - baseTokens);
    if (maxSummaryTokens <= 0) {
      throw new BmeAgentContextError("No token budget remains for an Agent context summary", {
        baseTokens,
        targetTokens,
      });
    }

    const summary = await this._compactMessages({
      messages: removedMessages,
      maxSummaryTokens,
      compact,
      measureCompaction,
      signal,
    });
    const summaryMessage = {
      role: "system",
      content: summary,
      bmeAgentContextSummary: true,
    };
    const projectedMessages = [...pinned, summaryMessage, ...recentMessages];
    const projectedTokens = await this.measure(projectedMessages, sourceTools);
    if (projectedTokens > inputCapacity) {
      throw new BmeAgentContextError("Compacted Agent context still exceeds the model context window", {
        projectedTokens,
        inputCapacity,
        maxSummaryTokens,
      });
    }
    if (projectedMessages[pinned.length + 1]?.role === "tool") {
      throw new BmeAgentContextError("Compaction produced an orphan tool result");
    }
    return {
      messages: projectedMessages,
      compacted: true,
      currentTokens,
      projectedTokens,
      inputCapacity,
      removedMessages,
      summary,
      maxSummaryTokens,
    };
  }
}
