import assert from "node:assert/strict";
import {
  AUTHORITY_JOB_STATUS_TERMINAL,
  AUTHORITY_JOB_STATUS_SUCCESS,
  buildAuthorityJobIdempotencyKey,
  createAuthorityJobAdapter,
  mergeAuthorityRecentJobs,
  normalizeAuthorityJobList,
  normalizeAuthorityJobRecord,
  normalizeAuthorityRecentJobRecord,
} from "../maintenance/authority-job-adapter.js";
import { trackAuthorityJobUntilTerminal } from "../maintenance/authority-job-tracker.js";
import { onRebuildVectorIndexController } from "../ui/ui-actions-controller.js";

function createMockJobClient() {
  const calls = [];
  const states = new Map();
  return {
    calls,
    async submit(payload) {
      calls.push(["submit", payload]);
      const id = `job-${calls.length}`;
      const job = {
        id,
        kind: payload.kind,
        status: "queued",
        progress: { current: 0, total: 10 },
        idempotencyKey: payload.idempotencyKey,
      };
      states.set(id, job);
      return { job };
    },
    async get(payload) {
      calls.push(["get", payload]);
      const previous = states.get(payload.jobId || payload.id);
      const next = {
        ...previous,
        status: "completed",
        progress: 1,
      };
      states.set(next.id, next);
      return { job: next };
    },
    async listPage(payload) {
      calls.push(["listPage", payload]);
      return {
        jobs: Array.from(states.values()),
        nextCursor: "next-1",
        hasMore: true,
      };
    },
    async requeue(payload) {
      calls.push(["requeue", payload]);
      return { job: { id: payload.jobId, status: "queued", progress: 0 } };
    },
  };
}

const normalized = normalizeAuthorityJobRecord({
  job_id: "job-a",
  type: "authority.vector.rebuild",
  state: "succeeded",
  progress: { current: 5, total: 10 },
  idempotency_key: "idem-a",
});
assert.equal(normalized.id, "job-a");
assert.equal(normalized.kind, "authority.vector.rebuild");
assert.equal(normalized.status, "succeeded");
assert.equal(normalized.progress, 0.5);
assert.equal(normalized.terminal, true);
assert.equal(normalized.success, true);
assert.equal(AUTHORITY_JOB_STATUS_TERMINAL.has("failed"), true);
assert.equal(AUTHORITY_JOB_STATUS_SUCCESS.has("completed"), true);

const list = normalizeAuthorityJobList({
  items: [{ id: "job-list", status: "running", progress: 33 }],
  next_cursor: "cursor-2",
});
assert.equal(list.jobs.length, 1);
assert.equal(list.jobs[0].progress, 0.33);
assert.equal(list.nextCursor, "cursor-2");

const recentJob = normalizeAuthorityRecentJobRecord(
  { id: "job-recent", status: "completed", progress: 1 },
  { updatedAt: "2026-04-28T08:00:00.000Z" },
);
assert.equal(recentJob.queueState, "success");
assert.equal(recentJob.updatedAt, "2026-04-28T08:00:00.000Z");

const mergedRecentJobs = mergeAuthorityRecentJobs(
  [
    { id: "job-old", status: "failed", updatedAt: "2026-04-28T07:50:00.000Z" },
    { id: "job-dup", status: "queued", updatedAt: "2026-04-28T07:45:00.000Z" },
  ],
  [
    { id: "job-new", status: "running", progress: 0.4 },
    { id: "job-dup", status: "completed", progress: 1 },
  ],
  { limit: 3, updatedAt: "2026-04-28T08:10:00.000Z" },
);
assert.deepEqual(mergedRecentJobs.map((job) => job.id), [
  "job-new",
  "job-dup",
  "job-old",
]);
assert.equal(mergedRecentJobs[0].queueState, "running");
assert.equal(mergedRecentJobs[1].queueState, "success");
assert.equal(mergedRecentJobs[1].updatedAt, "2026-04-28T08:10:00.000Z");

const idempotencyKey = buildAuthorityJobIdempotencyKey({
  kind: "authority.vector.rebuild",
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  revision: 7,
  range: { start: 5, end: 1 },
});
assert.equal(
  idempotencyKey,
  "st-bme:authority.vector.rebuild:chat-a:st-bme::chat-a:7:1-5",
);

const client = createMockJobClient();
const adapter = createAuthorityJobAdapter(
  { authorityBaseUrl: "/api/plugins/authority" },
  { jobClient: client },
);
const submitted = await adapter.submit(
  "authority.vector.rebuild",
  { chatId: "chat-a" },
  { idempotencyKey },
);
assert.equal(submitted.id, "job-1");
assert.equal(submitted.idempotencyKey, idempotencyKey);

