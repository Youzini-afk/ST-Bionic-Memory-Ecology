import assert from "node:assert/strict";
import { installResolveHooks, toDataModuleUrl } from "./helpers/register-hooks-compat.mjs";

installResolveHooks([
  { specifiers: ["../../../../../script.js"], url: toDataModuleUrl("export function getRequestHeaders() { return {}; }") },
  { specifiers: ["../../../../extensions.js"], url: toDataModuleUrl("export const extension_settings = { st_bme: {} };") },
]);

const { testVectorConnection } = await import("../vector/vector-index.js");

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function withFetch(handler, fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = previousFetch; }
}

{
  const calls = [];
  const result = await withFetch(async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body);
    assert.equal(Array.isArray(body.input), true);
    assert.equal(body.encoding_format, "float");
    return jsonResponse({ data: body.input.map((text, index) => ({ index, embedding: [1, index, String(text).length] })) });
  }, async () => await testVectorConnection({ mode: "direct", apiUrl: "https://example.com/v1", apiKey: "sk-test", model: "test-embedding" }));
  assert.equal(result.success, true);
  assert.equal(result.dimensions, 3);
  assert.equal(result.batchCapable, true);
  assert.equal(result.mode, "direct");
  assert.deepEqual(calls[0].input, ["test connection", "runtime batch probe"]);
}

{
  const calls = [];
  const result = await withFetch(async (url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ url: String(url), body });
    if (String(url) === "/api/vector/embed") {
      assert.equal(Array.isArray(body.texts), true);
      return jsonResponse({ vectors: body.texts.map((text, index) => [2, index, String(text).length]) });
    }
    assert.equal(String(url), "/api/vector/query");
    return jsonResponse({ hashes: [] });
  }, async () => await testVectorConnection({ mode: "backend", source: "openai", model: "text-embedding-3-small" }));
  assert.equal(result.success, true);
  assert.equal(result.dimensions, 3);
  assert.equal(result.batchCapable, true);
  assert.equal(result.vectorStoreCapable, true);
  assert.equal(result.mode, "backend");
  assert.deepEqual(calls[0].body.texts, ["test connection", "runtime batch probe"]);
  assert.equal(calls[1].url, "/api/vector/query");
  assert.equal(calls[1].body.searchText, "test connection");
}

{
  const result = await withFetch(async () => new Response(
    JSON.stringify({ code: 20012, message: "Model does not exist. Please check it carefully.", data: null }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  ), async () => await testVectorConnection({ mode: "direct", apiUrl: "https://example.com/v1", apiKey: "sk-test", model: "missing-model" }));
  assert.equal(result.success, false);
  assert.match(result.error, /Model does not exist/);
  assert.equal(result.batchCapable, false);
}

{
  const result = await withFetch(async () => new Response(
    JSON.stringify({ error: { message: "Backend provider refused embedding model" } }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  ), async () => await testVectorConnection({ mode: "backend", source: "openai", model: "bad-backend-model" }));
  assert.equal(result.success, false);
  assert.match(result.error, /Backend provider refused embedding model/);
  assert.equal(result.batchCapable, false);
}

console.log("vector-connection-probe tests passed");
