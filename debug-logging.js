const MODULE_NAME = "st_bme";
const GLOBAL_DEBUG_FLAG_KEY = "__stBmeDebugLoggingEnabled";

function resolveModuleSettings(settings = null) {
  if (settings && typeof settings === "object") {
    return settings;
  }

  const moduleSettings =
    globalThis?.extension_settings?.[MODULE_NAME] ||
    globalThis?.__p0ExtensionSettings?.[MODULE_NAME] ||
    globalThis?.SillyTavern?.getContext?.()?.extensionSettings?.[MODULE_NAME] ||
    null;
  return moduleSettings && typeof moduleSettings === "object"
    ? moduleSettings
    : null;
}

export function isDebugLoggingEnabled(settings = null) {
  if (
    settings &&
    typeof settings === "object" &&
    Object.prototype.hasOwnProperty.call(settings, "debugLoggingEnabled")
  ) {
    return Boolean(settings.debugLoggingEnabled);
  }

  if (typeof globalThis[GLOBAL_DEBUG_FLAG_KEY] === "boolean") {
    return globalThis[GLOBAL_DEBUG_FLAG_KEY];
  }

  return Boolean(resolveModuleSettings(settings)?.debugLoggingEnabled);
}

function emitDebugLog(method, args, settings = null) {
  if (!isDebugLoggingEnabled(settings)) {
    return;
  }

  const target =
    typeof console?.[method] === "function" ? console[method] : console.log;
  Reflect.apply(target, console, args);
}

export function debugLog(...args) {
  emitDebugLog("log", args);
}

export function debugInfo(...args) {
  emitDebugLog("info", args);
}

export function debugWarn(...args) {
  emitDebugLog("warn", args);
}

export function debugDebug(...args) {
  emitDebugLog("debug", args);
}
