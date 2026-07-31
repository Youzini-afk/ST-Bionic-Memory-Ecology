export const RECALL_INJECTION_ROLES = Object.freeze([
  "anchor",
  "cause",
  "pov",
  "constraint",
  "background",
]);

export const RECALL_INJECTION_STRATEGIES = Object.freeze([
  "focused",
  "causal",
  "pov",
  "timeline",
  "balanced",
]);

const ROLE_ORDER = new Map(
  RECALL_INJECTION_ROLES.map((role, index) => [role, index]),
);

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

export function normalizeRecallInjectionPlan(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const issues = [];
  if (rawItems.length > 80) issues.push("items exceeds the 80-memory limit");
  const seen = new Set();
  const items = [];

  for (const [index, rawItem] of rawItems.slice(0, 80).entries()) {
    const memoryId = cleanText(rawItem?.memoryId, 256);
    const role = cleanText(rawItem?.role, 32);
    const priority = Number(rawItem?.priority);
    if (!memoryId) issues.push(`items[${index}].memoryId is required`);
    if (!RECALL_INJECTION_ROLES.includes(role)) {
      issues.push(`items[${index}].role is invalid`);
    }
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      issues.push(`items[${index}].priority must be an integer from 1 to 5`);
    }
    if (memoryId && seen.has(memoryId)) {
      issues.push(`items[${index}].memoryId is duplicated`);
    }
    if (memoryId) seen.add(memoryId);
    items.push({
      memoryId,
      role,
      priority: Number.isInteger(priority) ? priority : 1,
      reason: cleanText(rawItem?.reason, 500),
    });
  }

  const strategy = cleanText(source.strategy, 32) || "balanced";
  if (!RECALL_INJECTION_STRATEGIES.includes(strategy)) {
    issues.push("strategy is invalid");
  }

  return {
    valid: issues.length === 0,
    issues,
    plan: {
      version: 1,
      strategy,
      items,
    },
  };
}

export function compareNodesByRecallInjectionPlan(plan = null, left, right) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return 0;
  const byId = new Map(items.map((item, index) => [item.memoryId, { ...item, index }]));
  const leftItem = byId.get(String(left?.id || ""));
  const rightItem = byId.get(String(right?.id || ""));
  if (!leftItem && !rightItem) return 0;
  if (leftItem && !rightItem) return -1;
  if (!leftItem && rightItem) return 1;
  const roleDelta =
    (ROLE_ORDER.get(leftItem.role) ?? RECALL_INJECTION_ROLES.length) -
    (ROLE_ORDER.get(rightItem.role) ?? RECALL_INJECTION_ROLES.length);
  if (roleDelta !== 0) return roleDelta;
  const priorityDelta = Number(rightItem.priority || 0) - Number(leftItem.priority || 0);
  if (priorityDelta !== 0) return priorityDelta;
  return leftItem.index - rightItem.index;
}
