import assert from "node:assert/strict";

class FakeElement {
  constructor(tagName = "div", document = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.value = "";
    this._id = "";
  }

  set id(value) {
    this._id = String(value || "");
    if (this._id) this.ownerDocument?.registerId(this._id, this);
  }

  get id() {
    return this._id;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    if (child.id) this.ownerDocument?.registerId(child.id, child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value ?? ""));
    if (name === "id") this.id = value;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter((item) => item !== handler));
  }

  async click() {
    for (const handler of this.listeners.get("click") || []) {
      await handler({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  querySelector() {
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.section = new FakeElement("section", this);
  }

  registerId(id, element) {
    this.byId.set(String(id), element);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(String(id)) || null;
  }

  querySelector(selector) {
    if (selector === '[data-config-section="planner"]') return this.section;
    return null;
  }
}

function addElement(document, id) {
  const element = document.createElement("div");
  element.id = id;
  return element;
}

const previousDocument = globalThis.document;

try {
  const document = new FakeDocument();
  globalThis.document = document;

  const worldbookButton = addElement(document, "bme-planner-debug-wb");
  const charButton = addElement(document, "bme-planner-debug-char");
  const runTestButton = addElement(document, "bme-planner-run-test");
  const testInput = addElement(document, "bme-planner-test-input");
  const testStatus = addElement(document, "bme-planner-test-status");
  const output = addElement(document, "bme-planner-debug-output");
  const enabled = addElement(document, "bme-planner-enabled");
  const skipPlot = addElement(document, "bme-planner-skip-plot");
  enabled.value = "true";
  addElement(document, "bme-planner-state-chip");
  addElement(document, "bme-planner-save-chip");

  const {
    initPlannerSections,
    refreshPlannerSections,
    cleanupPlannerSections,
  } = await import("../ui/panel-ena-sections.js");
  let plannerApi = null;

  initPlannerSections(document, { getPlannerApi: () => plannerApi });
  assert.match(output.textContent, /^$/, "debug output starts empty");
  assert.equal(enabled.value, "false", "missing planner runtime fails closed in the UI");

  let testedInput = null;
  let subscribed = 0;
  let savedPatch = null;
  plannerApi = {
    getConfig: () => ({ enabled: true, skipIfPlotPresent: true }),
    getLogs: () => [],
    subscribe: () => {
      subscribed += 1;
      return () => {};
    },
    patchConfig: async (patch) => {
      savedPatch = patch;
      return { ok: false, error: "test stop" };
    },
    debugWorldbook: async () => ({ ok: true, output: "worldbook diagnostics ready" }),
    debugChar: () => ({ ok: false, output: "character lookup failed: missing context" }),
    runTest: async (text) => {
      testedInput = text;
      return { ok: true };
    },
  };

  refreshPlannerSections({ getPlannerApi: () => plannerApi });
  assert.equal(enabled.value, "true", "late planner runtime refreshes persisted config");
  assert.equal(subscribed, 1, "late planner runtime establishes its subscription");

  skipPlot.value = "false";
  for (const handler of skipPlot.listeners.get("change") || []) {
    await handler({ target: skipPlot });
  }
  assert.equal(savedPatch?.enabled, true, "saving another field preserves loaded enabled state");

  await worldbookButton.click();
  assert.equal(output.textContent, "worldbook diagnostics ready");

  await charButton.click();
  assert.match(output.textContent, /Diagnostics failed|诊断失败/);
  assert.match(output.textContent, /missing context/);

  testInput.value = "fresh planner input";
  await runTestButton.click();
  assert.equal(testedInput, "fresh planner input", "late planner runtime is used by bound controls");
  assert.ok(testStatus.textContent, "planner test status is updated");

  cleanupPlannerSections();
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log("panel ENA debug tests passed");
