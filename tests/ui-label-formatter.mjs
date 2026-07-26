import assert from "node:assert/strict";

import { setLocale } from "../i18n/index.js";
import {
  uiBuildRegionLine,
  uiBuildScopeMetaText,
  uiDescribeStoryTimeSpanDisplay,
  uiMemoryNodeTypeClass,
  uiOwnerTypeLabel,
  uiScopeBadgeText,
  uiTypeLabel,
} from "../ui/ui-label-formatter.js";

setLocale("zh-CN");
assert.equal(uiTypeLabel("event"), "事件");
assert.equal(uiTypeLabel("pov_memory"), "主观记忆");
assert.equal(uiTypeLabel("custom_type"), "custom_type");
assert.equal(uiTypeLabel(""), "—");
assert.equal(uiMemoryNodeTypeClass("character"), "type-character");
assert.equal(uiMemoryNodeTypeClass("pov_memory"), "type-character");
assert.equal(uiMemoryNodeTypeClass("event"), "type-event");
assert.equal(uiOwnerTypeLabel("user"), "用户");
assert.equal(uiOwnerTypeLabel("character"), "角色");
assert.equal(
  uiScopeBadgeText({ layer: "pov", ownerType: "character", ownerName: "艾琳" }),
  "角色 POV · 艾琳",
);
assert.equal(
  uiScopeBadgeText({ layer: "objective", regionPrimary: "钟楼" }),
  "客观 · 钟楼",
);
assert.equal(
  uiBuildRegionLine({
    regionPrimary: "钟楼",
    regionPath: ["王城", "钟楼"],
    regionSecondary: ["地下室"],
  }),
  "主地区: 钟楼 | 地区路径: 王城 / 钟楼 | 次级地区: 地下室",
);
assert.equal(uiDescribeStoryTimeSpanDisplay({ mixed: true }), "混合时间");
assert.equal(
  uiDescribeStoryTimeSpanDisplay({ startLabel: "第一章", endLabel: "第二章", mixed: true }),
  "第一章 → 第二章 · 混合",
);
assert.equal(
  uiBuildScopeMetaText({
    scope: { layer: "pov", ownerType: "user", ownerName: "玩家" },
    storyTimeSpan: { startLabel: "第一章", mixed: true },
  }),
  "用户 POV: 玩家 · 剧情时间: 第一章 · 混合",
);

setLocale("en-US");
assert.equal(uiTypeLabel("event"), "Event");
assert.equal(uiTypeLabel("pov_memory"), "POV Memory");
assert.equal(uiOwnerTypeLabel("user"), "User");
assert.equal(uiOwnerTypeLabel("character"), "Character");
assert.equal(
  uiScopeBadgeText({ layer: "pov", ownerType: "character", ownerName: "Eileen" }),
  "Character POV · Eileen",
);
assert.equal(
  uiScopeBadgeText({ layer: "objective", regionPrimary: "Clocktower" }),
  "Objective · Clocktower",
);
assert.equal(
  uiBuildRegionLine({
    regionPrimary: "Clocktower",
    regionPath: ["Capital", "Clocktower"],
    regionSecondary: ["Basement"],
  }),
  "Primary region: Clocktower | Region path: Capital / Clocktower | Secondary regions: Basement",
);
assert.equal(uiDescribeStoryTimeSpanDisplay({ mixed: true }), "Mixed time");
assert.equal(
  uiDescribeStoryTimeSpanDisplay({ startLabel: "Chapter 1", endLabel: "Chapter 2", mixed: true }),
  "Chapter 1 → Chapter 2 · mixed",
);
assert.equal(
  uiBuildScopeMetaText({
    scope: { layer: "pov", ownerType: "user", ownerName: "Player" },
    storyTimeSpan: { startLabel: "Chapter 1", mixed: true },
  }),
  "User POV: Player · Story time: Chapter 1 · mixed",
);

setLocale("zh-CN");
console.log("ui label formatter tests passed");