const completed = await adapter.waitForCompletion(submitted.id, { timeoutMs: 1000 });
assert.equal(completed.status, "completed");
assert.equal(completed.success, true);
assert.equal(completed.waitDiagnostics.mode, "poll");
assert.equal(completed.waitDiagnostics.pollCount, 1);
assert.equal(completed.waitDiagnostics.terminal, true);

const page = await adapter.listPage({ limit: 10 });
assert.equal(page.jobs.length, 1);
assert.equal(page.nextCursor, "next-1");
assert.equal(page.hasMore, true);

const requeued = await adapter.requeue(submitted.id);
assert.equal(requeued.status, "queued");
assert.deepEqual(client.calls.map(([name]) => name), [
  "submit",
  "get",
  "listPage",
  "requeue",
]);

const trackerPhases = [];
let trackerLoadCount = 0;
const trackedJob = await trackAuthorityJobUntilTerminal({
  initialJob: {
    id: "job-track",
    kind: "authority.vector.rebuild",
    status: "queued",
    progress: 0,
    terminal: false,
    success: false,
  },
  pollIntervalMs: 0,
  timeoutMs: 1000,
  async loadJob(jobId) {
    trackerLoadCount += 1;
    if (trackerLoadCount === 1) {
      return {
        id: jobId,
        kind: "authority.vector.rebuild",
        status: "running",
        progress: 0.4,
        terminal: false,
        success: false,
      };
    }
    return {
      id: jobId,
      kind: "authority.vector.rebuild",
      status: "completed",
      progress: 1,
      terminal: true,
      success: true,
    };
  },
  async onUpdate(job, state) {
    trackerPhases.push([state.phase, job.status, Number(job.progress || 0)]);
  },
});
assert.equal(trackedJob.status, "completed");
assert.equal(trackedJob.success, true);
assert.equal(trackerLoadCount, 2);
assert.deepEqual(trackerPhases, [
  ["initial", "queued", 0],
  ["poll", "running", 0.4],
  ["terminal", "completed", 1],
]);

const streamedPhases = [];
const streamedModes = [];
const streamedJob = await trackAuthorityJobUntilTerminal({
  initialJob: {
    id: "job-stream",
    kind: "authority.vector.rebuild",
    status: "queued",
    progress: 0,
    terminal: false,
    success: false,
  },
  async streamJob(jobId) {
    return (async function* () {
      yield {
        job: {
          id: jobId,
          kind: "authority.vector.rebuild",
          status: "running",
          progress: 0.5,
          terminal: false,
          success: false,
        },
      };
      yield {
        job: {
          id: jobId,
          kind: "authority.vector.rebuild",
          status: "completed",
          progress: 1,
          terminal: true,
          success: true,
        },
      };
    })();
  },
  async onModeChange(state) {
    streamedModes.push([state.mode, state.reason]);
  },
  async onUpdate(job, state) {
    streamedPhases.push([state.phase, state.transport, job.status, Number(job.progress || 0)]);
  },
});
assert.equal(streamedJob.status, "completed");
assert.equal(streamedJob.success, true);
assert.deepEqual(streamedModes, [["stream", "stream-first"]]);
assert.deepEqual(streamedPhases, [
  ["initial", "stream", "queued", 0],
  ["stream", "stream", "running", 0.5],
  ["terminal", "stream", "completed", 1],
]);

const fallbackModes = [];
let fallbackLoadCount = 0;
const fallbackTrackedJob = await trackAuthorityJobUntilTerminal({
  initialJob: {
    id: "job-fallback",
    kind: "authority.vector.rebuild",
    status: "queued",
    progress: 0,
    terminal: false,
    success: false,
  },
  pollIntervalMs: 0,
  timeoutMs: 1000,
  async streamJob() {
    throw new Error("stream offline");
  },
  async loadJob(jobId) {
    fallbackLoadCount += 1;
    return {
      id: jobId,
      kind: "authority.vector.rebuild",
      status: "completed",
      progress: 1,
      terminal: true,
      success: true,
    };
  },
  async onModeChange(state) {
    fallbackModes.push([state.mode, state.reason]);
  },
});
assert.equal(fallbackTrackedJob.status, "completed");
assert.equal(fallbackLoadCount, 1);
assert.deepEqual(fallbackModes, [
  ["stream", "stream-first"],
  ["polling", "stream offline"],
]);

const timedOutJob = await trackAuthorityJobUntilTerminal({
  initialJob: {
    id: "job-timeout",
    status: "running",
    progress: 0.2,
    terminal: false,
    success: false,
  },
  pollIntervalMs: 5,
  timeoutMs: 1,
  async loadJob(jobId) {
    return {
      id: jobId,
      status: "running",
      progress: 0.3,
      terminal: false,
      success: false,
    };
  },
});
assert.equal(timedOutJob.status, "timeout");
assert.equal(timedOutJob.terminal, true);
assert.equal(timedOutJob.success, false);

