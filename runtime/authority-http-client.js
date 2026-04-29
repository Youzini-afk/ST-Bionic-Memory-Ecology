import { normalizeAuthorityBaseUrl } from "./authority-capabilities.js";

export const AUTHORITY_PROTOCOL_AUTO = "auto";
export const AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06 = "server-plugin-v06";
export const AUTHORITY_SESSION_HEADER = "x-authority-session-token";

function normalizeProtocol(value = AUTHORITY_PROTOCOL_AUTO) {
  const normalized = String(value || AUTHORITY_PROTOCOL_AUTO).trim().toLowerCase();
  if (["v06", "v0.6", "server-plugin", AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06].includes(normalized)) {
    return AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06;
  }
  return AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06;
}

function clonePlain(value, fallbackValue = null) {
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

function normalizeHeaderName(name = "") {
  return String(name || "").trim().toLowerCase();
}

function normalizeTimeoutMs(value, fallbackValue = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const fallback = Number(fallbackValue);
    return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 0;
  }
  return Math.floor(parsed);
}

function hasSessionHeader(headers = {}) {
  return Object.keys(headers || {}).some((name) => normalizeHeaderName(name) === AUTHORITY_SESSION_HEADER);
}

function buildDefaultSessionInitConfig(source = {}) {
  const config = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    extensionId: String(config.extensionId || "third-party/st-bme"),
    displayName: String(config.displayName || "ST-BME"),
    version: String(config.version || "0.0.0"),
    installType: String(config.installType || "local"),
    declaredPermissions: clonePlain(config.declaredPermissions, null) || {
      storage: { kv: true, blob: true },
      fs: { private: true },
      sql: { private: true },
      trivium: { private: true },
      jobs: { background: true },
      events: { channels: true },
    },
    ...(config.uiLabel ? { uiLabel: String(config.uiLabel) } : {}),
  };
}

function readPayloadErrorMessage(payload = null, fallback = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  return String(payload.error || payload.message || payload.reason || fallback || "");
}

function readPayloadCode(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  return String(payload.code || payload.reason || payload.category || payload.errorCode || "").trim().toLowerCase();
}

function isSessionRetryCandidate(status = 0, payload = null) {
  const numericStatus = Number(status || 0);
  if (numericStatus === 401) return true;
  if (numericStatus !== 403) return false;
  const code = readPayloadCode(payload);
  const message = readPayloadErrorMessage(payload, "").toLowerCase();
  return /session|token/.test(`${code} ${message}`) && /invalid|expired|missing|unauthorized/.test(`${code} ${message}`);
}

function classifyAuthorityError({ status = 0, payload = null, error = null, timedOut = false, aborted = false } = {}) {
  const numericStatus = Number(status || 0);
  const payloadCategory = String(payload?.category || "").trim();
  if (payloadCategory) return payloadCategory;
  if (timedOut || numericStatus === 408) return "timeout";
  if (aborted) return "aborted";
  if (isSessionRetryCandidate(numericStatus, payload)) return "session";
  if (numericStatus === 403) return "permission";
  if (numericStatus === 404) return "not-found";
  if (numericStatus === 413) return "payload-too-large";
  if (numericStatus === 429) return "rate-limit";
  if (numericStatus >= 500) return "server";
  if (numericStatus >= 400) return "validation";
  if (error) return "network";
  return "";
}

function createRequestSignal(signal = undefined, timeoutMs = 0) {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs, 0);
  if (!signal && normalizedTimeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {}, timedOut: () => false };
  }
  if (typeof AbortController !== "function") {
    return { signal, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;
  const abortFromSignal = () => {
    controller.abort(signal?.reason || Object.assign(new Error("Authority request aborted"), { name: "AbortError" }));
  };
  if (signal?.aborted) {
    abortFromSignal();
  } else if (signal) {
    signal.addEventListener("abort", abortFromSignal, { once: true });
  }
  if (normalizedTimeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(Object.assign(new Error("Authority request timed out"), { name: "AbortError" }));
    }, normalizedTimeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", abortFromSignal);
    },
    timedOut: () => timedOut,
  };
}

async function readResponsePayload(response = null) {
  if (!response) return {};
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("application/json") && typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
    }
  }
  if (typeof response.text === "function") {
    try {
      return { error: await response.text() };
    } catch {
      return {};
    }
  }
  return {};
}

