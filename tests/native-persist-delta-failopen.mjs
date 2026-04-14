import assert from "node:assert/strict";

function moduleUrl(tag) {
  return `../vendor/wasm/stbme_core.js?test=${Date.now()}-${tag}`;
}

globalThis.__stBmeDisableWasmPackArtifacts = true;
delete globalThis.__stBmeLoadRustWasmLayout;

const firstLoad = await import(moduleUrl("native-persist-first"));
let firstError = "";
try {
  await firstLoad.installNativePersistDeltaHook();
} catch (error) {
  firstError = error?.message || String(error);
}

assert.match(
  firstError,
  /native module unavailable|native persist delta builder unavailable|global-loader|Rust\/WASM artifact is not initialized/i,
);

globalThis.__stBmeLoadRustWasmLayout = async () => ({
  solve_layout() {
    return {
      ok: true,
      positions: [],
      diagnostics: {
        solver: "mock-rust-wasm",
      },
    };
  },
  build_persist_delta() {
    return {
      upsertNodes: [],
      upsertEdges: [],
      deleteNodeIds: [],
      deleteEdgeIds: [],
      tombstones: [],
      runtimeMetaPatch: {},
    };
  },
});

const retryStatus = await firstLoad.installNativePersistDeltaHook();
assert.equal(retryStatus.loaded, true);
assert.equal(typeof globalThis.__stBmeNativeBuildPersistDelta, "function");

delete globalThis.__stBmeNativeBuildPersistDelta;
delete globalThis.__stBmeLoadRustWasmLayout;
delete globalThis.__stBmeDisableWasmPackArtifacts;

console.log("native-persist-delta-failopen tests passed");
