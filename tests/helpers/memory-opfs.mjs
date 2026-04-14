export function createNotFoundError(message) {
  const error = new Error(String(message || "Not found"));
  error.name = "NotFoundError";
  return error;
}

export class MemoryOpfsFileHandle {
  constructor(parent, name) {
    this.parent = parent;
    this.name = String(name || "");
  }

  async getFile() {
    const parent = this.parent;
    const name = this.name;
    return {
      async text() {
        return String(parent.files.get(name) ?? "");
      },
    };
  }

  async createWritable() {
    const parent = this.parent;
    const name = this.name;
    let buffer = String(parent.files.get(name) ?? "");
    return {
      async write(chunk) {
        if (typeof chunk === "string") {
          buffer = chunk;
          return;
        }
        if (chunk == null) {
          buffer = "";
          return;
        }
        buffer = String(chunk);
      },
      async close() {
        if (Number(parent.writeDelayMs) > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Number(parent.writeDelayMs)),
          );
        }
        parent.files.set(name, buffer);
      },
    };
  }
}

export class MemoryOpfsDirectoryHandle {
  constructor(name = "", { writeDelayMs = 0 } = {}) {
    this.name = String(name || "");
    this.directories = new Map();
    this.files = new Map();
    this.writeDelayMs = Number(writeDelayMs) || 0;
  }

  async getDirectoryHandle(name, options = {}) {
    const normalizedName = String(name || "");
    let directory = this.directories.get(normalizedName) || null;
    if (!directory) {
      if (!options.create) {
        throw createNotFoundError(`Directory not found: ${normalizedName}`);
      }
      directory = new MemoryOpfsDirectoryHandle(normalizedName, {
        writeDelayMs: this.writeDelayMs,
      });
      this.directories.set(normalizedName, directory);
    }
    return directory;
  }

  async getFileHandle(name, options = {}) {
    const normalizedName = String(name || "");
    if (!this.files.has(normalizedName)) {
      if (!options.create) {
        throw createNotFoundError(`File not found: ${normalizedName}`);
      }
      this.files.set(normalizedName, "");
    }
    return new MemoryOpfsFileHandle(this, normalizedName);
  }

  async removeEntry(name, options = {}) {
    const normalizedName = String(name || "");
    if (this.files.delete(normalizedName)) {
      return;
    }
    const directory = this.directories.get(normalizedName) || null;
    if (directory) {
      const canDelete =
        options.recursive === true ||
        (directory.files.size === 0 && directory.directories.size === 0);
      if (!canDelete) {
        throw new Error(`Directory not empty: ${normalizedName}`);
      }
      this.directories.delete(normalizedName);
      return;
    }
    throw createNotFoundError(`Entry not found: ${normalizedName}`);
  }
}

export function createMemoryOpfsRoot(options = {}) {
  return new MemoryOpfsDirectoryHandle("root", options);
}
