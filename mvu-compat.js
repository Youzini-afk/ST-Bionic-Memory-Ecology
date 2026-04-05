// ST-BME: MVU (MagVarUpdate) compatibility helpers for private task prompts.
// These rules are intentionally narrow so we strip MVU artifacts without
// disturbing normal prompt or world info content.

export const MVU_SANITIZE_MODES = Object.freeze({
  /** 整段 drop likely MVU 内容（用于世界书条目）。 */
  AGGRESSIVE: "aggressive",
  /** 只剥离 MVU 容器/宏，不整段 drop（用于用户原文、角色描述等任务输入字段）。 */
  PASSIVE: "passive",
});

export const MVU_ENTRY_COMMENT_REGEX = /\[(mvu_update|mvu_plot|initvar)\]/i;

const MVU_UPDATE_BLOCK_REGEX =
  /\n?<(update(?:variable)?|variableupdate)>(?:(?!<\1>).)*?<\/\1>/gis;
const MVU_STATUS_PLACEHOLDER_REGEX = /\n?<StatusPlaceHolderImpl\/>/gi;
const MVU_STATUS_CURRENT_VARIABLE_REPLACE_REGEX =
  /\n?<status_current_variables?>[\s\S]*?<\/status_current_variables?>/gi;
const MVU_STATUS_CURRENT_VARIABLE_DETECT_REGEX =
  /<status_current_variables?>[\s\S]*?<\/status_current_variables?>/i;
const MVU_MESSAGE_VARIABLE_MACRO_REGEX =
  /\{\{\s*get_message_variable::(?:stat_data|display_data|delta_data)(?:\.[^}]+)?\s*}}/gi;
