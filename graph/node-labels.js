const DEFAULT_GRAPH_LABEL_LENGTH = 14;

const GRAPH_LABEL_LENGTH_BY_TYPE = {
  character: 12,
  event: 14,
  location: 12,
  thread: 14,
  rule: 14,
  synopsis: 16,
  reflection: 14,
  pov_memory: 16,
};

function normalizeLabelText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateNodeLabel(text, maxLength = DEFAULT_GRAPH_LABEL_LENGTH) {
  const normalized = normalizeLabelText(text);
  if (!normalized) return "—";
  if (!Number.isFinite(maxLength) || maxLength < 2) return normalized;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function deriveEventTitleFromSummary(summary, maxLength = 18) {
  const normalized = normalizeLabelText(summary).replace(/^事件[：:]\s*/, "");
  if (!normalized) return "";

  const clause =
    normalized.split(/[\r\n]+/, 1)[0]?.split(/[。！？!?]/, 1)[0]?.split(/[；;]/, 1)[0]?.split(/[，,]/, 1)[0] ||
    normalized;

  return truncateNodeLabel(clause || normalized, maxLength);
}

export function ensureEventTitle(fields = {}) {
  const nextFields = { ...(fields || {}) };
  if (!nextFields.title && nextFields.summary) {
    nextFields.title = deriveEventTitleFromSummary(nextFields.summary);
  }
  return nextFields;
}

export function getNodeDisplayName(node) {
  const label = normalizeLabelText(
    node?.fields?.name ||
      node?.fields?.title ||
      node?.fields?.summary ||
      node?.fields?.insight ||
      node?.name ||
      node?.id?.slice(0, 8) ||
      "—",
  );
  return label || "—";
}

export function getGraphNodeLabel(node) {
  const maxLength =
    GRAPH_LABEL_LENGTH_BY_TYPE[node?.type] || DEFAULT_GRAPH_LABEL_LENGTH;
  return truncateNodeLabel(getNodeDisplayName(node), maxLength);
}
