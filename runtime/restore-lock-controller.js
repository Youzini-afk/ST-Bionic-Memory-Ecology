function normalizeOwnerIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((owner) => String(owner || "").trim()).filter(Boolean))]
    : [];
}

export function normalizeRestoreLockState(lock = null) {
  const owners = normalizeOwnerIds(lock?.owners);
  const depth = Math.max(
    owners.length,
    Math.max(0, Math.floor(Number(lock?.depth) || 0)),
  );
  const active = lock?.active === true || depth > 0;
  const startedAt = Number(lock?.startedAt);
  return {
    active,
    depth: active ? Math.max(1, depth || 1) : 0,
    source: String(lock?.source || "").trim(),
    reason: String(lock?.reason || "").trim(),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
    owners,
  };
}

export function createRestoreLockController({
  getLock = () => null,
  setLock = () => {},
  now = () => Date.now(),
} = {}) {
  let ownerSequence = 0;
  const read = () => normalizeRestoreLockState(getLock());
  const write = (lock) => {
    const normalized = normalizeRestoreLockState(lock);
    setLock(normalized);
    return normalized;
  };

  const enter = (source = "runtime", reason = "") => {
    const current = read();
    const owner = {
      id: `restore-lock:${now()}:${++ownerSequence}`,
      source: String(source || current.source || "runtime"),
    };
    write({
      active: true,
      depth: current.depth + 1,
      source: owner.source,
      reason: String(reason || current.reason || ""),
      startedAt: current.startedAt || now(),
      owners: [...current.owners, owner.id],
    });
    return owner;
  };

  const leave = (ownerOrSource = "runtime") => {
    const current = read();
    if (!current.active) return current;
    const ownerId =
      ownerOrSource && typeof ownerOrSource === "object"
        ? String(ownerOrSource.id || "").trim()
        : "";
    if (ownerId && !current.owners.includes(ownerId)) return current;
    if (!ownerId && current.owners.length > 0) return current;

    const owners = ownerId
      ? current.owners.filter((candidate) => candidate !== ownerId)
      : [];
    const depth = Math.max(owners.length, current.depth - 1);
    if (depth <= 0) {
      return write({
        active: false,
        depth: 0,
        source: "",
        reason: "",
        startedAt: 0,
        owners: [],
      });
    }
    return write({ ...current, depth, owners });
  };

  return {
    normalize: normalizeRestoreLockState,
    isActive: () => read().active,
    getMessage(operationLabel = "当前操作") {
      const lock = read();
      if (!lock.active) return "";
      const details = [lock.reason, lock.source].filter(Boolean).join(" / ");
      return `${operationLabel}已暂停：当前处于恢复锁${details ? `（${details}）` : ""}`;
    },
    enter,
    leave,
    async runWith(source, reason, task) {
      const owner = enter(source, reason);
      try {
        return await task();
      } finally {
        leave(owner);
      }
    },
  };
}
