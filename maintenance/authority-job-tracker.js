function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("操作已终止"), { name: "AbortError" });
  }
}

function sleep(ms, signal) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, Math.floor(Number(ms))));
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error("操作已终止"), { name: "AbortError" }),
          );
        },
        { once: true },
      );
    }
  });
}

export async function trackAuthorityJobUntilTerminal({
  initialJob = null,
  loadJob,
  onUpdate = null,
  pollIntervalMs = 1200,
  timeoutMs = 0,
  signal = undefined,
} = {}) {
  if (typeof loadJob !== "function") {
    throw new Error("Authority job loader unavailable");
  }
  const initial =
    initialJob && typeof initialJob === "object" && !Array.isArray(initialJob)
      ? initialJob
      : {};
  const jobId = String(initial.id || "").trim();
  if (!jobId) {
    return initial;
  }

  const startedAt = Date.now();
  let latest = { ...initial };
  if (typeof onUpdate === "function") {
    await onUpdate(latest, {
      phase: "initial",
      elapsedMs: 0,
    });
  }
  if (latest.terminal) {
    return latest;
  }

  while (true) {
    throwIfAborted(signal);
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      latest = {
        ...latest,
        status: "timeout",
        terminal: true,
        success: false,
        error: String(latest?.error || "wait timeout"),
      };
      if (typeof onUpdate === "function") {
        await onUpdate(latest, {
          phase: "timeout",
          elapsedMs: Date.now() - startedAt,
        });
      }
      return latest;
    }
    await sleep(pollIntervalMs, signal);
    throwIfAborted(signal);
    latest = await loadJob(jobId, {
      signal,
      previousJob: latest,
      elapsedMs: Date.now() - startedAt,
    });
    if (typeof onUpdate === "function") {
      await onUpdate(latest, {
        phase: latest?.terminal ? "terminal" : "poll",
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (latest?.terminal) {
      return latest;
    }
  }
}