const MVU_GETVAR_REFERENCE_REGEX =
  /getvar\(\s*["'](?:stat_data|display_data|delta_data)["']\s*\)/gi;
const MVU_STATEFUL_TEMPLATE_TAG_REGEX =
  /<%[-=]?[\s\S]*?(?:SafeGetValue|getvar\(\s*["'](?:stat_data|display_data|delta_data)["']\s*\)|\b(?:stat_data|display_data|delta_data)\b)[\s\S]*?%>/gi;
const EJS_TEMPLATE_TAG_REGEX = /<%[-=]?[\s\S]*?%>/gi;
const MVU_VARIABLE_OUTPUT_ENTRY_REGEX = /变量输出格式:\s*[\s\S]*?<UpdateVariable>/i;
const MVU_VARIABLE_RULES_ENTRY_REGEX =
  /变量更新规则:\s*[\s\S]*?(?:type:\s*|check:\s*|当前时间:|近期事务:)/i;
const MVU_FORMAT_EMPHASIS_ENTRY_REGEX =
  /(?:变量输出格式强调|格式强调[：:]?-?变量更新规则|格式强调[：:]?-?剧情演绎|The following must be inserted to the end of (?:each )?reply,? and cannot be omitted)[\s\S]*?format:\s*\|-?/i;
const MVU_STATE_OBJECT_FIELD_REGEX =
  /["']?(?:stat_data|display_data|delta_data)["']?\s*:/i;
const MVU_STATE_PATH_REFERENCE_REGEX =
  /\b(?:stat_data|display_data|delta_data)(?:\.[\w$\u4e00-\u9fff\[\]"'-]+){1,}/i;
const MVU_STATE_HELPER_REFERENCE_REGEX =
  /\b(?:SafeGetValue\([^)]*(?:stat_data|display_data|delta_data)[^)]*\)|message_data\[\d+\]\.data\.(?:stat_data|display_data|delta_data))\b/i;

function uniq(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeText(value = "") {
  return String(value || "").replace(/\r\n/g, "\n");
}

function collapseWhitespace(value = "") {
  return String(value || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countRegexMatches(text = "", regex) {
  if (!text || !(regex instanceof RegExp)) {
    return 0;
  }

  const source = new RegExp(regex.source, regex.flags);
  let count = 0;
  while (source.exec(text)) {
    count += 1;
  }
  return count;
}

function matchesRegex(text = "", regex) {
  if (!text || !(regex instanceof RegExp)) {
    return false;
  }

  return new RegExp(regex.source, regex.flags).test(text);
}

function stripMvuPromptArtifactsDetailed(content = "") {
  const input = normalizeText(content);
  if (!input) {
    return {
      text: "",
      changed: false,
      artifactRemovedCount: 0,
    };
  }

  const statefulTemplateTagCount = countRegexMatches(
    input,
    MVU_STATEFUL_TEMPLATE_TAG_REGEX,
  );
  const artifactRemovedCount =
    countRegexMatches(input, MVU_UPDATE_BLOCK_REGEX) +
    countRegexMatches(input, MVU_STATUS_PLACEHOLDER_REGEX) +
    countRegexMatches(input, MVU_STATUS_CURRENT_VARIABLE_REPLACE_REGEX) +
    countRegexMatches(input, MVU_MESSAGE_VARIABLE_MACRO_REGEX) +
    countRegexMatches(input, MVU_GETVAR_REFERENCE_REGEX) +
    statefulTemplateTagCount;

  let stripped = input
    .replace(MVU_UPDATE_BLOCK_REGEX, "")
    .replace(MVU_STATUS_PLACEHOLDER_REGEX, "")
    .replace(MVU_STATUS_CURRENT_VARIABLE_REPLACE_REGEX, "")
    .replace(MVU_MESSAGE_VARIABLE_MACRO_REGEX, "")
    .replace(MVU_GETVAR_REFERENCE_REGEX, "")
    .replace(MVU_STATEFUL_TEMPLATE_TAG_REGEX, "");
  if (statefulTemplateTagCount > 0) {
    stripped = stripped.replace(EJS_TEMPLATE_TAG_REGEX, "");
  }

  const normalized = collapseWhitespace(stripped);
  return {
    text: normalized,
    changed: normalized !== collapseWhitespace(input),
    artifactRemovedCount,
  };
}

function stripBlockedPromptContentsDetailed(content = "", blockedContents = []) {
  const input = normalizeText(content);
  const normalizedBlocked = uniq(
    (Array.isArray(blockedContents) ? blockedContents : [])
      .map((item) => collapseWhitespace(item))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length),
  );

  if (!input || normalizedBlocked.length === 0) {
    return {
      text: collapseWhitespace(input),
      changed: false,
      blockedHitCount: 0,
    };
  }

  let output = input;
  let blockedHitCount = 0;
  for (const blocked of normalizedBlocked) {
    let index = output.indexOf(blocked);
    while (index >= 0) {
      blockedHitCount += 1;
      output = `${output.slice(0, index)}${output.slice(index + blocked.length)}`;
      index = output.indexOf(blocked);
    }
  }

  const normalized = collapseWhitespace(output);
  return {
    text: normalized,
    changed: normalized !== collapseWhitespace(input),
    blockedHitCount,
  };
}

export function isMvuTaggedWorldInfoComment(comment = "") {
  return MVU_ENTRY_COMMENT_REGEX.test(String(comment || ""));
}

export function isMvuTaggedWorldInfoNameOrComment(name = "", comment = "") {
  return (
    MVU_ENTRY_COMMENT_REGEX.test(String(name || "")) ||
    MVU_ENTRY_COMMENT_REGEX.test(String(comment || ""))
  );
}

export function isLikelyMvuWorldInfoContent(content = "") {
  const normalized = collapseWhitespace(content);
  if (!normalized) {
    return false;
  }
  const stateKeyMentionCount =
    normalized.match(/\b(?:stat_data|display_data|delta_data)\b/gi)?.length || 0;

  const stateSignals = [
    MVU_MESSAGE_VARIABLE_MACRO_REGEX,
    MVU_GETVAR_REFERENCE_REGEX,
    MVU_STATE_OBJECT_FIELD_REGEX,
    MVU_STATE_PATH_REFERENCE_REGEX,
    MVU_STATE_HELPER_REFERENCE_REGEX,
  ].reduce(
    (count, pattern) => count + (matchesRegex(normalized, pattern) ? 1 : 0),
    0,
  );

  return (
    matchesRegex(normalized, MVU_STATUS_CURRENT_VARIABLE_DETECT_REGEX) ||
    matchesRegex(normalized, MVU_VARIABLE_OUTPUT_ENTRY_REGEX) ||
    matchesRegex(normalized, MVU_VARIABLE_RULES_ENTRY_REGEX) ||
    matchesRegex(normalized, MVU_FORMAT_EMPHASIS_ENTRY_REGEX) ||
    stateSignals >= 2 ||
    (stateSignals >= 1 && stateKeyMentionCount >= 2)
  );
}

export function stripMvuPromptArtifacts(content = "") {
  return stripMvuPromptArtifactsDetailed(content).text;
}

export function stripBlockedPromptContents(content = "", blockedContents = []) {
  return stripBlockedPromptContentsDetailed(content, blockedContents).text;
}

export function sanitizeMvuContent(
  content = "",
  { mode = "aggressive", blockedContents = [] } = {},
) {
  const originalText = normalizeText(content);
  const originalCollapsed = collapseWhitespace(originalText);
  const sanitizedMode = String(mode || "aggressive").trim().toLowerCase();

  const artifactResult = stripMvuPromptArtifactsDetailed(originalCollapsed);
  const blockedResult = stripBlockedPromptContentsDetailed(
    artifactResult.text,
    blockedContents,
  );

  const reasons = [];
  if (artifactResult.artifactRemovedCount > 0) {
    reasons.push("artifact_stripped");
  }
  if (blockedResult.blockedHitCount > 0) {
    reasons.push("blocked_content_removed");
  }

  let text = blockedResult.text;
  let dropped = false;
  if (sanitizedMode === MVU_SANITIZE_MODES.AGGRESSIVE) {
    // 整段 drop：用于世界书条目，不用于用户原文字段
    if (
      isLikelyMvuWorldInfoContent(originalCollapsed) ||
      isLikelyMvuWorldInfoContent(text)
    ) {
      text = "";
      dropped = true;
      reasons.push("likely_mvu_content");
    }
  }
  // MVU_SANITIZE_MODES.PASSIVE：只做 artifact 剥离 + blocked 过滤，不整段 drop。

  return {
    text: collapseWhitespace(text),
    changed: collapseWhitespace(text) !== originalCollapsed,
    dropped,
    reasons: uniq(reasons),
    blockedHitCount: blockedResult.blockedHitCount,
    artifactRemovedCount: artifactResult.artifactRemovedCount,
  };
}