export class AuthorityHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthorityHttpError";
    this.status = Number(options.status || 0);
    this.code = String(options.code || "");
    this.category = String(options.category || classifyAuthorityError(options));
    this.payload = clonePlain(options.payload, null);
    this.path = String(options.path || "");
    this.protocol = String(options.protocol || "");
  }
}

export class AuthorityHttpClient {
  constructor(options = {}) {
    this.baseUrl = normalizeAuthorityBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.headerProvider = typeof options.headerProvider === "function" ? options.headerProvider : null;
    this.protocol = normalizeProtocol(options.protocol || options.authorityProtocol);
    this.sessionToken = String(options.sessionToken || options.authoritySessionToken || "");
    this.sessionInitConfig = buildDefaultSessionInitConfig(options.sessionInitConfig || options.initConfig || options);
    this.sessionPromise = null;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.authorityTimeoutMs, 0);
  }

  async buildHeaders({ session = false } = {}) {
    let provided = {};
    if (this.headerProvider) {
      provided = await this.headerProvider() || {};
    }
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...provided,
    };
    if (session && this.sessionToken && !hasSessionHeader(headers)) {
      headers[AUTHORITY_SESSION_HEADER] = this.sessionToken;
    }
    return headers;
  }

  async ensureSession() {
    if (this.sessionToken) return this.sessionToken;
    if (!this.sessionPromise) {
      this.sessionPromise = this.requestJson("/session/init", {
        method: "POST",
        body: this.sessionInitConfig,
        session: false,
        protocol: AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06,
      }).then((payload) => {
        const token = String(payload?.sessionToken || payload?.token || "");
        if (!token) {
          throw new AuthorityHttpError("Authority session init did not return a session token", {
            status: 0,
            path: "/session/init",
            protocol: AUTHORITY_PROTOCOL_SERVER_PLUGIN_V06,
            payload,
          });
        }
        this.sessionToken = token;
        return token;
      }).catch((error) => {
        this.sessionPromise = null;
        throw error;
      });
    }
    return await this.sessionPromise;
  }

  async requestJson(path, options = {}) {
    return await this._requestJson(path, options, { allowSessionRetry: true });
  }

  async _requestJson(path, options = {}, state = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new AuthorityHttpError("Authority fetch unavailable", {
        path,
        protocol: options.protocol || this.protocol,
      });
    }
    const method = String(options.method || "POST").toUpperCase();
    const session = Boolean(options.session);
    if (session && !this.sessionToken) {
      await this.ensureSession();
    }
    const headers = await this.buildHeaders({ session });
    const requestSignal = createRequestSignal(options.signal, normalizeTimeoutMs(options.timeoutMs, this.timeoutMs));
    let response = null;
    let payload = {};
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(method === "GET" || options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(requestSignal.signal ? { signal: requestSignal.signal } : {}),
      });
      payload = await readResponsePayload(response);
    } catch (error) {
      const timedOut = requestSignal.timedOut();
      const aborted = error?.name === "AbortError" && !timedOut;
      throw new AuthorityHttpError(
        timedOut
          ? `Authority request timed out after ${normalizeTimeoutMs(options.timeoutMs, this.timeoutMs)}ms`
          : error?.message || String(error) || "Authority request failed",
        {
          status: 0,
          code: timedOut ? "timeout" : aborted ? "aborted" : "network-error",
          category: classifyAuthorityError({ error, timedOut, aborted }),
          payload: null,
          path,
          protocol: options.protocol || this.protocol,
        },
      );
    } finally {
      requestSignal.cleanup();
    }
    const status = Number(response?.status || 0);
    if (!response?.ok) {
      const message = readPayloadErrorMessage(payload, `Authority HTTP ${status || "unknown"}`);
      if (
        session &&
        state.allowSessionRetry !== false &&
        options.retrySession !== false &&
        isSessionRetryCandidate(status, payload)
      ) {
        this.sessionToken = "";
        this.sessionPromise = null;
        await this.ensureSession();
        return await this._requestJson(path, options, { allowSessionRetry: false });
      }
      throw new AuthorityHttpError(message || `Authority HTTP ${status || "unknown"}`, {
        status,
        code: payload?.code,
        category: classifyAuthorityError({ status, payload }),
        payload,
        path,
        protocol: options.protocol || this.protocol,
      });
    }
    return payload;
  }
}

export function createAuthorityHttpClient(options = {}) {
  return new AuthorityHttpClient(options);
}
