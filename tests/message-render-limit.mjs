import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");
const indexSource = await fs.readFile(indexPath, "utf8");

function extractSnippet(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`无法提取 index.js 片段: ${startMarker} -> ${endMarker}`);
  }
  return indexSource.slice(start, end).replace(/^export\s+/gm, "");
}

const renderLimitSnippet = extractSnippet(
  "function getMessageRenderLimitSettings(",
  "function getHideRuntimeAdapters(",
);

const tempModulePath = path.resolve(
  moduleDir,
  "../.tmp-message-render-limit.mjs",
);

await fs.writeFile(
  tempModulePath,
  `
let powerUser = { chat_truncation: 0 };
let reloadCount = 0;
let inputValue = "";
let counterValue = "";
let currentGraph = null;
const triggeredEvents = [];

function getContext() {
  return {
    power_user: powerUser,
    reloadCurrentChat() {
      reloadCount += 1;
    },
  };
}

function makeInput(kind) {
  return {
    length: 1,
    val(value) {
      if (arguments.length > 0) {
        if (kind === "counter") {
          counterValue = value;
        } else {
          inputValue = value;
        }
        return this;
      }
      return kind === "counter" ? counterValue : inputValue;
    },
    trigger(eventName) {
      triggeredEvents.push(eventName);
      return this;
    },
  };
}

function $(selector) {
  if (selector === "#chat_truncation") return makeInput("input");
  if (selector === "#chat_truncation_counter") return makeInput("counter");
  return { length: 0 };
}

${renderLimitSnippet}

function getState() {
  return {
    counterValue,
    inputValue,
    powerUserChatTruncation: powerUser.chat_truncation,
    reloadCount,
    triggeredEvents: [...triggeredEvents],
  };
}

function setCurrentGraph(graph) {
  currentGraph = graph;
}

export {
  applyMessageRenderLimit,
  getRenderLimitedHistoryRecoveryGuard,
  getMessageRenderLimitSettings,
  getState,
  setCurrentGraph,
};
`,
  "utf8",
);

try {
  const module = await import(`${pathToFileURL(tempModulePath).href}?t=${Date.now()}`);

  assert.deepEqual(
    module.getMessageRenderLimitSettings({
      enabled: true,
      hideOldMessagesRenderLimitEnabled: true,
      hideOldMessagesRenderLimit: "24",
    }),
    { enabled: true, render_last_n: 24 },
  );
  assert.deepEqual(
    module.getMessageRenderLimitSettings({
      enabled: false,
      hideOldMessagesRenderLimitEnabled: true,
      hideOldMessagesRenderLimit: 24,
    }),
    { enabled: false, render_last_n: 24 },
  );

  const applied = module.applyMessageRenderLimit(
    {
      enabled: true,
      hideOldMessagesRenderLimitEnabled: true,
      hideOldMessagesRenderLimit: 24,
    },
    { reloadCurrentChat: true },
  );
  assert.deepEqual(applied, {
    active: true,
    renderLimit: 24,
    applied: true,
    skipped: false,
  });
  assert.deepEqual(module.getState(), {
    counterValue: "24",
    inputValue: "24",
    powerUserChatTruncation: 24,
    reloadCount: 1,
    triggeredEvents: ["change"],
  });
  const guarded = module.getRenderLimitedHistoryRecoveryGuard(
    new Array(10).fill({ mes: "visible" }),
    {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 30,
        processedMessageHashes: { 0: "a", 30: "b" },
      },
    },
  );
  assert.equal(guarded.blocked, true);
  assert.equal(guarded.renderLimit, 10);
  assert.equal(guarded.highestProcessedFloor, 30);

  const notGuardedWhenFullerThanRenderWindow =
    module.getRenderLimitedHistoryRecoveryGuard(new Array(20).fill({}), {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 30,
        processedMessageHashes: { 30: "b" },
      },
    });
  assert.equal(notGuardedWhenFullerThanRenderWindow.blocked, false);

  const notGuardedWhenHistoryFitsVisibleChat =
    module.getRenderLimitedHistoryRecoveryGuard(new Array(10).fill({}), {
      settings: {
        enabled: true,
        hideOldMessagesRenderLimitEnabled: true,
        hideOldMessagesRenderLimit: 10,
      },
      historyState: {
        lastProcessedAssistantFloor: 5,
        processedMessageHashes: { 5: "b" },
      },
    });
  assert.equal(notGuardedWhenHistoryFitsVisibleChat.blocked, false);

  const skipped = module.applyMessageRenderLimit({
    enabled: true,
    hideOldMessagesRenderLimitEnabled: false,
    hideOldMessagesRenderLimit: 24,
  });
  assert.equal(skipped.skipped, true);
  assert.equal(module.getState().powerUserChatTruncation, 24);

  const cleared = module.applyMessageRenderLimit(
    {
      enabled: true,
      hideOldMessagesRenderLimitEnabled: false,
      hideOldMessagesRenderLimit: 24,
    },
    { clearWhenDisabled: true, reloadCurrentChat: true },
  );
  assert.deepEqual(cleared, {
    active: false,
    renderLimit: 0,
    applied: true,
    skipped: false,
  });
  assert.deepEqual(module.getState(), {
    counterValue: "0",
    inputValue: "0",
    powerUserChatTruncation: 0,
    reloadCount: 2,
    triggeredEvents: ["change", "change"],
  });
} finally {
  await fs.unlink(tempModulePath).catch(() => {});
}
