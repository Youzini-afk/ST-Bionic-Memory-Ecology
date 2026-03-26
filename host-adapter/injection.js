import { buildCapabilityStatus, mergeVersionHints } from "./capabilities.js";
import { createContextHostFacade } from "./context.js";

function resolvePromptSetter(providedSetter = null, contextHost = null) {
  if (typeof providedSetter === "function") {
    return {
      setter: providedSetter,
      source: "provided",
    };
  }

  const context = contextHost?.readContextSnapshot?.();
  if (typeof context?.setExtensionPrompt === "function") {
    return {
      setter: context.setExtensionPrompt.bind(context),
      source: "context",
    };
  }

  return {
    setter: null,
    source: contextHost?.available ? "context-missing-setter" : "unavailable",
  };
}

function detectInjectionMode(setterRecord, contextHost) {
  if (typeof setterRecord?.setter === "function") {
    return setterRecord.source === "provided"
      ? "provided-setter"
      : "context-extension-prompt";
  }

  if (contextHost?.available) {
    return "context-without-extension-prompt";
  }

  return "unavailable";
}

export function createInjectionHostFacade(options = {}) {
  const contextHost = options.contextHost || createContextHostFacade(options);
  const setterRecord = resolvePromptSetter(
    options.setExtensionPrompt,
    contextHost,
  );
  const available = typeof setterRecord.setter === "function";
  const mode = detectInjectionMode(setterRecord, contextHost);

  return Object.freeze({
    available,
    mode,
    fallbackReason: available
      ? ""
      : contextHost?.available
        ? "当前上下文未暴露 setExtensionPrompt 接口"
        : "未检测到可用注入宿主接口",
    versionHints: mergeVersionHints(
      {
        setter: "setExtensionPrompt",
        source: setterRecord.source,
        contextMode: contextHost?.mode || "unknown",
      },
      options.versionHints,
    ),
    setExtensionPrompt: (...args) => {
      const liveSetterRecord = resolvePromptSetter(
        options.setExtensionPrompt,
        contextHost,
      );
      if (typeof liveSetterRecord.setter !== "function") {
        return false;
      }

      try {
        liveSetterRecord.setter(...args);
        return true;
      } catch (error) {
        console.debug(
          "[ST-BME] host-adapter/injection setExtensionPrompt 调用失败",
          error,
        );
        return false;
      }
    },
    readInjectionSupport: () => {
      const liveSetterRecord = resolvePromptSetter(
        options.setExtensionPrompt,
        contextHost,
      );
      return Object.freeze({
        available: typeof liveSetterRecord.setter === "function",
        mode: detectInjectionMode(liveSetterRecord, contextHost),
        source: liveSetterRecord.source,
      });
    },
  });
}

export function inspectInjectionHostCapability(options = {}) {
  const facade = createInjectionHostFacade(options);
  return buildCapabilityStatus(facade);
}