let adapterTimeoutPolls = 0;
const timeoutAdapter = createAuthorityJobAdapter(
  {
    authorityBaseUrl: "/api/plugins/authority",
    authorityJobPollIntervalMs: 1,
    authorityJobPollMaxIntervalMs: 2,
    authorityJobPollBackoffFactor: 2,
  },
  {
    jobClient: {
      async get(payload = {}) {
        adapterTimeoutPolls += 1;
        return {
          job: {
            id: payload.jobId,
            status: "running",
            progress: 0.4,
          },
        };
      },
    },
  },
);
const adapterTimedOutJob = await timeoutAdapter.waitForCompletion("job-wait-timeout", { timeoutMs: 1 });
assert.equal(adapterTimedOutJob.status, "timeout");
assert.equal(adapterTimedOutJob.waitDiagnostics.mode, "poll");
assert.equal(adapterTimedOutJob.waitDiagnostics.pollCount >= 1, true);
assert.equal(adapterTimedOutJob.waitDiagnostics.lastStatus, "running");
assert.equal(adapterTimeoutPolls >= 1, true);

const streamingClient = {
  async streamJob(payload) {
    return (async function* () {
      yield {
        job: {
          id: payload.jobId,
          kind: "authority.vector.rebuild",
          status: "running",
          progress: 0.25,
          terminal: false,
          success: false,
        },
      };
      yield {
        job: {
          id: payload.jobId,
          kind: "authority.vector.rebuild",
          status: "completed",
          progress: 1,
          terminal: true,
          success: true,
        },
      };
    })();
  },
};
const streamingAdapter = createAuthorityJobAdapter(
  { authorityBaseUrl: "/api/plugins/authority" },
  { jobClient: streamingClient },
);
const streamedUpdates = [];
for await (const update of await streamingAdapter.stream("job-stream-adapter")) {
  streamedUpdates.push([update.status, Number(update.progress || 0)]);
}
assert.deepEqual(streamedUpdates, [
  ["running", 0.25],
  ["completed", 1],
]);

function createVectorControllerRuntime(overrides = {}) {
  const calls = [];
  const signal = {};
  const runtime = {
    calls,
    beginStageAbortController(stage) {
      calls.push(["beginStageAbortController", stage]);
      return { signal };
    },
    ensureCurrentGraphRuntimeState() {
      calls.push(["ensureCurrentGraphRuntimeState"]);
    },
    ensureGraphMutationReady(label) {
      calls.push(["ensureGraphMutationReady", label]);
      return true;
    },
    finishStageAbortController(stage, controller) {
      calls.push(["finishStageAbortController", stage, controller === null ? null : Boolean(controller)]);
    },
    getEmbeddingConfig() {
      return { mode: "authority", source: "authority-trivium" };
    },
    isAuthorityVectorConfig(config) {
      return config?.mode === "authority";
    },
    isBackendVectorConfig(config) {
      return config?.mode === "backend";
    },
    refreshPanelLiveState() {
      calls.push(["refreshPanelLiveState"]);
    },
    saveGraphToChat(payload) {
      calls.push(["saveGraphToChat", payload]);
    },
    shouldUseAuthorityJobs() {
      calls.push(["shouldUseAuthorityJobs"]);
      return true;
    },
    async submitAuthorityVectorRebuildJob(payload) {
      calls.push(["submitAuthorityVectorRebuildJob", payload]);
      return { submitted: true, job: { id: "job-vector", status: "queued" } };
    },
    async syncVectorState(payload) {
      calls.push(["syncVectorState", payload]);
      return { insertedHashes: [], stats: { indexed: 2, pending: 0 } };
    },
    toastr: {
      info(message) {
        calls.push(["toastr.info", message]);
      },
      success(message) {
        calls.push(["toastr.success", message]);
      },
      warning(message) {
        calls.push(["toastr.warning", message]);
      },
    },
    validateVectorConfig() {
      calls.push(["validateVectorConfig"]);
      return { valid: true };
    },
    ...overrides,
  };
  return runtime;
}

const jobControllerRuntime = createVectorControllerRuntime();
await onRebuildVectorIndexController(jobControllerRuntime);
assert.equal(
  jobControllerRuntime.calls.some(([name]) => name === "submitAuthorityVectorRebuildJob"),
  true,
);
assert.equal(
  jobControllerRuntime.calls.some(([name]) => name === "syncVectorState"),
  false,
);
assert.deepEqual(
  jobControllerRuntime.calls.find(([name]) => name === "saveGraphToChat")?.[1],
  { reason: "authority-vector-rebuild-job-submitted" },
);

