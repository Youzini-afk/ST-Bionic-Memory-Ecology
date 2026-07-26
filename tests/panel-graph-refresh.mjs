import assert from "node:assert/strict";

import {
  buildGraphStructureFingerprint,
  buildVisibleGraphRefreshToken,
  classifyGraphRefresh,
  createGraphRefreshGovernor,
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

assert.equal(buildGraphStructureFingerprint(null), "empty");

const orderedFingerprint = buildGraphStructureFingerprint({
  nodes: [{ id: "b" }, { id: "a" }, { id: "c" }],
  edges: [
    { from: "b", to: "c", relation: "supports" },
    { fromId: "a", toId: "b", type: "causes" },
  ],
});

const reorderedFingerprint = buildGraphStructureFingerprint({
  edges: [
    { toId: "b", fromId: "a", type: "causes" },
    { to: "c", from: "b", relation: "supports" },
  ],
  nodes: [{ id: "c" }, { id: "a" }, { id: "b" }],
});

assert.equal(orderedFingerprint, reorderedFingerprint);
assert.match(orderedFingerprint, /^nodes:3:[a-z0-9]+\|edges:2:[a-z0-9]+$/);

assert.equal(
  buildGraphStructureFingerprint({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b", relation: "valid" }],
  }),
  buildGraphStructureFingerprint({
    nodes: [
      { id: "a" },
      { id: "b" },
      { id: "archived", archived: true },
      { id: "archivedAt", archivedAt: 123 },
    ],
    edges: [
      { from: "a", to: "b", relation: "valid" },
      { from: "a", to: "b", relation: "invalid", invalidAt: 123 },
      { from: "a", to: "b", relation: "expired", expiredAt: 123 },
      { from: "a", to: "missing", relation: "missing-endpoint" },
      { from: "archived", to: "a", relation: "archived-endpoint" },
    ],
  }),
);

const fingerprintA = buildGraphStructureFingerprint({
  nodes: [{ id: "a" }, { id: "b" }],
  edges: [{ from: "a", to: "b", relation: "valid" }],
});
const fingerprintB = buildGraphStructureFingerprint({
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  edges: [{ from: "a", to: "b", relation: "valid" }],
});

assert.deepEqual(
  classifyGraphRefresh({
    previousToken: "desktop:graph|chat|loaded|1|2|1|1",
    nextToken: "desktop:graph|chat|loaded|2|2|1|1",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintA,
    visibleMode: "desktop:graph",
  }),
  {
    action: "highlight-only",
    reason: "token-changed",
    tokenChanged: true,
    structureChanged: false,
    force: false,
    final: false,
    hard: false,
  },
);

assert.equal(
  classifyGraphRefresh({
    previousToken: "same",
    nextToken: "same",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintB,
    visibleMode: "desktop:graph",
  }).action,
  "refresh",
);

assert.equal(
  classifyGraphRefresh({
    previousToken: "same",
    nextToken: "same",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintA,
    visibleMode: "desktop:graph",
  }).action,
  "skip",
);

assert.equal(
  classifyGraphRefresh({
    previousToken: "same",
    nextToken: "same",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintB,
    hard: true,
    final: true,
    visibleMode: "desktop:graph",
  }).action,
  "hard-refresh",
);

assert.equal(
  classifyGraphRefresh({
    previousToken: "same",
    nextToken: "same",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintB,
    final: true,
    visibleMode: "desktop:graph",
  }).action,
  "final-refresh",
);

assert.equal(
  classifyGraphRefresh({
    previousToken: "same",
    nextToken: "hidden",
    previousFingerprint: fingerprintA,
    nextFingerprint: fingerprintB,
    hard: true,
    final: true,
    visibleMode: "hidden",
  }).action,
  "hidden",
);

let currentTime = 1000;
const governor = createGraphRefreshGovernor({
  liveThrottleMs: 240,
  extractionThrottleMs: 700,
  layoutRestartWindowMs: 5000,
  layoutRestartMax: 2,
  layoutCooldownMs: 9000,
  now: () => currentTime,
});

assert.deepEqual(
  governor.noteRefresh({
    nextToken: "token-1",
    nextFingerprint: fingerprintA,
    force: true,
    isExtracting: true,
    visibleMode: "desktop:graph",
  }),
  {
    shouldRefresh: true,
    shouldLayout: true,
    action: "refresh",
    delayMs: 700,
    reason: "structure-changed",
    coalescedCount: 1,
    cooldownUntil: 0,
  },
);

currentTime = 1100;
assert.deepEqual(
  governor.noteRefresh({
    nextToken: "token-2",
    nextFingerprint: fingerprintA,
    isExtracting: false,
    visibleMode: "desktop:graph",
  }),
  {
    shouldRefresh: true,
    shouldLayout: false,
    action: "highlight-only",
    delayMs: 240,
    reason: "token-changed",
    coalescedCount: 2,
    cooldownUntil: 0,
  },
);

const layoutGovernor = createGraphRefreshGovernor({
  layoutRestartWindowMs: 5000,
  layoutRestartMax: 2,
  layoutCooldownMs: 9000,
  now: () => currentTime,
});

currentTime = 2000;
assert.deepEqual(layoutGovernor.canStartLayout(), {
  allowed: true,
  reason: "allowed",
  cooldownUntil: 0,
});

currentTime = 2500;
assert.deepEqual(layoutGovernor.canStartLayout(), {
  allowed: true,
  reason: "allowed",
  cooldownUntil: 0,
});

currentTime = 3000;
assert.deepEqual(layoutGovernor.canStartLayout(), {
  allowed: false,
  reason: "budget-exhausted",
  cooldownUntil: 12000,
});

currentTime = 4000;
assert.deepEqual(layoutGovernor.canStartLayout(), {
  allowed: false,
  reason: "cooldown",
  cooldownUntil: 12000,
});

currentTime = 12000;
assert.deepEqual(layoutGovernor.canStartLayout(), {
  allowed: true,
  reason: "allowed",
  cooldownUntil: 12000,
});

console.log("panel-graph-refresh tests passed");
