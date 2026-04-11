function splitConfigText(value = "") {
  return String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function escapeRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBoundaryRule(rawRule, mode = "exclude", index = 0) {
  if (typeof rawRule === "string") {
    const tag = String(rawRule || "").trim();
    if (!tag) return null;
    return {
      id: `${mode}:tag:${index}:${tag}`,
      mode,
      kind: "tag",
      label: tag,
      tag,
    };
  }

  if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
    return null;
  }

  const tag = String(rawRule.tag || rawRule.name || "").trim();
  if (tag) {
    return {
      id: `${mode}:tag:${index}:${tag}`,
      mode,
      kind: "tag",
      label: String(rawRule.label || tag).trim() || tag,
      tag,
    };
  }

  const start = String(rawRule.start ?? rawRule.open ?? rawRule.begin ?? "").trim();
  const end = String(rawRule.end ?? rawRule.close ?? rawRule.finish ?? "").trim();
  if (!start || !end) {
    return null;
  }

  return {
    id: `${mode}:boundary:${index}`,
    mode,
    kind: "boundary",
    label: String(rawRule.label || `${start} … ${end}`).trim() || `${start} … ${end}`,
    start,
    end,
    caseSensitive: rawRule.caseSensitive === true,
  };
}

function normalizeBoundaryRules(rawRules = null, rawTags = "", mode = "exclude") {
  const values = [];
  if (Array.isArray(rawRules)) {
    values.push(...rawRules);
  } else if (rawRules !== null && rawRules !== undefined && rawRules !== "") {
    values.push(rawRules);
  }
  values.push(...splitConfigText(rawTags));

  return values
    .map((item, index) => normalizeBoundaryRule(item, mode, index))
    .filter(Boolean);
}

function applyTagBoundaryRule(text, rule) {
  const input = String(text || "");
  const escapedTag = escapeRegex(rule?.tag || "");
  if (!escapedTag) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || ""),
      matchedText: "",
    };
  }

  const regex = new RegExp(
    `<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`,
    "gi",
  );
  let match = null;
  for (const candidate of input.matchAll(regex)) {
    match = candidate;
  }
  if (!match) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || ""),
      matchedText: "",
    };
  }

  const matchedText = String(match[0] || "");
  if (rule?.mode === "extract") {
    return {
      changed: true,
      output: String(match[1] || "").trim(),
      ruleLabel: String(rule?.label || rule?.tag || ""),
      matchedText,
    };
  }

  const matchIndex = Number(match.index);
  if (!Number.isFinite(matchIndex) || matchIndex < 0) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || rule?.tag || ""),
      matchedText: "",
    };
  }

  return {
    changed: true,
    output: `${input.slice(0, matchIndex)}${input.slice(matchIndex + matchedText.length)}`.trim(),
    ruleLabel: String(rule?.label || rule?.tag || ""),
    matchedText,
  };
}

function applyLiteralBoundaryRule(text, rule) {
  const input = String(text || "");
  const start = String(rule?.start || "");
  const end = String(rule?.end || "");
  if (!start || !end) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || ""),
      matchedText: "",
    };
  }

  const sourceText = rule?.caseSensitive === true ? input : input.toLowerCase();
  const startNeedle = rule?.caseSensitive === true ? start : start.toLowerCase();
  const endNeedle = rule?.caseSensitive === true ? end : end.toLowerCase();
  const startIndex = sourceText.lastIndexOf(startNeedle);
  if (startIndex < 0) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || ""),
      matchedText: "",
    };
  }

  const endIndex = sourceText.indexOf(endNeedle, startIndex + startNeedle.length);
  if (endIndex < 0) {
    return {
      changed: false,
      output: input,
      ruleLabel: String(rule?.label || ""),
      matchedText: "",
    };
  }

  const matchedText = input.slice(startIndex, endIndex + end.length);
  if (rule?.mode === "extract") {
    return {
      changed: true,
      output: input.slice(startIndex + start.length, endIndex).trim(),
      ruleLabel: String(rule?.label || ""),
      matchedText,
    };
  }

  return {
    changed: true,
    output: `${input.slice(0, startIndex)}${input.slice(endIndex + end.length)}`.trim(),
    ruleLabel: String(rule?.label || ""),
    matchedText,
  };
}

