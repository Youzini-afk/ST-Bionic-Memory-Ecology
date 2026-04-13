import assert from "node:assert/strict";

function importFreshWrapper(tag = "default") {
  return import(`../vendor/wasm/stbme_core.js?test=${Date.now()}-${tag}`);
}

const originalLoader = globalThis.__stBmeLoadRustWasmLayout;

try {
  globalThis.__stBmeDisableWasmPackArtifacts = true;
  globalThis.__stBmeLoadRustWasmLayout = async () => ({
    solve_layout(payload = {}) {
      const nodeCount = Array.isArray(payload?.nodes) ? payload.nodes.length : 0;
      return {
        ok: true,
        positions: [1, 2, 3, 4],
        diagnostics: {
          solver: "mock-loader",
          nodeCount,
          edgeCount: 0,
          iterations: 1,
        },
      };
    },
    build_persist_delta_compact(payload = {}) {
      return {
        upsertNodeIds: Array.isArray(payload?.afterNodes?.ids)
          ? payload.afterNodes.ids.slice(0, 1)
          : [],
        upsertEdgeIds: [],
        deleteNodeIds: [],
        deleteEdgeIds: [],
        upsertTombstoneIds: [],
      };
    },
    build_persist_delta_compact_hash(payload = {}) {
      return {
        upsertNodeIds: Array.isArray(payload?.afterNodes?.ids)
          ? payload.afterNodes.ids.slice(0, 1)
          : [],
        upsertEdgeIds: [],
        deleteNodeIds: [],
        deleteEdgeIds: [],
        upsertTombstoneIds: [],
      };
    },
    build_persist_delta(payload = {}) {
      return {
        upsertNodes: [{ id: "persist-native-node", marker: payload?.afterSnapshot?.meta?.chatId || "" }],
        upsertEdges: [],
        deleteNodeIds: [],
        deleteEdgeIds: [],
        tombstones: [],
        runtimeMetaPatch: { native: true },
      };
    },
  });

  const wrapper = await importFreshWrapper("global-loader");
  const result = await wrapper.solveLayout({ nodes: [{}, {}], edges: [] });
  assert.equal(result.ok, true);
  assert.equal(result.usedNative, true);
  assert.ok(result.positions instanceof Float32Array);
  assert.deepEqual(Array.from(result.positions), [1, 2, 3, 4]);
  assert.equal(result.diagnostics.solver, "mock-loader");

  const status = wrapper.getNativeModuleStatus();
  assert.equal(status.loaded, true);
  assert.equal(status.source, "global-loader");

  const installStatus = await wrapper.installNativePersistDeltaHook();
  assert.equal(installStatus.loaded, true);
  assert.equal(typeof globalThis.__stBmeNativeBuildPersistDelta, "function");
  const compactDeltaResult = globalThis.__stBmeNativeBuildPersistDelta(
    { meta: { chatId: "before-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    { meta: { chatId: "after-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    {
      nowMs: 123,
      preparedDeltaInput: {
        bridgeMode: "json",
        afterNodes: { ids: ["persist-native-node"], serialized: ["{}"] },
      },
    },
  );
  assert.deepEqual(compactDeltaResult.upsertNodeIds, ["persist-native-node"]);

  const hashCompactDeltaResult = globalThis.__stBmeNativeBuildPersistDelta(
    { meta: { chatId: "before-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    { meta: { chatId: "after-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    {
      nowMs: 123,
      preparedDeltaInput: {
        bridgeMode: "hash",
        afterNodes: { ids: ["persist-native-node"], hashes: [1] },
      },
    },
  );
  assert.deepEqual(hashCompactDeltaResult.upsertNodeIds, ["persist-native-node"]);

  const deltaResult = globalThis.__stBmeNativeBuildPersistDelta(
    { meta: { chatId: "before-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    { meta: { chatId: "after-chat" }, nodes: [], edges: [], tombstones: [], state: {} },
    { nowMs: 123 },
  );
  assert.deepEqual(deltaResult.upsertNodes, [{ id: "persist-native-node", marker: "after-chat" }]);
  assert.equal(deltaResult.runtimeMetaPatch.native, true);

  delete globalThis.__stBmeLoadRustWasmLayout;
  delete globalThis.__stBmeNativeBuildPersistDelta;
  delete globalThis.__stBmeDisableWasmPackArtifacts;

  const wrapperNoLoader = await importFreshWrapper("no-loader");
  let rejected = false;
  try {
    const resultNoLoader = await wrapperNoLoader.solveLayout({
      nodes: [{ x: 0, y: 0, vx: 0, vy: 0, pinned: false, radius: 8, regionKey: "objective", regionRect: { x: 0, y: 0, w: 200, h: 120 } }],
      edges: [],
    });
    assert.equal(resultNoLoader.ok, true);
    assert.equal(resultNoLoader.usedNative, true);
    const statusNoLoader = wrapperNoLoader.getNativeModuleStatus();
    assert.equal(statusNoLoader.loaded, true);
    assert.equal(statusNoLoader.source, "wasm-pack-artifact");
  } catch (error) {
    rejected = true;
    assert.match(
      String(error?.message || ""),
      /Rust\/WASM artifact is not initialized|native module unavailable|wasm-pack load error/i,
    );
  }
} finally {
  if (typeof originalLoader === "function") {
    globalThis.__stBmeLoadRustWasmLayout = originalLoader;
  } else {
    delete globalThis.__stBmeLoadRustWasmLayout;
  }
  delete globalThis.__stBmeDisableWasmPackArtifacts;
  delete globalThis.__stBmeNativeBuildPersistDelta;
}

console.log("native-layout-wrapper tests passed");
