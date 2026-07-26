import assert from "node:assert/strict";

import {
  createI18nStatus,
  formatUiStatusMeta,
  formatUiStatusText,
  getLocale,
  getLocaleMode,
  hydrateI18n,
  resolveLocale,
  setLocale,
  t,
} from "../i18n/index.js";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.textContent = "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  matches(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/)?.[1];
    return Boolean(attr && this.attributes.has(attr));
  }

  querySelectorAll(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/)?.[1];
    if (!attr) return [];
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.attributes.has(attr)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

function withNavigatorLanguages(languages, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      language: languages[0] || "",
      languages,
    },
  });
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
}

assert.equal(resolveLocale("zh-CN"), "zh-CN");
assert.equal(resolveLocale("en-US"), "en-US");
assert.equal(resolveLocale("nonsense"), "zh-CN");
assert.equal(resolveLocale("auto", { navigatorLanguages: ["en-GB"] }), "en-US");
assert.equal(resolveLocale("auto", { navigatorLanguages: ["zh-Hant"] }), "zh-CN");
assert.equal(resolveLocale("auto", { hostLocale: "en-US", navigatorLanguages: ["zh-CN"] }), "en-US");
assert.equal(resolveLocale("auto", { navigatorLanguages: ["fr-FR"] }), "zh-CN");

withNavigatorLanguages(["en-AU"], () => {
  assert.equal(setLocale("auto"), "en-US");
});
assert.equal(getLocaleMode(), "auto");
assert.equal(getLocale(), "en-US");

setLocale("zh-CN");
assert.equal(t("common.save"), "保存");
assert.equal(t("notice.loading", { stage: "提取" }), "提取进行中…");
assert.equal(t("missing.key"), "missing.key");
assert.equal(t("missing.key", {}, { fallback: "兜底" }), "兜底");
assert.equal(t("recall.card.memoryCount", { count: 3 }), "记忆 3");

setLocale("en-US");
assert.equal(t("common.save"), "Save");
assert.equal(t("notice.loading", { stage: "Extraction" }), "Extraction in progress…");
assert.equal(t("recall.card.memoryCount", { count: 3 }), "3 memories");

const root = new FakeElement("section");
const text = new FakeElement("span");
text.setAttribute("data-i18n", "common.cancel");
const title = new FakeElement("button");
title.setAttribute("data-i18n-title", "common.close");
const placeholder = new FakeElement("input");
placeholder.setAttribute("data-i18n-placeholder", "common.loading");
const aria = new FakeElement("button");
aria.setAttribute("data-i18n-aria-label", "common.delete");
root.appendChild(text);
root.appendChild(title);
root.appendChild(placeholder);
root.appendChild(aria);

hydrateI18n(root);
assert.equal(text.textContent, "Cancel");
assert.equal(title.getAttribute("title"), "Close");
assert.equal(placeholder.getAttribute("placeholder"), "Loading…");
assert.equal(aria.getAttribute("aria-label"), "Delete");

setLocale("zh-CN");
hydrateI18n(root);
assert.equal(text.textContent, "取消");
assert.equal(title.getAttribute("title"), "关闭");

const status = createI18nStatus({
  textKey: "status.idle",
  textFallback: "待命",
  metaKey: "status.initial.runtime.detail",
  metaFallback: "准备就绪",
  level: "idle",
});
assert.equal(formatUiStatusText(status), "待命");
assert.equal(formatUiStatusMeta(status), "准备就绪");
setLocale("en-US");
assert.equal(formatUiStatusText(status), "Idle");
assert.equal(formatUiStatusMeta(status), "Ready");
assert.equal(formatUiStatusText({ text: "legacy" }), "legacy");

console.log("i18n DOM/runtime tests passed");
