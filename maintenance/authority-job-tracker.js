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

function hasAsyncIterator(value = null) {
  return !!value && typeof value[Symbol.asyncIterator] === "function";
}

function readStreamJobUpdate(event = null) {
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : null;
  if (!source) {
    return event;
  }
  if (source.job && typeof source.job === "object" && !Array.isArray(source.job)) {
    return source.job;
  }
  if (source.result && typeof source.result === "object" && !Array.isArray(source.result)) {
    return source.result;
  }
  if (source.payload && typeof source.payload === "object" && !Array.isArray(source.payload)) {
    return source.payload;
  }
  if (source.data && typeof source.data === "object" && !Array.isArray(source.data)) {
    return source.data;
  }
  return source;
}

function buildTimeoutJob(job = null) {
  const latest = job && typeof job === "object" && !Array.isArray(job) ? job : {};
  return {
    ...latest,
    status: "timeout",
    terminal: true,
    success: false,
    error: String(latest?.error || "wait timeout"),
  };
}

export async function trackAuthorityJobUntilTerminal({
  initialJob = null,
  loadJob,
  streamJob = null,
  onUpdate = null,
  onModeChange = null,
  pollIntervalMs = 1200,
  timeoutMs = 0,
  signal = undefined,
} = {}) {
  if (typeof loadJob !== "function" && typeof streamJob !== "function") {
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
  const emitModeChange = async (mode, reason = "") => {
    if (typeof onModeChange === "function") {
      await onModeChange({
        mode: String(mode || "idle"),
        reason: String(reason || ""),
        elapsedMs: Date.now() - startedAt,
      });
    }
  };
  if (typeof onUpdate === "function") {
    await onUpdate(latest, {
      phase: "initial",
      elapsedMs: 0,
      transport: typeof streamJob === "function" ? "stream" : "polling",
    });
  }
  if (latest.terminal) {
    return latest;
  }

  if (typeof streamJob === "function") {
    let streamFailureReason = "stream-ended";
    await emitModeChange("stream", "stream-first");
    try {
      const stream = await streamJob(jobId, {
        signal,
        previousJob: latest,
        elapsedMs: 0,
      });
      if (!hasAsyncIterator(stream)) {
        throw new Error("Authority Jobs stream unavailable");
      }
      for await (const event of stream) {
        throwIfAborted(signal);
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          latest = buildTimeoutJob(latest);
          if (typeof onUpdate === "function") {
            await onUpdate(latest, {
              phase: "timeout",
              elapsedMs: Date.now() - startedAt,
              transport: "stream",
            });
          }
          return latest;
        }
        const nextJob = readStreamJobUpdate(event);
        if (!nextJob || typeof nextJob !== "object" || Array.isArray(nextJob)) {
          continue;
        }
        latest = {
          ...latest,
          ...nextJob,
        };
        if (typeof onUpdate === "function") {
          await onUpdate(latest, {
            phase: latest?.terminal ? "terminal" : "stream",
            elapsedMs: Date.now() - startedAt,
            transport: "stream",
          });
        }
        if (latest?.terminal) {
          return latest;
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      if (typeof loadJob !== "function") {
        throw error;
      }
      streamFailureReason = error?.message || String(error) || "stream-fallback";
    }
    if (typeof loadJob !== "function") {
      throw new Error("Authority job stream ended before terminal state");
    }
    await emitModeChange("polling", streamFailureReason);
  } else {
    await emitModeChange("polling", "polling-only");
  }

  while (true) {
    throwIfAborted(signal);
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      latest = buildTimeoutJob(latest);
      if (typeof onUpdate === "function") {
        await onUpdate(latest, {
          phase: "timeout",
          elapsedMs: Date.now() - startedAt,
          transport: "polling",
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
        transport: "polling",
      });
    }
    if (latest?.terminal) {
      return latest;
    }
  }
}