function applyBoundaryRule(text, rule) {
  if (rule?.kind === "tag") {
    return applyTagBoundaryRule(text, rule);
  }
  if (rule?.kind === "boundary") {
    return applyLiteralBoundaryRule(text, rule);
  }
  return {
    changed: false,
    output: String(text || ""),
    ruleLabel: String(rule?.label || ""),
    matchedText: "",
  };
}

function applyFirstExtractRule(text, rules = []) {
  const input = String(text || "");
  for (const rule of Array.isArray(rules) ? rules : []) {
    const result = applyBoundaryRule(input, rule);
    if (result.changed) {
      return {
        changed: true,
        output: result.output,
        operation: {
          mode: "extract",
          rule: result.ruleLabel,
          matchedLength: String(result.matchedText || "").length,
        },
      };
    }
  }
  return {
    changed: false,
    output: input,
    operation: null,
  };
}

function applyExcludeRules(text, rules = []) {
  const input = String(text || "");
  let output = input;
  const operations = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    const result = applyBoundaryRule(output, rule);
    if (!result.changed) {
      continue;
    }
    output = result.output;
    operations.push({
      mode: "exclude",
      rule: result.ruleLabel,
      matchedLength: String(result.matchedText || "").length,
    });
  }

  return {
    changed: output !== input,
    output,
    operations,
  };
}

function normalizeRole(value = "") {
  const role = String(value || "assistant").trim().toLowerCase();
  if (["user", "assistant", "system"].includes(role)) {
    return role;
  }
  return role === "ai" ? "assistant" : "assistant";
}

function resolveMessageContent(message = {}) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (typeof message?.mes === "string") {
    return message.mes;
  }
  return "";
}

function resolveMessageRawContent(message = {}) {
  if (typeof message?.rawContent === "string") {
    return message.rawContent;
  }
  if (typeof message?.mes === "string") {
    return message.mes;
  }
  if (typeof message?.content === "string") {
    return message.content;
  }
  return "";
}

function resolveSpeakerName(message = {}, role = "assistant", names = {}) {
  const explicitSpeaker = String(
    message?.speaker ?? message?.name ?? message?.displayName ?? "",
  ).trim();
  if (explicitSpeaker) {
    return explicitSpeaker;
  }
  if (role === "user") {
    return String(names?.userName || "用户").trim() || "用户";
  }
  if (role === "assistant") {
    return String(names?.charName || "角色").trim() || "角色";
  }
  return role || "assistant";
}

function normalizeExtractionMessage(message = {}, index = 0, names = {}) {
  const role = normalizeRole(
    message?.role ?? (message?.is_user === true ? "user" : "assistant"),
  );
  const content = String(resolveMessageContent(message) || "").trim();
  const rawContent = String(resolveMessageRawContent(message) || content).trim();
  const speaker = resolveSpeakerName(message, role, names);
  const seq = Number.isFinite(Number(message?.seq)) ? Number(message.seq) : null;

  return {
    index,
    seq,
    role,
    speaker,
    name: speaker,
    content,
    rawContent,
    sourceType: role === "user" ? "user_input" : "ai_output",
  };
}

function countRoles(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (acc, message) => {
      const role = normalizeRole(message?.role || "assistant");
      acc[role] = Number(acc[role] || 0) + 1;
      return acc;
    },
    { user: 0, assistant: 0, system: 0 },
  );
}

