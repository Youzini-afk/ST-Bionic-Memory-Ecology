import {
  getCurrentChatId,
  getRequestHeaders,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
} from "../../../extensions.js";

import { getSTContextSnapshot } from "./host/st-context.js";
import { createPluginRuntime } from "./src/runtime/plugin-runtime.js";
import {
  normalizeSettings,
  SETTINGS_KEY,
} from "./src/runtime/settings.js";
import { mountPanel } from "./src/ui/panel.js";

const VERSION = "9.0.0";

async function domReady() {
  if (document.readyState !== "loading") return;
  await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, {
    once: true,
  }));
}

async function bootstrap() {
  await domReady();
  await globalThis.__stBmeV9Runtime?.dispose?.();

  const settings = normalizeSettings(extension_settings[SETTINGS_KEY]);
  extension_settings[SETTINGS_KEY] = settings;
  const runtime = await createPluginRuntime({
    version: VERSION,
    settings,
    getContext,
    getCurrentChatId,
    getHostContext: getSTContextSnapshot,
    documentLike: document,
    headerProvider: getRequestHeaders,
    persistSettings(next) {
      extension_settings[SETTINGS_KEY] = next;
      saveSettingsDebounced();
    },
  });
  globalThis.__stBmeV9Runtime = runtime;
  await runtime.start();
  let unmountPanel = () => {};
  try {
    unmountPanel = mountPanel(runtime, { documentLike: document });
  } catch (error) {
    console.error("[ST-BME v9] panel failed to mount", error);
    globalThis.toastr?.warning?.("记忆核心已启动，但 BME 面板加载失败", "ST-BME v9");
  }
  const dispose = runtime.dispose.bind(runtime);
  runtime.dispose = async () => {
    unmountPanel();
    await dispose();
    if (globalThis.__stBmeV9Runtime === runtime) delete globalThis.__stBmeV9Runtime;
  };
  globalThis.addEventListener?.("pagehide", () => void runtime.dispose(), { once: true });
}

void bootstrap().catch((error) => {
  console.error("[ST-BME v9] bootstrap failed", error);
  globalThis.toastr?.error?.(error?.message || String(error), "ST-BME v9");
});
