import assert from "node:assert/strict";

import {
  buildVisibleGraphRefreshToken,
  resolveVisibleGraphWorkspaceMode,
} from "../ui/panel-graph-refresh-utils.js";

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: false,
    isMobile: false,
    currentTabId: "dashboard",
    currentGraphView: "graph",
  }),
  "hidden",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: false,
    currentTabId: "config",
    currentGraphView: "graph",
  }),
  "hidden",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: false,
    currentTabId: "dashboard",
    currentGraphView: "graph",
  }),
  "desktop:graph",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: false,
    currentTabId: "memory",
    currentGraphView: "cognition",
  }),
  "desktop:cognition",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: false,
    currentTabId: "actions",
    currentGraphView: "summary",
  }),
  "desktop:summary",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: true,
    currentTabId: "dashboard",
    currentMobileGraphView: "graph",
  }),
  "hidden",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: true,
    currentTabId: "graph",
    currentMobileGraphView: "graph",
  }),
  "mobile:graph",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: true,
    currentTabId: "graph",
    currentMobileGraphView: "cognition",
  }),
  "mobile:cognition",
);

assert.equal(
  resolveVisibleGraphWorkspaceMode({
    overlayActive: true,
    isMobile: true,
    currentTabId: "graph",
    currentMobileGraphView: "summary",
  }),
  "mobile:summary",
);

assert.equal(
  buildVisibleGraphRefreshToken({
    visibleMode: "hidden",
    chatId: "chat-main",
    loadState: "loaded",
    revision: 12,
    nodeCount: 40,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
  "hidden",
);

const baseToken = buildVisibleGraphRefreshToken({
  visibleMode: "desktop:graph",
  chatId: "chat-main",
  loadState: "loaded",
  revision: 12,
  nodeCount: 40,
  edgeCount: 55,
  lastProcessedSeq: 9,
});

assert.equal(
  baseToken,
  buildVisibleGraphRefreshToken({
    visibleMode: "desktop:graph",
    chatId: "chat-main",
    loadState: "loaded",
    revision: 12,
    nodeCount: 40,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
);

assert.notEqual(
  baseToken,
  buildVisibleGraphRefreshToken({
    visibleMode: "desktop:graph",
    chatId: "chat-main",
    loadState: "loaded",
    revision: 13,
    nodeCount: 40,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
);

assert.notEqual(
  baseToken,
  buildVisibleGraphRefreshToken({
    visibleMode: "desktop:cognition",
    chatId: "chat-main",
    loadState: "loaded",
    revision: 12,
    nodeCount: 40,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
);

assert.notEqual(
  baseToken,
  buildVisibleGraphRefreshToken({
    visibleMode: "desktop:graph",
    chatId: "chat-side",
    loadState: "loaded",
    revision: 12,
    nodeCount: 40,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
);

assert.notEqual(
  baseToken,
  buildVisibleGraphRefreshToken({
    visibleMode: "desktop:graph",
    chatId: "chat-main",
    loadState: "loaded",
    revision: 12,
    nodeCount: 41,
    edgeCount: 55,
    lastProcessedSeq: 9,
  }),
);

console.log("panel-graph-refresh tests passed");
