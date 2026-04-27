import assert from "node:assert/strict";
import {
  AUTHORITY_JOB_STATUS_TERMINAL,
  AUTHORITY_JOB_STATUS_SUCCESS,
  buildAuthorityJobIdempotencyKey,
  createAuthorityJobAdapter,
  normalizeAuthorityJobList,
  normalizeAuthorityJobRecord,
} from "../maintenance/authority-job-adapter.js";
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

console.log("authority-jobs tests passed");
