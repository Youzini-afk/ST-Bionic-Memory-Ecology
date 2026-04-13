let cachedNativeModule = null;
let triedLoad = false;
let loadError = null;
let moduleSource = "none";

async function resolveWasmModuleInput(wasmUrl) {
  if (
    wasmUrl &&
    typeof wasmUrl === "object" &&
    wasmUrl.protocol === "file:" &&
    typeof process === "object" &&
    process?.versions?.node
  ) {
    const { readFile } = await import("node:fs/promises");
    return readFile(wasmUrl);
  }
  return wasmUrl;
}

async function initializeWasmModule(initFn, wasmUrl) {
  if (typeof initFn !== "function") {
    return;
  }

  const moduleInput = await resolveWasmModuleInput(wasmUrl);

  try {
    await initFn({ module_or_path: moduleInput });
  } catch (error) {
    if (
      error &&
      typeof error.message === "string" &&
      /module_or_path|unexpected|invalid/i.test(error.message)
    ) {
      await initFn(moduleInput);
      return;
    }
    throw error;
  }
}

async function loadFromWasmPackArtifacts() {
  const module = await import("./pkg/stbme_core_pkg.js");
  if (!module || typeof module.solve_layout !== "function") {
    throw new Error("invalid wasm-pack module shape");
  }

  const wasmUrl = new URL("./pkg/stbme_core_pkg_bg.wasm", import.meta.url);
  if (typeof module.default === "function") {
    await initializeWasmModule(module.default, wasmUrl);
  } else if (typeof module.__wbg_init === "function") {
    await initializeWasmModule(module.__wbg_init, wasmUrl);
  }

  return {
    solve_layout: module.solve_layout,
    build_persist_delta_compact:
      typeof module.build_persist_delta_compact === "function"
        ? module.build_persist_delta_compact
        : null,
    build_persist_delta:
      typeof module.build_persist_delta === "function"
        ? module.build_persist_delta
        : null,
  };
}

async function loadNativeModule() {
  if (cachedNativeModule) return cachedNativeModule;
  if (triedLoad) {
    throw loadError || new Error("stbme_core native module unavailable");
  }

  triedLoad = true;

  let wasmPackError = null;
  if (globalThis.__stBmeDisableWasmPackArtifacts !== true) {
    try {
      const wasmPackModule = await loadFromWasmPackArtifacts();
      cachedNativeModule = wasmPackModule;
      moduleSource = "wasm-pack-artifact";
      return cachedNativeModule;
    } catch (error) {
      wasmPackError = error instanceof Error ? error : new Error(String(error));
    }
  } else {
    wasmPackError = new Error("wasm-pack artifact loading disabled");
  }

  if (typeof globalThis.__stBmeLoadRustWasmLayout === "function") {
    try {
      const module = await globalThis.__stBmeLoadRustWasmLayout();
      if (module && typeof module.solve_layout === "function") {
        cachedNativeModule = module;
        moduleSource = "global-loader";
        return cachedNativeModule;
      }
      loadError = new Error("invalid native module shape");
      throw loadError;
    } catch (error) {
      loadError = error instanceof Error ? error : new Error(String(error));
      throw loadError;
    }
  }

  loadError = new Error(
    [
      "Rust/WASM artifact is not initialized",
      wasmPackError ? `wasm-pack load error: ${wasmPackError.message}` : "",
      "define globalThis.__stBmeLoadRustWasmLayout for fallback injection",
    ]
      .filter(Boolean)
      .join("; "),
  );
  throw loadError;
}

function toFloat32Array(value) {
  if (value instanceof Float32Array) return value;
  if (!Array.isArray(value)) return new Float32Array(0);
  return Float32Array.from(value.map((item) => Number(item) || 0));
}

export async function solveLayout(payload) {
  const module = await loadNativeModule();
  const raw = await module.solve_layout(payload);
  const normalizedResult = raw && typeof raw === "object" ? raw : {};
  const positions = toFloat32Array(normalizedResult.positions);
  return {
    ok: normalizedResult.ok === true,
    usedNative: true,
    positions,
    diagnostics:
      normalizedResult.diagnostics &&
      typeof normalizedResult.diagnostics === "object"
        ? normalizedResult.diagnostics
        : {
            solver: "rust-wasm",
            nodeCount: Math.floor(positions.length / 2),
            edgeCount: 0,
            iterations: 0,
          },
  };
}

export async function installNativePersistDeltaHook() {
  const module = await loadNativeModule();
  if (
    !module ||
    (typeof module.build_persist_delta_compact !== "function" &&
      typeof module.build_persist_delta !== "function")
  ) {
    throw new Error("native persist delta builder unavailable");
  }

  globalThis.__stBmeNativeBuildPersistDelta = (beforeSnapshot, afterSnapshot, options = {}) => {
    let raw = null;
    if (
      typeof module.build_persist_delta_compact === "function" &&
      options?.preparedDeltaInput &&
      typeof options.preparedDeltaInput === "object"
    ) {
      raw = module.build_persist_delta_compact(options.preparedDeltaInput);
    } else if (typeof module.build_persist_delta === "function") {
      raw = module.build_persist_delta({
        beforeSnapshot,
        afterSnapshot,
        nowMs: options?.nowMs,
      });
    }
    return raw && typeof raw === "object" ? raw : null;
  };

  return getNativeModuleStatus();
}

export function getNativeModuleStatus() {
  return {
    loaded: Boolean(cachedNativeModule),
    attempted: triedLoad,
    source: moduleSource,
    error: loadError?.message || "",
  };
}