export function formatExtractionTranscript(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const seqLabel = Number.isFinite(Number(message?.seq))
        ? `#${Number(message.seq)}`
        : `#${index + 1}`;
      const role = normalizeRole(message?.role || "assistant");
      const speaker = String(message?.speaker || message?.name || "").trim();
      const speakerLabel = speaker ? `|${speaker}` : "";
      return `${seqLabel} [${role}${speakerLabel}]: ${String(message?.content || "")}`;
    })
    .filter((item) => String(item || "").trim())
    .join("\n\n");
}

export function buildExtractionInputContext(
  messages = [],
  { settings = {}, userName = "", charName = "" } = {},
) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .map((message, index) => normalizeExtractionMessage(message, index, {
      userName,
      charName,
    }))
    .filter(
      (message) =>
        String(message?.content || "").trim().length > 0 ||
        String(message?.rawContent || "").trim().length > 0,
    );

  const extractRules = normalizeBoundaryRules(
    settings?.extractAssistantExtractRules,
    settings?.extractAssistantExtractTags,
    "extract",
  );
  const excludeRules = normalizeBoundaryRules(
    settings?.extractAssistantExcludeRules,
    settings?.extractAssistantExcludeTags,
    "exclude",
  );

  const filteredMessages = [];
  const messageOperations = [];
  let changedAssistantMessageCount = 0;
  let droppedAssistantMessageCount = 0;
  let extractedAssistantMessageCount = 0;
  let excludedAssistantMessageCount = 0;

  for (const message of normalizedMessages) {
    const operations = [];
    let nextContent = String(message.content || "");

    if (message.role === "assistant") {
      const extractResult = applyFirstExtractRule(nextContent, extractRules);
      if (extractResult.changed) {
        nextContent = extractResult.output;
        extractedAssistantMessageCount += 1;
        operations.push(extractResult.operation);
      }

      const excludeResult = applyExcludeRules(nextContent, excludeRules);
      if (excludeResult.changed) {
        nextContent = excludeResult.output;
        excludedAssistantMessageCount += 1;
        operations.push(...excludeResult.operations);
      }
    }

    const normalizedContent = String(nextContent || "").trim();
    if (operations.length > 0 || normalizedContent !== String(message.content || "").trim()) {
      if (message.role === "assistant") {
        changedAssistantMessageCount += 1;
      }
      messageOperations.push({
        seq: message.seq,
        role: message.role,
        speaker: message.speaker,
        beforeLength: String(message.content || "").length,
        afterLength: normalizedContent.length,
        operations,
      });
    }

    if (!normalizedContent) {
      if (message.role === "assistant" && String(message.content || "").trim()) {
        droppedAssistantMessageCount += 1;
      }
      continue;
    }

    filteredMessages.push({
      ...message,
      content: normalizedContent,
      extractionFilterOperations: operations,
    });
  }

  const rawTranscript = formatExtractionTranscript(
    normalizedMessages.filter((message) => String(message.content || "").trim()),
  );
  const filteredTranscript = formatExtractionTranscript(filteredMessages);

  return {
    rawMessages: normalizedMessages,
    filteredMessages,
    rawTranscript,
    filteredTranscript,
    debug: {
      rawMessageCount: normalizedMessages.length,
      filteredMessageCount: filteredMessages.length,
      rawRoleCounts: countRoles(normalizedMessages),
      filteredRoleCounts: countRoles(filteredMessages),
      rawTranscriptLength: rawTranscript.length,
      filteredTranscriptLength: filteredTranscript.length,
      changedAssistantMessageCount,
      droppedAssistantMessageCount,
      extractedAssistantMessageCount,
      excludedAssistantMessageCount,
      assistantBoundaryConfig: {
        extractRuleCount: extractRules.length,
        excludeRuleCount: excludeRules.length,
        extractRules: extractRules.map((rule) => rule.label),
        excludeRules: excludeRules.map((rule) => rule.label),
      },
      rawMessages: normalizedMessages,
      filteredMessages,
      messageOperations,
    },
  };
}
