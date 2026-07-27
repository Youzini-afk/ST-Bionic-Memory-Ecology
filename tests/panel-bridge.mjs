import assert from "node:assert/strict";

let timerId = 0;
const timers = new Map();
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};

function runNextTimer() {
  const [id, timer] = timers.entries().next().value || [];
  if (!id) return false;
  timers.delete(id);
  timer.callback();
  return true;
}

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
    this._id = "";
  }

  set id(value) {
    if (this._id) this.ownerDocument.unregisterId(this._id, this);
    this._id = String(value || "");
    if (this._id) this.ownerDocument.registerId(this._id, this);
  }

  get id() {
    return this._id;
  }

  setAttribute(name, value) {
    if (name === "id") this.id = value;
    else if (name === "class") this.className = String(value || "");
    else this[name] = String(value || "");
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) this.ownerDocument.registerId(child.id, child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    if (child.id) this.ownerDocument.registerId(child.id, child);
    return child;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async click() {
    for (const listener of this.listeners.get("click") || []) {
      await listener({ target: this });
    }
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
  }

  registerId(id, element) {
    this.byId.set(id, element);
  }

  unregisterId(id, element) {
    if (this.byId.get(id) === element) this.byId.delete(id);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  querySelector(selector) {
    if (selector === "#options .options-content") {
      const options = this.getElementById("options");
      return options?.children.find((child) => String(child.className || "").split(/\s+/).includes("options-content")) || null;
    }
    return null;
  }
}

function appendElement(document, parent, tagName, { id, className, style } = {}) {
  const element = document.createElement(tagName);
  if (id) element.id = id;
  if (className) element.className = className;
  if (style) Object.assign(element.style, style);
  parent.appendChild(element);
  return element;
}

function buildDocument({ includeExtensionsMenu = true, includePanel = true } = {}) {
  const document = new FakeDocument();
  if (includePanel) {
    const overlay = appendElement(document, document.body, "div", { id: "st-bme-panel-overlay" });
    appendElement(document, overlay, "div", { id: "st-bme-panel" });
  }
  const options = appendElement(document, document.body, "div", { id: "options" });
  const optionsContent = appendElement(document, options, "div", { className: "options-content" });
  appendElement(document, optionsContent, "a", { id: "option_toggle_logprobs" });
  if (includeExtensionsMenu) {
    appendElement(document, document.body, "div", { id: "extensionsMenuButton", style: { display: "none" } });
    appendElement(document, document.body, "div", { id: "extensionsMenu", className: "options-content" });
  }
  return document;
}

function buildRuntime(document, initialSettings = {}) {
  let settings = { ...initialSettings };
  const calls = { opened: 0, hidden: [], css: [] };
  const panelModule = {
    openPanel: () => { calls.opened += 1; },
    updatePanelLocale: (localeMode) => { calls.updatedLocale = localeMode; },
  };
  return {
    calls,
    console,
    document,
    getPanelModule: () => panelModule,
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    $: (selector) => ({
      hide: () => calls.hidden.push(selector),
      css: (name, value) => calls.css.push([selector, name, value]),
    }),
  };
}

function buildColdRuntime(document, { failFirstInit = false } = {}) {
  let panelModule;
  let themesModule;
  let settings = {};
  const calls = { importedPanel: 0, importedThemes: 0, initialized: 0, opened: 0 };
  const importedPanelModule = {
    openPanel: () => { calls.opened += 1; },
    initPanel: async () => {
      calls.initialized += 1;
      if (!document.getElementById("st-bme-panel-overlay")) {
        const overlay = appendElement(document, document.body, "div", { id: "st-bme-panel-overlay" });
        appendElement(document, overlay, "div", { id: "st-bme-panel" });
      }
      if (failFirstInit && calls.initialized === 1) throw new Error("init failed");
    },
  };
  const importedThemesModule = { applyTheme: () => {} };
  return {
    calls,
    console: failFirstInit ? { error() {}, warn() {} } : console,
    document,
    getPanelModule: () => panelModule,
    getThemesModule: () => themesModule,
    setPanelModule: (value) => { panelModule = value; },
    setThemesModule: (value) => { themesModule = value; },
    importPanelModule: async () => {
      calls.importedPanel += 1;
      return importedPanelModule;
    },
    importThemesModule: async () => {
      calls.importedThemes += 1;
      return importedThemesModule;
    },
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    $: () => ({ hide: () => {}, css: () => {} }),
  };
}

const { initializePanelBridgeController } = await import("../ui/panel-bridge.js");

{
  const document = buildDocument();
  const runtime = buildRuntime(document);

  await initializePanelBridgeController(runtime);

  const optionsEntry = document.getElementById("option_st_bme_panel");
  const wandEntry = document.getElementById("st_bme_extensions_menu_entry");
  assert.ok(optionsEntry, "legacy options menu entry is injected");
  assert.ok(wandEntry, "magic-wand extensions menu entry is injected");
  assert.equal(document.getElementById("extensionsMenuButton")?.style.display, "flex", "magic-wand button is shown after BME entry injection");
  assert.equal(timers.size, 0, "no retry remains when both menu targets are ready");

  await wandEntry.click();
  assert.equal(runtime.calls.opened, 1, "magic-wand entry opens BME panel");
  assert.ok(runtime.calls.hidden.includes("#extensionsMenu"), "magic-wand entry closes extensions menu");

  const fab = document.getElementById("bme-floating-ball");
  await fab.click();
  assert.equal(runtime.calls.opened, 2, "bootstrap FAB opens the panel before panel pointer handling takes over");
  fab.dataset.bmeFabBound = "true";
  await fab.click();
  assert.equal(runtime.calls.opened, 2, "bridge FAB click stands down after panel pointer handling takes over");
}

{
  const document = buildDocument();
  const runtime = buildRuntime(document, { uiLocale: "en-US" });

  await initializePanelBridgeController(runtime);
  const optionsEntry = document.getElementById("option_st_bme_panel");
  const wandEntry = document.getElementById("st_bme_extensions_menu_entry");
  const fab = document.getElementById("bme-floating-ball");

  assert.match(optionsEntry.innerHTML, /Memory Graph/, "legacy menu entry follows English locale");
  assert.match(wandEntry.innerHTML, /Memory Graph/, "magic-wand entry follows English locale");
  assert.match(fab.innerHTML, /BME Memory Graph/, "floating bootstrap follows English locale");

  runtime.updateSettings({ uiLocale: "zh-CN" });
  await initializePanelBridgeController(runtime);
  assert.match(optionsEntry.innerHTML, /记忆图谱/, "legacy menu entry refreshes when locale changes");
  assert.match(wandEntry.innerHTML, /记忆图谱/, "magic-wand entry refreshes when locale changes");
  assert.match(fab.innerHTML, /BME 记忆图谱/, "floating bootstrap refreshes when locale changes");
}

{
  const document = buildDocument({ includePanel: false });
  const runtime = buildColdRuntime(document);

  await Promise.all([
    initializePanelBridgeController(runtime),
    initializePanelBridgeController(runtime),
  ]);

  assert.equal(runtime.calls.importedPanel, 1, "concurrent bridge callers share one panel import");
  assert.equal(runtime.calls.importedThemes, 1, "concurrent bridge callers share one theme import");
  assert.equal(runtime.calls.initialized, 1, "concurrent bridge callers share one panel initialization");
}

{
  const runtimeA = buildColdRuntime(buildDocument({ includePanel: false }));
  const runtimeB = buildColdRuntime(buildDocument({ includePanel: false }));

  await Promise.all([
    initializePanelBridgeController(runtimeA),
    initializePanelBridgeController(runtimeB),
  ]);

  assert.equal(runtimeA.calls.initialized, 1, "runtime A owns its panel initialization");
  assert.equal(runtimeB.calls.initialized, 1, "runtime B owns its panel initialization");
  assert.ok(runtimeA.getPanelModule()?.openPanel, "runtime A publishes its own panel module");
  assert.ok(runtimeB.getPanelModule()?.openPanel, "runtime B publishes its own panel module");
}

{
  const document = buildDocument({ includePanel: false });
  const runtime = buildColdRuntime(document, { failFirstInit: true });

  await initializePanelBridgeController(runtime);
  assert.equal(runtime.getPanelModule(), undefined, "failed initialization is not published as ready");
  await initializePanelBridgeController(runtime);
  assert.equal(runtime.calls.initialized, 2, "a failed partial initialization remains retryable");
  assert.ok(runtime.getPanelModule()?.openPanel, "successful retry publishes the panel module");
}

{
  const document = buildDocument({ includeExtensionsMenu: false });
  const runtime = buildRuntime(document);

  await initializePanelBridgeController(runtime);
  assert.ok(document.getElementById("option_st_bme_panel"), "options entry is injected even before wand DOM exists");
  assert.equal(document.getElementById("st_bme_extensions_menu_entry"), null, "wand entry waits for wand DOM");
  assert.ok(timers.size > 0, "retry remains scheduled until wand DOM exists");

  appendElement(document, document.body, "div", { id: "extensionsMenuButton", style: { display: "none" } });
  appendElement(document, document.body, "div", { id: "extensionsMenu", className: "options-content" });
  runNextTimer();

  assert.ok(document.getElementById("st_bme_extensions_menu_entry"), "retry injects magic-wand entry once wand DOM appears");
  assert.equal(document.getElementById("extensionsMenuButton")?.style.display, "flex", "retry also shows magic-wand button");
}

console.log("panel-bridge tests passed");
