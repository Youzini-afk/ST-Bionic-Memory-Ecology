import assert from "node:assert/strict";
import { installResolveHooks, toDataModuleUrl } from "./helpers/register-hooks-compat.mjs";

installResolveHooks([
  { specifiers: ["../../../../../script.js"], url: toDataModuleUrl("export function getRequestHeaders() { return {}; }") },
  { specifiers: ["../../../../extensions.js"], url: toDataModuleUrl("export const extension_settings = { st_bme: {} };") },
]);

const { embedBatch } = await import("../vector/embedding.js");

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function withFetch(handler, fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = previousFetch; }
}

const plain = (vectors) => vectors.map((vector) => (vector ? Array.from(vector) : null));

{
  const calls = [];
  await withFetch(async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body);
    return jsonResponse({ data: body.input.map((text, index) => ({ index, embedding: [String(text).length, index] })) });
  }, async () => {
    const vectors = await embedBatch(["alpha", "beta", "gamma"], { mode: "direct", apiUrl: "https://example.com/v1", apiKey: "sk-test", model: "test-embedding", embeddingBatchSize: 2 });
    assert.deepEqual(plain(vectors), [[5, 0], [4, 1], [5, 0]]);
  });
  assert.deepEqual(calls.map((call) => call.input), [["alpha", "beta"], ["gamma"]]);
  assert.deepEqual(calls.map((call) => call.encoding_format), ["float", "float"]);
}

{
  const calls = [];
  await withFetch(async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body);
    if (Array.isArray(body.input)) return new Response("batch schema rejected", { status: 400 });
    return jsonResponse({ data: [{ index: 0, embedding: [String(body.input).length, 9] }] });
  }, async () => {
    const vectors = await embedBatch(["first", "second"], { mode: "direct", apiUrl: "https://example.com/v1/embeddings", model: "test-embedding", embeddingBatchSize: 2 });
    assert.deepEqual(plain(vectors), [[5, 9], [6, 9]]);
  });
  assert.deepEqual(calls.map((call) => call.input), [["first", "second"], "first", "second"]);
}

{
  const calls = [];
  await withFetch(async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body);
    if (Array.isArray(body.texts)) return new Response("backend batch rejected", { status: 400 });
    return jsonResponse({ vector: [String(body.text).length, 3] });
  }, async () => {
    const vectors = await embedBatch(["uno", "dos"], { mode: "backend", source: "openai", model: "text-embedding-3-small", embeddingBatchSize: 2 });
    assert.deepEqual(plain(vectors), [[3, 3], [3, 3]]);
  });
  assert.deepEqual(calls.map((call) => [call.texts, call.text]), [[["uno", "dos"], undefined], [undefined, "uno"], [undefined, "dos"]]);
}

{
  const calls = [];
  await withFetch(async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body);
    if (Array.isArray(body.input)) {
      return jsonResponse({ data: [{ index: 0, embedding: [1, 1] }] });
    }
    return jsonResponse({ data: [{ index: 0, embedding: [String(body.input).length, 7] }] });
  }, async () => {
    const vectors = await embedBatch(["kept", "fallback"], { mode: "direct", apiUrl: "https://example.com/v1", model: "test-embedding", embeddingBatchSize: 2 });
    assert.deepEqual(plain(vectors), [[1, 1], [8, 7]]);
  });
  assert.deepEqual(calls.map((call) => call.input), [["kept", "fallback"], "fallback"]);
}

{
  const result = await withFetch(async () => jsonResponse({ data: [{ index: 0, embedding: [] }] }), async () => {
    await assert.rejects(
      () => embedBatch(["empty"], { mode: "direct", apiUrl: "https://example.com/v1", model: "test-embedding", throwOnEmptyBatch: true }),
      /Embedding API 批量返回空结果/,
    );
    return true;
  });
  assert.equal(result, true);
}

{
  await withFetch(async () => new Response(JSON.stringify({ code: 20012, message: "Model does not exist", data: null }), { status: 400 }), async () => {
    await assert.rejects(
      () => embedBatch(["bad model"], { mode: "direct", apiUrl: "https://example.com/v1", model: "missing", throwOnEmptyBatch: true }),
      /Embedding API 错误 \(400\): Model does not exist/,
    );
  });
}

console.log("embedding-batch tests passed");
