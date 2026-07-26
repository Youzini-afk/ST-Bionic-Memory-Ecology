import { truncateNodeLabel } from "../graph/node-labels.js";

function normalizePromptNodeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePromptNode(value = {}) {
  if (value?.node && typeof value.node === "object") {
    return value.node;
  }
  return value && typeof value === "object" ? value : {};
}

export function resolvePromptNodeId(value = {}) {
  const node = resolvePromptNode(value);
  return String(value?.nodeId || node?.id || "").trim();
}

export function resolveRecallCandidateSelection(
  result,
  candidateKeyToNodeId = {},
  maxNodes = 8,
) {
  const limit = Math.max(1, Math.floor(Number(maxNodes) || 1));
  const hasSelectedKeysField = Boolean(
    result && Object.prototype.hasOwnProperty.call(result, "selected_keys"),
  );
  const selectedKeysIsArray = Array.isArray(result?.selected_keys);
  const rawSelectedKeys = [];
  const seenKeys = new Set();
  for (const value of selectedKeysIsArray ? result.selected_keys : []) {
    const key = String(value || "").trim();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    rawSelectedKeys.push(key);
    if (rawSelectedKeys.length >= limit * 4) break;
  }
  const resolvedSelectedKeys = rawSelectedKeys
    .filter((key) => candidateKeyToNodeId[key])
    .slice(0, limit);
  const resolvedSelectedNodeIds = [
    ...new Set(
      resolvedSelectedKeys
        .map((key) => String(candidateKeyToNodeId[key] || "").trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
  return {
    hasSelectedKeysField,
    selectedKeysIsArray,
    rawSelectedKeys,
    resolvedSelectedKeys,
    resolvedSelectedNodeIds,
  };
}

export function getPromptNodeLabel(value = {}, { maxLength = 32 } = {}) {
  const node = resolvePromptNode(value);
  const fallbackId = typeof node?.id === "string" ? node.id.slice(0, 8) : "";
  const rawLabel = normalizePromptNodeText(
    node?.fields?.title ||
      node?.fields?.name ||
      node?.fields?.summary ||
      node?.fields?.insight ||
      node?.fields?.belief ||
      node?.name ||
      fallbackId ||
      "—",
  );
  return truncateNodeLabel(rawLabel || "—", maxLength);
}

export function createPromptNodeReferenceMap(
  entries = [],
  {
    prefix = "N",
    maxLength = 32,
    buildMeta = null,
  } = {},
) {
  const keyToNodeId = {};
  const keyToMeta = {};
  const nodeIdToKey = {};
  const references = [];

  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const node = resolvePromptNode(entry);
    const nodeId = resolvePromptNodeId(entry);
    if (!nodeId || nodeIdToKey[nodeId]) {
      continue;
    }

    const key = `${String(prefix || "N").trim() || "N"}${references.length + 1}`;
    const label = getPromptNodeLabel(node, { maxLength });
    const extraMeta = typeof buildMeta === "function"
      ? buildMeta({
          entry,
          node,
          nodeId,
          key,
          index,
          label,
        })
      : {};

    keyToNodeId[key] = nodeId;
    nodeIdToKey[nodeId] = key;
    keyToMeta[key] = {
      nodeId,
      type: String(node?.type || ""),
      label,
      ...(extraMeta && typeof extraMeta === "object" ? extraMeta : {}),
    };
    references.push({
      key,
      nodeId,
      node,
      meta: keyToMeta[key],
    });
  }

  return {
    prefix: String(prefix || "N").trim() || "N",
    references,
    keyToNodeId,
    keyToMeta,
    nodeIdToKey,
  };
}
