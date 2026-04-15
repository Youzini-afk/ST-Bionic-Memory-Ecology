import assert from "node:assert/strict";

import {
  getBmeHostAdapter,
  isBmeLightweightHostMode,
  normalizeBmeChatStateTarget,
  resolveBmeHostProfile,
  resolveCurrentBmeChatStateTarget,
  resolveChatStateTargetChatId,
  serializeBmeChatStateTarget,
} from "../host/runtime-host-adapter.js";

const originalNavigator = globalThis.navigator;
const originalLuker = globalThis.Luker;

try {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Mobile Safari/537.36",
    },
  });

  const context = {
    groupId: "group-1",
    chatId: "group-1",
    getChatState() {},
    updateChatState() {},
    getChatStateBatch() {},
  };
  globalThis.Luker = {
    getContext() {
      return context;
    },
  };

  assert.equal(resolveBmeHostProfile(context), "luker");
  assert.equal(isBmeLightweightHostMode(context), true);

  const target = resolveCurrentBmeChatStateTarget(context);
  assert.deepEqual(target, {
    is_group: true,
    id: "group-1",
  });
  assert.equal(resolveChatStateTargetChatId(target), "group-1");
  assert.equal(serializeBmeChatStateTarget(target), "group:group-1");

  const characterContext = {
    chatId: "chat-char-1",
    characterId: "char-1",
    characters: {
      "char-1": {
        avatar: "alice.png",
      },
    },
    getChatState() {},
    updateChatState() {},
    getChatStateBatch() {},
  };
  globalThis.Luker = {
    getContext() {
      return characterContext;
    },
  };
  const adapter = getBmeHostAdapter(characterContext);
  const explicitTarget = normalizeBmeChatStateTarget({
    is_group: false,
    avatar_url: "alice.png",
    file_name: "chat-char-branch",
  });

  let recordedTarget = null;
  characterContext.updateChatState = async function(namespace, updater, options = {}) {
    recordedTarget = options?.target ?? null;
    return { ok: true, updated: true, state: await updater({}) };
  };

  await adapter.updateChatState("st_bme_graph_manifest", () => ({ ok: true }), {
    target: explicitTarget,
  });
  assert.deepEqual(recordedTarget, explicitTarget);
} finally {
  if (originalNavigator === undefined) {
    delete globalThis.navigator;
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }

  if (originalLuker === undefined) {
    delete globalThis.Luker;
  } else {
    globalThis.Luker = originalLuker;
  }
}

console.log("luker-host-adapter tests passed");
