import { getRequestHeaders } from "../../../../../script.js";

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const toBase64 = (text) => btoa(unescape(encodeURIComponent(text)));

class StorageFile {
  constructor(filename, opts = {}) {
    this.filename = filename;
    this.cache = null;
    this._loading = null;
    this._dirtyVersion = 0;
    this._savedVersion = 0;
    this._saving = false;
    this._pendingSave = false;
    this._retryCount = 0;
    this._retryTimer = null;
    this._maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 5;
    const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 2000;
    this._saveDebounced = debounce(() => this.saveNow({ silent: true }), debounceMs);
  }

  async load() {
    if (this.cache !== null) return this.cache;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      try {
        const res = await fetch(`/user/files/${this.filename}`, {
          headers: getRequestHeaders(),
          cache: "no-cache",
        });
        if (!res.ok) {
          this.cache = {};
          return this.cache;
        }
        const text = await res.text();
        this.cache = text ? JSON.parse(text) || {} : {};
      } catch {
        this.cache = {};
      } finally {
        this._loading = null;
      }
      return this.cache;
    })();

    return this._loading;
  }

  async get(key, defaultValue = null) {
    const data = await this.load();
    return data[key] ?? defaultValue;
  }

  async set(key, value) {
    const data = await this.load();
    data[key] = value;
    this._dirtyVersion++;
    this._saveDebounced();
  }

  async saveNow({ silent = true } = {}) {
    if (this._saving) {
      this._pendingSave = true;
      if (!silent) {
        await this._waitForSaveComplete();
        if (this._dirtyVersion > this._savedVersion) {
          return this.saveNow({ silent });
        }
        return this._dirtyVersion === this._savedVersion;
      }
      return true;
    }

    if (!this.cache || this._dirtyVersion === this._savedVersion) {
      return true;
    }

    this._saving = true;
    this._pendingSave = false;
    const versionToSave = this._dirtyVersion;

    try {
      const json = JSON.stringify(this.cache);
      const base64 = toBase64(json);
      const res = await fetch("/api/files/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: this.filename, data: base64 }),
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      this._savedVersion = Math.max(this._savedVersion, versionToSave);
      this._retryCount = 0;
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      return true;
    } catch (error) {
      console.error("[EnaPlannerStorage] Save failed:", error);
      this._retryCount++;
      const delay = Math.min(30000, 2000 * (2 ** Math.max(0, this._retryCount - 1)));
      if (!this._retryTimer && this._retryCount <= this._maxRetries) {
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.saveNow({ silent: true });
        }, delay);
      }

      if (!silent) {
        throw error;
      }
      return false;
    } finally {
      this._saving = false;
      if (this._pendingSave || this._dirtyVersion > this._savedVersion) {
        this._saveDebounced();
      }
    }
  }

  _waitForSaveComplete() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this._saving) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
}

export const EnaPlannerStorage = new StorageFile("STBME_EnaPlanner.json", {
  debounceMs: 800,
});
