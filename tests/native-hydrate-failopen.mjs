import assert from "node:assert/strict";

function moduleUrl(tag) {
  return `../vendor/wasm/stbme_core.js?test=${Date.now()}-${tag}`;
}

globalThis.__stBmeDisableWasmPackArtifacts = true;
delete globalThis.__stBmeLoadRustWasmLayout;

const firstLoad = await import(moduleUrl("native-hydrate-first"));
let firstError = "";
try {
  await firstLoad.installNativeHydrateHook();
} catch (error) {
  firstError = error?.message || String(error);
}

assert.match(
  firstError,
  /native module unavailable|native hydrate builder unavailable|global-loader|Rust\/WASM artifact is not initialized/i,
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
  build_hydrate_records() {
    return {
      ok: true,
      usedNative: true,
      nodes: [],
      edges: [],
      diagnostics: {
        solver: "mock-rust-wasm",
        nodeCount: 0,
        edgeCount: 0,
        recordsNormalized: false,
      },
    };
  },
});

const retryStatus = await firstLoad.installNativeHydrateHook();
assert.equal(retryStatus.loaded, true);
assert.equal(typeof globalThis.__stBmeNativeHydrateSnapshotRecords, "function");

delete globalThis.__stBmeNativeHydrateSnapshotRecords;
delete globalThis.__stBmeLoadRustWasmLayout;
delete globalThis.__stBmeDisableWasmPackArtifacts;

console.log("native-hydrate-failopen tests passed");
