import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
].join("\n");
const scriptShimSource = [
  "export function getRequestHeaders() { return {}; }",
  "export function saveSettingsDebounced() {}",
  "export function substituteParamsExtended(text = '') { return String(text ?? ''); }",
].join("\n");

installResolveHooks([
  {
    specifiers: ["../../../../extensions.js"],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: ["../../../../../script.js"],
    url: toDataModuleUrl(scriptShimSource),
  },
]);

const require = createRequire(import.meta.url);
const ejs = require("../vendor/ejs.js");
const originalWindow = globalThis.window;
const originalWarn = console.warn;
const warnings = [];

try {
  globalThis.window = { ...(originalWindow || {}), ejs };
  console.warn = (...args) => warnings.push(args);

  const { createEnaPlannerEjsContext, renderEjsTemplate } = await import(
    "../ena-planner/ena-planner.js"
  );

  const ctx = createEnaPlannerEjsContext({ x: "alpha" });
  assert.equal(renderEjsTemplate("<%= getvar('x') %>", ctx), "alpha");
  assert.equal(renderEjsTemplate("<% print(getvar('x')) %>", ctx), "alpha");

  const pollutedCtx = {
    ...createEnaPlannerEjsContext({ x: "safe" }),
    __append() {
      throw new Error("locals __append should not shadow EJS output");
    },
    print() {
      throw new Error("locals print should not shadow EJS output function");
    },
  };
  assert.equal(renderEjsTemplate("<%= getvar('x') %>", pollutedCtx), "safe");
  assert.equal(renderEjsTemplate("<% print(getvar('x')) %>", pollutedCtx), "safe");

  const invalidTemplate = "before <% if ( %> after";
  assert.equal(renderEjsTemplate(invalidTemplate, ctx, "invalid"), invalidTemplate);
  assert.ok(warnings.some((args) => String(args[0]).includes("EJS render failed")));
} finally {
  console.warn = originalWarn;
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
}

console.log("ena-planner-ejs tests passed");
