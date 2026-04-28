import { normalizeAuthorityBaseUrl } from "../runtime/authority-capabilities.js";
import { AuthorityHttpClient } from "../runtime/authority-http-client.js";

export const AUTHORITY_BLOB_ENDPOINT = "/fs/private";

function toPlainData(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function decodeBase64Utf8(base64Text = "") {
  const normalizedBase64 = String(base64Text ?? "");
  if (!normalizedBase64) return "";
  if (typeof globalThis.atob === "function" && typeof globalThis.TextDecoder === "function") {
    const binary = globalThis.atob(normalizedBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedBase64, "base64").toString("utf8");
  }
  return normalizedBase64;
}

function tryParseJsonText(text, fallbackValue = null) {
  if (typeof text !== "string") return fallbackValue;
  try {
    return JSON.parse(text);
  } catch {
    return fallbackValue;
  }
}

export function normalizeAuthorityBlobPath(path = "") {
  const normalized = String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^authority:\/\/private\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  return normalized.replace(/\/+$/g, "");
}

function decodePathForValidation(path = "") {
  try {
    return decodeURIComponent(String(path || ""));
  } catch {
    return String(path || "");
  }
}

function assertSafeAuthorityBlobPath(path = "", options = {}) {
  const normalized = normalizeAuthorityBlobPath(path);
  if (!normalized) {
    if (options.allowEmpty) return "";
    throw new Error("Authority Blob path is required");
  }
  const decoded = decodePathForValidation(normalized).replace(/\\/g, "/");
  if (/^[A-Za-z]:(?:\/|$)/.test(decoded) || decoded.includes(":/")) {
    throw new Error(`Unsafe Authority Blob path: ${normalized}`);
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe Authority Blob path: ${normalized}`);
  }
  return normalized;
}

function normalizeBlobPayload(result = null) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const source = result.file || result.blob || result.result || result;
  if (source.payload !== undefined) return source.payload;
  if (source.json !== undefined) return source.json;
  if (source.value !== undefined) return source.value;
  if (source.data !== undefined) {
    if (source.encoding === "base64" || source.base64 === true) {
      return tryParseJsonText(decodeBase64Utf8(source.data), source.data);
    }
    if (typeof source.data === "string") {
      return tryParseJsonText(source.data, source.data);
    }
    return source.data;
  }
  if (source.content !== undefined) {
    if (typeof source.content === "string") {
      return tryParseJsonText(source.content, source.content);
    }
    return source.content;
  }
  if (source.body !== undefined) {
    if (typeof source.body === "string") {
      return tryParseJsonText(source.body, source.body);
    }
    return source.body;
  }
  return null;
}

function normalizeBlobRecordSource(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input.file || input.blob || input.result || input;
}

export function normalizeAuthorityBlobReadResult(input = null, fallbackPath = "") {
  const source = normalizeBlobRecordSource(input);
  const entry = source.entry && typeof source.entry === "object" ? source.entry : null;
  const path = normalizeAuthorityBlobPath(entry?.path || source.path || source.name || fallbackPath);
  const missing =
    source.exists === false ||
    source.found === false ||
    source.missing === true ||
    Number(source.status || source.statusCode || 0) === 404;
  if (missing) {
    return {
      exists: false,
      path,
      payload: null,
      contentType: String(source.contentType || source.type || ""),
      raw: toPlainData(input, input),
    };
  }
  return {
    exists: input != null && source.ok !== false,
    path,
    payload: normalizeBlobPayload(input),
    contentType: String(source.contentType || source.type || "application/json"),
    etag: String(source.etag || source.hash || ""),
    updatedAt: source.updatedAt || source.updated_at || source.lastModified || entry?.updatedAt || "",
    raw: toPlainData(input, input),
  };
}

export function normalizeAuthorityBlobWriteResult(input = null, fallbackPath = "") {
  const source = normalizeBlobRecordSource(input);
  const entry = source.entry && typeof source.entry === "object" ? source.entry : null;
  const path = normalizeAuthorityBlobPath(entry?.path || source.path || source.name || fallbackPath);
  return {
    ok: input == null ? true : source.ok !== false && source.error == null,
    path,
    url: String(source.url || source.href || ""),
    size: normalizeInteger(source.size || source.bytes || entry?.sizeBytes, 0, 0),
    etag: String(source.etag || source.hash || ""),
    updatedAt: source.updatedAt || source.updated_at || source.lastModified || entry?.updatedAt || "",
    raw: toPlainData(input, input),
  };
}

export function normalizeAuthorityBlobDeleteResult(input = null, fallbackPath = "") {
  const source = normalizeBlobRecordSource(input);
  const path = normalizeAuthorityBlobPath(source.path || source.name || fallbackPath);
  const missing =
    source.exists === false ||
    source.found === false ||
    source.missing === true ||
    Number(source.status || source.statusCode || 0) === 404;
  return {
    ok: input == null ? true : source.ok !== false,
    deleted: missing ? false : source.deleted !== false && source.ok !== false,
    missing,
    path,
    raw: toPlainData(input, input),
  };
}

export function normalizeAuthorityBlobConfig(settings = {}, overrides = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    baseUrl: normalizeAuthorityBaseUrl(source.authorityBaseUrl ?? source.baseUrl),
    enabled:
      source.authorityBlobCheckpointEnabled !== false &&
      source.blobCheckpointEnabled !== false &&
      source.authorityBlobEnabled !== false,
    failOpen: source.authorityFailOpen !== false && source.failOpen !== false,
    namespace: normalizeRecordId(source.authorityBlobNamespace || source.blobNamespace || "st-bme"),
    ...overrides,
  };
}

export class AuthorityBlobHttpClient {
  constructor(options = {}) {
    this.http = new AuthorityHttpClient({
      ...options,
      baseUrl: normalizeAuthorityBaseUrl(options.baseUrl),
    });
  }

  async request(path, payload = {}, options = {}) {
    return await this.http.requestJson(path, {
      method: options.method || "POST",
      body: payload,
      session: true,
      signal: options.signal,
    });
  }

  async writeJson(payload = {}) {
    return await this.writeText({
      ...payload,
      contentType: payload.contentType || "application/json",
      text: JSON.stringify(toPlainData(payload.payload ?? payload.data, payload.payload ?? payload.data)),
    });
  }

  async writeText(payload = {}) {
    const path = assertSafeAuthorityBlobPath(payload.path || payload.name);
    return await this.request(`${AUTHORITY_BLOB_ENDPOINT}/write-file`, {
      path,
      content: String(payload.text ?? payload.data ?? payload.content ?? ""),
      encoding: "utf8",
      createParents: true,
    }, { signal: payload.signal });
  }

  async readJson(payload = {}) {
    const path = assertSafeAuthorityBlobPath(payload.path || payload.name);
    return await this.request(`${AUTHORITY_BLOB_ENDPOINT}/read-file`, {
      path,
      encoding: "utf8",
    }, { signal: payload.signal });
  }

  async delete(payload = {}) {
    const path = assertSafeAuthorityBlobPath(payload.path || payload.name);
    return await this.request(`${AUTHORITY_BLOB_ENDPOINT}/delete`, {
      path,
      recursive: false,
    }, { signal: payload.signal });
  }

  async stat(payload = {}) {
    const path = assertSafeAuthorityBlobPath(payload.path || payload.name);
    return await this.request(`${AUTHORITY_BLOB_ENDPOINT}/stat`, {
      path,
    }, { signal: payload.signal });
  }
}

export function createAuthorityBlobClient(config = {}, options = {}) {
  const injected = options.blobClient || config.blobClient || globalThis.__stBmeAuthorityBlobClient;
  if (injected) return injected;
  return new AuthorityBlobHttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl || config.fetchImpl,
    headerProvider: options.headerProvider || config.headerProvider,
  });
}

async function callClient(client, methodNames = [], action = "request", payload = {}) {
  for (const methodName of methodNames) {
    if (typeof client?.[methodName] === "function") {
      return await client[methodName](payload);
    }
  }
  if (typeof client?.request === "function") {
    return await client.request(action, payload);
  }
  if (typeof client === "function") {
    return await client({ action, ...payload });
  }
  throw new Error(`Authority Blob ${action} unavailable`);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("操作已终止"), { name: "AbortError" });
  }
}

function isMissingAuthorityBlobError(error) {
  return Number(error?.status || 0) === 404;
}

export class AuthorityBlobAdapter {
  constructor(config = {}, options = {}) {
    this.config = normalizeAuthorityBlobConfig(config, options.configOverrides || {});
    this.client = createAuthorityBlobClient(this.config, options);
  }

  async writeJson(path, payload = null, options = {}) {
    throwIfAborted(options.signal);
    const normalizedPath = assertSafeAuthorityBlobPath(path);
    const result = await callClient(this.client, ["writeJson", "putJson", "writeFile", "put"], "writeJson", {
      namespace: options.namespace || this.config.namespace,
      path: normalizedPath,
      name: normalizedPath,
      contentType: options.contentType || "application/json",
      payload: toPlainData(payload, payload),
      data: toPlainData(payload, payload),
      metadata: toPlainData(options.metadata, {}),
    });
    return normalizeAuthorityBlobWriteResult(result, normalizedPath);
  }

  async writeText(path, text = "", options = {}) {
    throwIfAborted(options.signal);
    const normalizedPath = assertSafeAuthorityBlobPath(path);
    const result = await callClient(this.client, ["writeText", "writeFile", "putText", "put"], "writeText", {
      namespace: options.namespace || this.config.namespace,
      path: normalizedPath,
      name: normalizedPath,
      contentType: options.contentType || "text/plain; charset=utf-8",
      text: String(text ?? ""),
      data: String(text ?? ""),
      metadata: toPlainData(options.metadata, {}),
    });
    return normalizeAuthorityBlobWriteResult(result, normalizedPath);
  }

  async readJson(path, options = {}) {
    throwIfAborted(options.signal);
    const normalizedPath = assertSafeAuthorityBlobPath(path, { allowEmpty: true });
    if (!normalizedPath) return normalizeAuthorityBlobReadResult({ exists: false }, "");
    try {
      const result = await callClient(this.client, ["readJson", "getJson", "readFile", "get"], "readJson", {
        namespace: options.namespace || this.config.namespace,
        path: normalizedPath,
        name: normalizedPath,
      });
      return normalizeAuthorityBlobReadResult(result, normalizedPath);
    } catch (error) {
      if (isMissingAuthorityBlobError(error)) {
        return normalizeAuthorityBlobReadResult({ exists: false, status: 404 }, normalizedPath);
      }
      throw error;
    }
  }

  async delete(path, options = {}) {
    throwIfAborted(options.signal);
    const normalizedPath = assertSafeAuthorityBlobPath(path, { allowEmpty: true });
    if (!normalizedPath) return normalizeAuthorityBlobDeleteResult({ exists: false }, "");
    try {
      const result = await callClient(this.client, ["delete", "deleteFile", "remove", "unlink"], "delete", {
        namespace: options.namespace || this.config.namespace,
        path: normalizedPath,
        name: normalizedPath,
      });
      return normalizeAuthorityBlobDeleteResult(result, normalizedPath);
    } catch (error) {
      if (isMissingAuthorityBlobError(error)) {
        return normalizeAuthorityBlobDeleteResult({ exists: false, status: 404 }, normalizedPath);
      }
      throw error;
    }
  }

  async stat(path, options = {}) {
    throwIfAborted(options.signal);
    const normalizedPath = assertSafeAuthorityBlobPath(path, { allowEmpty: true });
    if (!normalizedPath) return normalizeAuthorityBlobReadResult({ exists: false }, "");
    try {
      const result = await callClient(this.client, ["stat", "head", "metadata"], "stat", {
        namespace: options.namespace || this.config.namespace,
        path: normalizedPath,
        name: normalizedPath,
      });
      return normalizeAuthorityBlobReadResult(result, normalizedPath);
    } catch (error) {
      if (isMissingAuthorityBlobError(error)) {
        return normalizeAuthorityBlobReadResult({ exists: false, status: 404 }, normalizedPath);
      }
      throw error;
    }
  }
}

export function createAuthorityBlobAdapter(config = {}, options = {}) {
  return new AuthorityBlobAdapter(config, options);
}
