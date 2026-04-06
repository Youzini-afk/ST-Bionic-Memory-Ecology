import { getContext as extensionGetContext } from "../../../../extensions.js";

import { buildCapabilityStatus, mergeVersionHints } from "./capabilities.js";
import { debugDebug } from "../debug-logging.js";

function resolveContextGetter(providedGetter = null) {
  if (typeof providedGetter === "function") {
    return providedGetter;
  }

  if (typeof extensionGetContext === "function") {
    return extensionGetContext;
  }

  const globalGetter = globalThis?.SillyTavern?.getContext;
  return typeof globalGetter === "function" ? globalGetter : null;
}

function detectContextMode(getContext) {
  if (typeof getContext !== "function") {
    return "unavailable";
  }

  if (getContext === extensionGetContext) {
    return "extensions-api";
  }

  return "global-api";
}

export function createContextHostFacade(options = {}) {
  const getContext = resolveContextGetter(options.getContext);
  const available = typeof getContext === "function";
  const mode = detectContextMode(getContext);

  return Object.freeze({
    available,
    mode,
    fallbackReason: available ? "" : "未检测到 getContext 宿主接口",
    versionHints: mergeVersionHints(
      {
        getter: "getContext",
        source: mode,
        sillyTavernGlobal:
          globalThis?.SillyTavern && typeof globalThis.SillyTavern === "object"
            ? "available"
            : "missing",
      },
      options.versionHints,
    ),
    getContext: (...args) => {
      if (!available) {
        return null;
      }

      try {
        return getContext(...args);
      } catch (error) {
        debugDebug(
          "[ST-BME] host-adapter/context getContext 调用失败",
          error,
        );
        return null;
      }
    },
    readContextSnapshot: (...args) => {
      if (!available) {
        return null;
      }

      try {
        const context = getContext(...args);
        return context && typeof context === "object" ? context : null;
      } catch (error) {
        debugDebug("[ST-BME] host-adapter/context 读取上下文失败", error);
        return null;
      }
    },
  });
}

export function inspectContextHostCapability(options = {}) {
  const facade = createContextHostFacade(options);
  return buildCapabilityStatus(facade);
}

export function readHostContext(options = {}) {
  return createContextHostFacade(options).readContextSnapshot();
}
