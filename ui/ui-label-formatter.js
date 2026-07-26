// UI-only label formatting for ST-BME.
//
// Keep this module on the frontend boundary: these labels are translated for
// human-facing UI only. Do not import it from prompt/model/persistence paths.

import { normalizeMemoryScope } from "../graph/memory-scope.js";
import {
  normalizeStoryTime,
  normalizeStoryTimeSpan,
} from "../graph/story-timeline.js";
import { t } from "../i18n/index.js";

const UI_MEMORY_SCOPE_LAYER = Object.freeze({
  OBJECTIVE: "objective",
  POV: "pov",
});

const UI_MEMORY_SCOPE_OWNER_TYPE = Object.freeze({
  CHARACTER: "character",
  USER: "user",
});

export function uiMemoryNodeTypeClass(type) {
  switch (type) {
    case "pov_memory":
    case "character":
      return "type-character";
    case "event":
      return "type-event";
    case "location":
      return "type-location";
    case "rule":
      return "type-rule";
    case "thread":
      return "type-thread";
    default:
      return "type-default";
  }
}

export function uiTypeLabel(type) {
  const normalized = String(type || "").trim();
  if (!normalized) return "—";
  const key = `memory.type.${normalized}`;
  const translated = t(key);
  return translated === key ? normalized : translated;
}

export function normalizeOwnerUiType(ownerType = "") {
  const normalized = String(ownerType || "").trim();
  if (normalized === "user") return "user";
  if (normalized === "character") return "character";
  return "";
}

export function uiOwnerTypeLabel(ownerType = "") {
  const normalizedType = normalizeOwnerUiType(ownerType);
  if (normalizedType === "user") return t("scope.owner.user");
  if (normalizedType === "character") return t("scope.owner.character");
  return "Owner";
}

export function uiScopeBadgeText(scope) {
  const normalized = normalizeMemoryScope(scope);
  if (normalized.layer === UI_MEMORY_SCOPE_LAYER.POV) {
    const ownerLabel = normalized.ownerName || normalized.ownerId || "POV";
    return normalized.ownerType === UI_MEMORY_SCOPE_OWNER_TYPE.USER
      ? t("scope.badge.userPov", { owner: ownerLabel })
      : t("scope.badge.characterPov", { owner: ownerLabel });
  }
  return normalized.regionPrimary
    ? t("scope.badge.objectiveRegion", { region: normalized.regionPrimary })
    : t("scope.badge.objectiveGlobal");
}

export function uiBuildRegionLine(scope) {
  const normalized = normalizeMemoryScope(scope);
  const regionPath = Array.isArray(normalized.regionPath)
    ? normalized.regionPath.filter(Boolean)
    : [];
  const regionSecondary = Array.isArray(normalized.regionSecondary)
    ? normalized.regionSecondary.filter(Boolean)
    : [];
  const parts = [];
  if (normalized.regionPrimary) {
    parts.push(t("scope.region.primary", { region: normalized.regionPrimary }));
  }
  if (regionPath.length > 0) {
    parts.push(t("scope.region.path", { path: regionPath.join(" / ") }));
  }
  if (regionSecondary.length > 0) {
    parts.push(t("scope.region.secondary", { regions: regionSecondary.join(", ") }));
  }
  return parts.join(" | ");
}

export function uiDescribeStoryTimeDisplay(storyTime = {}) {
  const normalized = normalizeStoryTime(storyTime);
  const parts = [];
  if (normalized.arc) parts.push(normalized.arc);
  if (normalized.chapter) parts.push(normalized.chapter);
  if (normalized.scene) parts.push(normalized.scene);
  return parts.join(" / ");
}

export function uiDescribeStoryTimeSpanDisplay(storyTimeSpan = {}) {
  const normalized = normalizeStoryTimeSpan(storyTimeSpan);
  const label =
    normalized.startLabel &&
    normalized.endLabel &&
    normalized.startLabel !== normalized.endLabel
      ? `${normalized.startLabel} → ${normalized.endLabel}`
      : normalized.startLabel || normalized.endLabel || "";

  if (!label) {
    return normalized.mixed ? t("storyTime.mixedTime") : "";
  }
  return normalized.mixed ? `${label} · ${t("storyTime.mixed")}` : label;
}

export function uiDescribeNodeStoryTimeDisplay(node = {}) {
  return (
    uiDescribeStoryTimeDisplay(node.storyTime) ||
    uiDescribeStoryTimeSpanDisplay(node.storyTimeSpan) ||
    ""
  );
}

export function uiBuildScopeMetaText(node = {}) {
  const scope = normalizeMemoryScope(node?.scope);
  const parts = [];
  if (scope.layer === UI_MEMORY_SCOPE_LAYER.POV) {
    const ownerLabel = scope.ownerName || scope.ownerId || t("scope.owner.unnamed");
    parts.push(
      scope.ownerType === UI_MEMORY_SCOPE_OWNER_TYPE.USER
        ? t("scope.meta.userPov", { owner: ownerLabel })
        : t("scope.meta.characterPov", { owner: ownerLabel }),
    );
  }
  const regionLine = uiBuildRegionLine(scope);
  if (regionLine) parts.push(regionLine);
  const storyTime = uiDescribeNodeStoryTimeDisplay(node);
  if (storyTime) parts.push(t("storyTime.meta", { time: storyTime }));
  return parts.join(" · ");
}
