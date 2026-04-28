import assert from "node:assert/strict";

import {
  AUTHORITY_SESSION_HEADER,
  AuthorityHttpClient,
  AuthorityHttpError,
} from "../runtime/authority-http-client.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "application/json" : "";
      },
    },
    async json() {
      return payload;
    },
  };
}

{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init") && calls.filter((call) => call.url.endsWith("/session/init")).length === 1) {
        return jsonResponse(200, { sessionToken: "old-session" });
      }
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "new-session" });
      }
      if (url.endsWith("/data") && options.headers?.[AUTHORITY_SESSION_HEADER] === "old-session") {
        return jsonResponse(401, { code: "session-expired", message: "session expired" });
      }
      if (url.endsWith("/data") && options.headers?.[AUTHORITY_SESSION_HEADER] === "new-session") {
        return jsonResponse(200, { ok: true, value: 42 });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });
  const result = await client.requestJson("/data", { session: true, body: { q: 1 } });
  assert.deepEqual(result, { ok: true, value: 42 });
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.headers?.[AUTHORITY_SESSION_HEADER] || ""]),
    [
      ["https://authority.example.test/root/session/init", ""],
      ["https://authority.example.test/root/data", "old-session"],
      ["https://authority.example.test/root/session/init", ""],
      ["https://authority.example.test/root/data", "new-session"],
    ],
  );
}

{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "permission-session" });
      }
      return jsonResponse(403, { code: "permission-denied", message: "permission denied" });
    },
  });
  await assert.rejects(
    () => client.requestJson("/private", { session: true, body: {} }),
    (error) => {
      assert.equal(error instanceof AuthorityHttpError, true);
      assert.equal(error.status, 403);
      assert.equal(error.category, "permission");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.url.endsWith("/session/init")).length, 1);
}

{
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    timeoutMs: 5,
    fetchImpl: async (_url, options = {}) => await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => client.requestJson("/slow", { session: false }),
    (error) => {
      assert.equal(error instanceof AuthorityHttpError, true);
      assert.equal(error.category, "timeout");
      assert.equal(error.code, "timeout");
      return true;
    },
  );
}

console.log("authority-http-client tests passed");
