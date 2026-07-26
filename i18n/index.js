import zhCN from "./zh-CN.js";
import enUS from "./en-US.js";

export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en-US"]);
export const DEFAULT_LOCALE = "zh-CN";
export const DEFAULT_LOCALE_MODE = "auto";

export const catalogs = Object.freeze({
  "zh-CN": zhCN,
  "en-US": enUS,
});

let localeMode = DEFAULT_LOCALE_MODE;
let resolvedLocale = DEFAULT_LOCALE;

function normalizeLocaleTag(value) {
  const tag = String(value || "").trim();
  if (!tag) return "";
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return "";
}

function getNavigatorLanguages() {
  const nav = globalThis.navigator;
  const languages = Array.isArray(nav?.languages) ? nav.languages : [];
  if (nav?.language) return [...languages, nav.language];
  return languages;
}

export function resolveLocale(mode = DEFAULT_LOCALE_MODE, options = {}) {
  const requested = String(mode || DEFAULT_LOCALE_MODE);
  if (SUPPORTED_LOCALES.includes(requested)) return requested;

  if (requested !== "auto") return DEFAULT_LOCALE;

  const hostLocale = normalizeLocaleTag(options.hostLocale);
  if (hostLocale) return hostLocale;

  const languages = Array.isArray(options.navigatorLanguages)
    ? options.navigatorLanguages
    : getNavigatorLanguages();
  for (const language of languages) {
    const locale = normalizeLocaleTag(language);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}

export function setLocale(mode = DEFAULT_LOCALE_MODE, options = {}) {
  localeMode = SUPPORTED_LOCALES.includes(mode) || mode === "auto"
    ? mode
    : DEFAULT_LOCALE_MODE;
  resolvedLocale = resolveLocale(localeMode, options);
  if (globalThis.document?.documentElement) {
    globalThis.document.documentElement.lang = resolvedLocale;
  }
  return resolvedLocale;
}

export function getLocale() {
  return resolvedLocale;
}

export function getLocaleMode() {
  return localeMode;
}

export function hasI18nKey(key, locale = resolvedLocale) {
  return Object.prototype.hasOwnProperty.call(catalogs[locale] || {}, key) ||
    Object.prototype.hasOwnProperty.call(zhCN, key);
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{\{?\s*([A-Za-z_][\w.-]*)\s*\}?\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(params || {}, name)) {
      const value = params[name];
      return value == null ? "" : String(value);
    }
    return match;
  });
}

export function t(key, params = {}, options = {}) {
  const locale = options.locale || resolvedLocale;
  const catalog = catalogs[locale] || zhCN;
  const fallbackCatalog = catalogs[DEFAULT_LOCALE] || zhCN;
  const template = Object.prototype.hasOwnProperty.call(catalog, key)
    ? catalog[key]
    : fallbackCatalog[key];
  if (template == null) {
    return options.fallback ?? key;
  }
  return interpolate(template, params);
}

function hydrateAttribute(root, selector, attributeName, setter) {
  const elements = [];
  if (root?.matches?.(selector)) elements.push(root);
  if (typeof root?.querySelectorAll === "function") {
    elements.push(...root.querySelectorAll(selector));
  }
  for (const element of elements) {
    const key = element.getAttribute?.(attributeName);
    if (!key) continue;
    setter(element, t(key));
  }
}

export function hydrateI18n(root = globalThis.document) {
  if (!root) return;
  hydrateAttribute(root, "[data-i18n]", "data-i18n", (element, value) => {
    element.textContent = value;
  });
  hydrateAttribute(root, "[data-i18n-title]", "data-i18n-title", (element, value) => {
    element.setAttribute?.("title", value);
  });
  hydrateAttribute(root, "[data-i18n-placeholder]", "data-i18n-placeholder", (element, value) => {
    element.setAttribute?.("placeholder", value);
  });
  hydrateAttribute(root, "[data-i18n-aria-label]", "data-i18n-aria-label", (element, value) => {
    element.setAttribute?.("aria-label", value);
  });
}

export function createI18nStatus({
  textKey = "",
  textParams = {},
  textFallback = "",
  metaKey = "",
  metaParams = {},
  metaFallback = "",
  level = "idle",
  extra = {},
} = {}) {
  return {
    ...extra,
    textKey,
    textParams,
    textFallback,
    metaKey,
    metaParams,
    metaFallback,
    text: textKey ? t(textKey, textParams, { fallback: textFallback }) : textFallback,
    meta: metaKey ? t(metaKey, metaParams, { fallback: metaFallback }) : metaFallback,
    level,
    updatedAt: Date.now(),
  };
}

export function formatUiStatusText(status) {
  if (typeof status === "string") return status;
  if (status?.textKey) {
    return t(status.textKey, status.textParams || {}, {
      fallback: status.textFallback ?? status.text ?? status.textKey,
    });
  }
  return status?.text ?? "";
}

export function formatUiStatusMeta(status) {
  if (typeof status === "string") return status;
  if (status?.metaKey) {
    return t(status.metaKey, status.metaParams || {}, {
      fallback: status.metaFallback ?? status.meta ?? status.metaKey,
    });
  }
  return status?.meta ?? "";
}

export function formatI18nValue(source = null, {
  keyField = "key",
  paramsField = "params",
  fallbackField = "fallback",
  fallback = "",
} = {}) {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return fallback;
  const key = String(source?.[keyField] || "").trim();
  if (!key) {
    return String(source?.[fallbackField] ?? fallback ?? "");
  }
  return t(key, source?.[paramsField] || {}, {
    fallback: source?.[fallbackField] ?? fallback ?? key,
  });
}

// Keep module import side-effect stable for non-UI tests/modules. Runtime UI
// entry points explicitly call setLocale(settings.uiLocale), where `auto` may
// resolve from the host/navigator environment.
setLocale(DEFAULT_LOCALE_MODE, { navigatorLanguages: [] });