const fallbackRuntime = createVectorControllerRuntime({
  async submitAuthorityVectorRebuildJob(payload) {
    this.calls.push(["submitAuthorityVectorRebuildJob", payload]);
    return { submitted: false, error: "job offline" };
  },
});
await onRebuildVectorIndexController(fallbackRuntime);
const fallbackSync = fallbackRuntime.calls.find(([name]) => name === "syncVectorState");
assert.equal(fallbackSync?.[1]?.purge, true);
assert.equal(
  fallbackRuntime.calls.some(([name]) => name === "toastr.warning"),
  true,
);

const range = { start: 1, end: 2 };
const rangeRuntime = createVectorControllerRuntime();
await onRebuildVectorIndexController(rangeRuntime, range);
assert.equal(
  rangeRuntime.calls.some(([name]) => name === "submitAuthorityVectorRebuildJob"),
  false,
);
const rangeSync = rangeRuntime.calls.find(([name]) => name === "syncVectorState");
assert.equal(rangeSync?.[1]?.purge, false);
assert.equal(rangeSync?.[1]?.range, range);

const httpRequests = [];
const httpAdapter = createAuthorityJobAdapter(
  { authorityBaseUrl: "https://authority.example.test/root" },
  {
    headerProvider: () => ({ "X-Test": "1" }),
    fetchImpl: async (url, options = {}) => {
      httpRequests.push({ url, options });
      if (url.endsWith("/session/init")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sessionToken: "job-session-token" };
          },
        };
      }
      if (url.endsWith("/jobs/create")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "job-http-1",
              type: "authority.vector.rebuild",
              status: "queued",
              progress: 0,
              idempotencyKey: "idem-http-1",
            };
          },
        };
      }
      if (url.endsWith("/jobs/job-http-1")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "job-http-1",
              type: "authority.vector.rebuild",
              status: "completed",
              progress: 1,
            };
          },
        };
      }
      if (url.endsWith("/jobs/list")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              jobs: [
                {
                  id: "job-http-1",
                  type: "authority.vector.rebuild",
                  status: "completed",
                  progress: 1,
                },
              ],
              page: {
                nextCursor: "next-http-1",
                hasMore: true,
              },
            };
          },
        };
      }
      if (url.endsWith("/jobs/job-http-1/requeue")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "job-http-2",
              type: "authority.vector.rebuild",
              status: "queued",
              progress: 0,
            };
          },
        };
      }
      if (url.endsWith("/jobs/job-http-1/cancel")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "job-http-1",
              type: "authority.vector.rebuild",
              status: "cancelled",
              progress: 1,
            };
          },
        };
      }
      return {
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      };
    },
  },
);

const httpSubmitted = await httpAdapter.submit(
  "authority.vector.rebuild",
  { chatId: "chat-http" },
  { idempotencyKey: "idem-http-1" },
);
assert.equal(httpSubmitted.id, "job-http-1");
const httpLoaded = await httpAdapter.get("job-http-1");
assert.equal(httpLoaded.status, "completed");
const httpPage = await httpAdapter.listPage({ cursor: "cursor-http", limit: 10 });
assert.equal(httpPage.nextCursor, "next-http-1");
assert.equal(httpPage.hasMore, true);
const httpRequeued = await httpAdapter.requeue("job-http-1");
assert.equal(httpRequeued.id, "job-http-2");
const httpCancelled = await httpAdapter.cancel("job-http-1");
assert.equal(httpCancelled.status, "cancelled");
assert.deepEqual(
  httpRequests.map((request) => request.url),
  [
    "https://authority.example.test/root/session/init",
    "https://authority.example.test/root/jobs/create",
    "https://authority.example.test/root/jobs/job-http-1",
    "https://authority.example.test/root/jobs/list",
    "https://authority.example.test/root/jobs/job-http-1/requeue",
    "https://authority.example.test/root/jobs/job-http-1/cancel",
  ],
);
assert.equal(httpRequests[1].options.headers["x-authority-session-token"], "job-session-token");
assert.equal(httpRequests[1].options.headers["X-Test"], "1");
assert.deepEqual(JSON.parse(String(httpRequests[1].options.body || "{}")), {
  type: "authority.vector.rebuild",
  payload: { chatId: "chat-http" },
  idempotencyKey: "idem-http-1",
});
assert.deepEqual(JSON.parse(String(httpRequests[3].options.body || "{}")), {
  page: {
    cursor: "cursor-http",
    limit: 10,
  },
});

console.log("authority-jobs tests passed");
