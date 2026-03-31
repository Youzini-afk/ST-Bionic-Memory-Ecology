import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PREFIX = "[ST-BME][PoC]";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_ROOT = path.join(__dirname, ".tmp-triviumdb-poc");
const DIM = 8;

function log(...args) {
  console.log(PREFIX, ...args);
}

function toErrorMessage(error) {
  if (!error) return "Unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function vecFrom(seed, dim = DIM) {
  const out = [];
  for (let i = 0; i < dim; i += 1) {
    const value = Math.sin(seed * 0.37 + i * 0.73) + Math.cos(seed * 0.17 + i * 0.29);
    out.push(Number(value.toFixed(6)));
  }
  return out;
}

function near(vec, jitter = 0.01) {
  return vec.map((v, i) => Number((v + (i % 2 === 0 ? jitter : -jitter)).toFixed(6)));
}

async function ensureCleanDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnNode(args, { timeoutMs = 6000, expectExitCode = null } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (finished) return;
          child.kill("SIGKILL");
          reject(new Error(`Child process timeout after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finished = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      finished = true;
      if (timer) clearTimeout(timer);
      if (expectExitCode !== null && code !== expectExitCode) {
        const hint = `expected=${expectExitCode}, actual=${code}, signal=${signal}`;
        return reject(
          new Error(`Child exit mismatch: ${hint}\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function resolveTriviumDbCtor() {
  const require = createRequire(import.meta.url);
  const loaded = require("triviumdb");
  const TriviumDB = loaded?.TriviumDB || loaded?.default || loaded;
  if (typeof TriviumDB !== "function") {
    throw new Error("triviumdb loaded but TriviumDB constructor not found");
  }
  return { TriviumDB, loaded };
}

async function runChildMode() {
  const mode = process.argv[2];
  if (!mode || !mode.startsWith("--child-")) return false;

  try {
    const { TriviumDB } = resolveTriviumDbCtor();
    const dbPath = process.argv[3];
    const dim = Number(process.argv[4] || DIM);

    if (!dbPath) {
      throw new Error("missing db path");
    }

    if (mode === "--child-flush-writer") {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      const db = new TriviumDB(dbPath, dim, "f32", "normal");
      const v = vecFrom(11, dim);
      const idA = db.insert(v, {
        chatId: "chat-flush",
        sourceFloor: 11,
        sourceRole: "assistant",
        label: "flush-a",
      });
      const idB = db.insert(near(v, 0.02), {
        chatId: "chat-flush",
        sourceFloor: 12,
        sourceRole: "user",
        label: "flush-b",
      });
      db.link(idA, idB, "related", 0.91);
      db.flush();
      console.log(JSON.stringify({ idA, idB }));
      process.exit(0);
    }

    if (mode === "--child-wal-writer") {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      const db = new TriviumDB(dbPath, dim, "f32", "normal");
      const base = vecFrom(17, dim);
      const idA = db.insert(base, {
        chatId: "chat-wal",
        sourceFloor: 21,
        sourceRole: "assistant",
        label: "wal-a",
      });
      const idB = db.insert(near(base, 0.015), {
        chatId: "chat-wal",
        sourceFloor: 22,
        sourceRole: "assistant",
        label: "wal-b",
      });
      db.link(idA, idB, "wal-link", 0.88);
      console.log(JSON.stringify({ idA, idB, ready: true }));
      setInterval(() => {
        // Keep process alive to be killed by parent, simulating crash.
      }, 1000);
      return true;
    }

    if (mode === "--child-open-only") {
      const db = new TriviumDB(dbPath, dim, "f32", "normal");
      void db;
      console.log("child-opened-ok");
      process.exit(0);
    }

    throw new Error(`unknown child mode: ${mode}`);
  } catch (error) {
    console.error(`${PREFIX}[child]`, toErrorMessage(error));
    process.exit(2);
  }

  return true;
}

async function main() {
  if (await runChildMode()) return;

  const report = {
    installability: "unknown",
    addonLoadability: "unknown",
    walRecovery: "unknown",
    dimensionBehavior: "unknown",
    averageSearchLatencyMs: null,
    recommendedSyncMode: "normal",
    goNoGo: "NO_GO",
    notes: [],
    cases: [],
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };

  const keyStatus = {
    loadModule: false,
    crud: false,
    search: false,
    flushReopen: false,
    walRecovery: false,
    dimensionMismatch: false,
    benchmark: false,
    concurrentSafety: false,
  };

  let TriviumDB = null;
  let triviumVersion = "unknown";

  const runCase = async (name, fn) => {
    const startedAt = performance.now();
    try {
      await fn();
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      report.cases.push({ name, status: "passed", durationMs });
      log(`✔ ${name} (${durationMs}ms)`);
      return true;
    } catch (error) {
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      const message = toErrorMessage(error);
      report.cases.push({ name, status: "failed", durationMs, error: message });
      report.notes.push(`${name} failed: ${message}`);
      log(`✘ ${name} (${durationMs}ms): ${message}`);
      return false;
    }
  };

  await ensureCleanDir(TMP_ROOT);

  await runCase("module-loadability", async () => {
    const ctorResult = resolveTriviumDbCtor();
    TriviumDB = ctorResult.TriviumDB;

    const require = createRequire(import.meta.url);
    try {
      const pkg = require("triviumdb/package.json");
      triviumVersion = pkg?.version || "unknown";
    } catch {
      triviumVersion = "unknown";
    }

    report.installability = "pass";
    report.addonLoadability = "pass";
    keyStatus.loadModule = true;
    report.environment.triviumdb = triviumVersion;
  });

  if (!TriviumDB) {
    report.installability = "fail";
    report.addonLoadability = "fail";
    report.goNoGo = "NO_GO";
    printFinalReport(report, keyStatus);
    process.exit(1);
  }

  await runCase("crud-link-neighbors-filter-flush", async () => {
    const dbPath = path.join(TMP_ROOT, "crud.tdb");
    const db = new TriviumDB(dbPath, DIM, "f32", "normal");

    const v1 = vecFrom(1);
    const v2 = near(v1, 0.005);
    const v3 = vecFrom(99);

    const id1 = db.insert(v1, {
      chatId: "chat-crud",
      sourceFloor: 1,
      sourceRole: "assistant",
      label: "node-1",
    });
    const id2 = db.insert(v2, {
      chatId: "chat-crud",
      sourceFloor: 1,
      sourceRole: "user",
      label: "node-2",
    });
    const id3 = db.insert(v3, {
      chatId: "chat-crud",
      sourceFloor: 2,
      sourceRole: "assistant",
      label: "node-3",
    });

    const got1 = db.get(id1);
    assert(got1 && got1.payload?.label === "node-1", "get(id1) should return inserted payload");

    db.updatePayload(id1, {
      ...got1.payload,
      label: "node-1-updated",
      sourceFloor: 3,
    });
    const got1Updated = db.get(id1);
    assert(got1Updated?.payload?.label === "node-1-updated", "updatePayload should take effect");

    db.updateVector(id2, near(v2, 0.02));
    const got2Updated = db.get(id2);
    assert(Array.isArray(got2Updated?.vector), "updateVector should keep vector readable");

    db.link(id1, id2, "related", 0.9);
    db.link(id1, id3, "related", 0.7);
    const neighbors = db.neighbors(id1, 1);
    assert(neighbors.includes(id2), "neighbors should contain linked id2");
    assert(neighbors.includes(id3), "neighbors should contain linked id3");

    db.unlink(id1, id3);
    const neighborsAfterUnlink = db.neighbors(id1, 1);
    assert(!neighborsAfterUnlink.includes(id3), "unlink should remove edge id1->id3");

    const floorMatched = db.filterWhere({ sourceFloor: 1 });
    assert(floorMatched.length >= 1, "filterWhere(sourceFloor=1) should return at least one node");
    assert(
      floorMatched.every((item) => item.payload?.sourceFloor === 1),
      "filterWhere should only return matching sourceFloor",
    );

    db.delete(id3);
    const got3 = db.get(id3);
    assert(got3 === null, "deleted node should not be retrievable");

    db.flush();
    keyStatus.crud = true;
  });

  await runCase("search-expandDepth", async () => {
    const dbPath = path.join(TMP_ROOT, "search.tdb");
    const db = new TriviumDB(dbPath, DIM, "f32", "normal");

    const clusterBase = vecFrom(5);
    const idAnchor = db.insert(clusterBase, {
      chatId: "chat-search",
      sourceFloor: 10,
      sourceRole: "assistant",
      label: "anchor",
    });
    const idNear = db.insert(near(clusterBase, 0.004), {
      chatId: "chat-search",
      sourceFloor: 11,
      sourceRole: "assistant",
      label: "near",
    });
    const idFar = db.insert(vecFrom(777), {
      chatId: "chat-search",
      sourceFloor: 99,
      sourceRole: "assistant",
      label: "far",
    });

    db.link(idAnchor, idFar, "jump", 0.8);

    const query = near(clusterBase, 0.002);
    const depth0 = db.search(query, 2, 0, -1);
    assert(Array.isArray(depth0) && depth0.length >= 1, "search depth0 should return hits");
    const depth0Ids = new Set(depth0.map((h) => h.id));
    assert(depth0Ids.has(idAnchor) || depth0Ids.has(idNear), "depth0 should include anchor cluster");

    const depth1 = db.search(query, 2, 1, -1);
    assert(Array.isArray(depth1) && depth1.length >= depth0.length, "depth1 should not shrink result size");

    keyStatus.search = true;
  });

  await runCase("flush-reopen-consistency", async () => {
    const dbPath = path.join(TMP_ROOT, "flush-reopen.tdb");
    const writer = await spawnNode(["--child-flush-writer", dbPath, String(DIM)], {
      timeoutMs: 5000,
      expectExitCode: 0,
    });

    const writerPayload = JSON.parse(writer.stdout.trim() || "{}");
    const db = new TriviumDB(dbPath, DIM, "f32", "normal");
    const gotA = db.get(writerPayload.idA);
    const gotB = db.get(writerPayload.idB);
    assert(gotA && gotB, "reopen after flush should read inserted nodes");

    const nearA = db.neighbors(writerPayload.idA, 1);
    assert(nearA.includes(writerPayload.idB), "reopen should preserve edge relation");

    keyStatus.flushReopen = true;
  });

  await runCase("wal-crash-recovery", async () => {
    const dbPath = path.join(TMP_ROOT, "wal-recovery.tdb");

    const child = spawn(process.execPath, [__filename, "--child-wal-writer", dbPath, String(DIM)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await delay(700);
    child.kill("SIGKILL");

    await new Promise((resolve) => child.once("close", resolve));

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    assert(lines.length >= 1, `wal child stdout is empty. stderr: ${stderr}`);
    const childPayload = JSON.parse(lines[0]);

    const walPath = `${dbPath}.wal`;
    const walExists = await fs
      .access(walPath)
      .then(() => true)
      .catch(() => false);

    const db = new TriviumDB(dbPath, DIM, "f32", "normal");
    const gotA = db.get(childPayload.idA);
    const gotB = db.get(childPayload.idB);
    assert(gotA && gotB, "reopen after crash should recover inserted nodes from WAL");

    const nearA = db.neighbors(childPayload.idA, 1);
    assert(nearA.includes(childPayload.idB), "recovered graph should include linked edge");

    report.walRecovery = "pass";
    report.notes.push(`WAL file existed after crash: ${walExists}`);
    keyStatus.walRecovery = true;
  });

  await runCase("dimension-mismatch-path", async () => {
    const dbPath = path.join(TMP_ROOT, "dim-mismatch.tdb");

    await spawnNode(["--child-flush-writer", dbPath, String(DIM)], {
      timeoutMs: 5000,
      expectExitCode: 0,
    });

    let mismatchError = null;
    let dbWrong = null;
    try {
      dbWrong = new TriviumDB(dbPath, DIM + 1, "f32", "normal");
    } catch (error) {
      mismatchError = error;
    }

    if (mismatchError) {
      const message = toErrorMessage(mismatchError).toLowerCase();
      assert(
        message.includes("dim") || message.includes("dimension") || message.includes("mismatch"),
        `unexpected mismatch error message: ${toErrorMessage(mismatchError)}`,
      );
      report.notes.push("dimension mismatch is rejected at constructor time");
    } else {
      // Newer triviumdb versions may not throw on constructor if file already exists.
      // In that case, dimension lock must still be effectively enforced at operation level.
      assert(dbWrong, "dbWrong instance should exist when constructor does not throw");

      const actualDim = typeof dbWrong.dim === "function" ? dbWrong.dim() : null;
      if (typeof actualDim === "number") {
        assert(actualDim === DIM, `existing db dim should remain ${DIM}, got ${actualDim}`);
      }

      let insertMismatchError = null;
      try {
        dbWrong.insert(vecFrom(333, DIM + 1), {
          chatId: "chat-dim",
          sourceFloor: 1,
          sourceRole: "assistant",
          label: "dim-mismatch-probe",
        });
      } catch (error) {
        insertMismatchError = error;
      }
      assert(insertMismatchError, "dimension mismatch should be rejected at operation level");
      report.notes.push("dimension mismatch is rejected at operation level (constructor tolerated)");
    }

    report.dimensionBehavior = "pass";
    keyStatus.dimensionMismatch = true;
  });

  await runCase("benchmark-100plus-nodes", async () => {
    const dbPath = path.join(TMP_ROOT, "benchmark.tdb");
    const db = new TriviumDB(dbPath, DIM, "f32", "normal");

    const totalNodes = 200;
    const ids = [];
    for (let i = 0; i < totalNodes; i += 1) {
      const id = db.insert(vecFrom(i + 1000), {
        chatId: "chat-bench",
        sourceFloor: i % 30,
        sourceRole: i % 2 === 0 ? "assistant" : "user",
        label: `bench-${i}`,
      });
      ids.push(id);
    }

    assert(ids.length === totalNodes, "benchmark insert count mismatch");

    const query = vecFrom(1042);
    const rounds = 60;
    let totalMs = 0;
    for (let i = 0; i < rounds; i += 1) {
      const t0 = performance.now();
      const hits = db.search(query, 8, 1, -1);
      totalMs += performance.now() - t0;
      assert(Array.isArray(hits), "benchmark search should return array");
    }

    const avg = Number((totalMs / rounds).toFixed(3));
    report.averageSearchLatencyMs = avg;
    keyStatus.benchmark = true;
  });

  await runCase("concurrent-safety-basic", async () => {
    const dbPath = path.join(TMP_ROOT, "concurrency.tdb");
    const db = new TriviumDB(dbPath, DIM, "f32", "normal");

    const base = vecFrom(88);
    const id0 = db.insert(base, {
      chatId: "chat-concurrency",
      sourceFloor: 1,
      sourceRole: "assistant",
      label: "seed",
    });

    const tasks = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() => {
        const id = db.insert(near(base, 0.001 * (i + 1)), {
          chatId: "chat-concurrency",
          sourceFloor: i + 2,
          sourceRole: "assistant",
          label: `c-${i}`,
        });
        db.link(id0, id, "fanout", 0.5 + i * 0.01);
        const got = db.get(id);
        assert(got && got.payload?.label === `c-${i}`, `concurrency insert/get failed at task ${i}`);
        const hits = db.search(base, 5, 1, -1);
        assert(Array.isArray(hits), "concurrency search should return array");
      }),
    );

    await Promise.all(tasks);

    const openedByChild = await spawnNode(["--child-open-only", dbPath, String(DIM)], {
      timeoutMs: 5000,
    }).then(
      (res) => res,
      (error) => ({ error }),
    );

    if (openedByChild?.error) {
      const msg = toErrorMessage(openedByChild.error).toLowerCase();
      const lockLikely = msg.includes("lock") || msg.includes("busy") || msg.includes("in use") || msg.includes("already");
      assert(lockLikely, `expected lock error for second process open, got: ${toErrorMessage(openedByChild.error)}`);
    } else {
      assert(openedByChild.code !== 0, "second process open should fail while parent instance is active");
    }

    keyStatus.concurrentSafety = true;
  });

  const required = [
    keyStatus.loadModule,
    keyStatus.crud,
    keyStatus.search,
    keyStatus.flushReopen,
    keyStatus.walRecovery,
    keyStatus.dimensionMismatch,
    keyStatus.benchmark,
    keyStatus.concurrentSafety,
  ];

  const allRequiredPassed = required.every(Boolean);

  if (allRequiredPassed) {
    report.goNoGo = "GO";
    report.installability = "pass";
    report.addonLoadability = "pass";
    report.walRecovery = report.walRecovery === "unknown" ? "pass" : report.walRecovery;
    report.dimensionBehavior = report.dimensionBehavior === "unknown" ? "pass" : report.dimensionBehavior;
    report.recommendedSyncMode = "normal";
    report.notes.push("Recommended syncMode=normal for balanced durability/performance in ST-BME plugin workload.");
  } else {
    report.goNoGo = "NO_GO";
    if (report.installability === "unknown") report.installability = "fail";
    if (report.addonLoadability === "unknown") report.addonLoadability = "fail";
    if (report.walRecovery === "unknown") report.walRecovery = keyStatus.walRecovery ? "pass" : "fail";
    if (report.dimensionBehavior === "unknown") report.dimensionBehavior = keyStatus.dimensionMismatch ? "pass" : "fail";
    report.notes.push("One or more critical Phase-0 checks failed. Consider Plan B sidecar mode.");
  }

  printFinalReport(report, keyStatus);

  process.exit(allRequiredPassed ? 0 : 1);
}

function printFinalReport(report, keyStatus) {
  const passed = report.cases.filter((item) => item.status === "passed").length;
  const failed = report.cases.filter((item) => item.status === "failed").length;

  log("================ FINAL SUMMARY ================");
  log(`cases: total=${report.cases.length}, passed=${passed}, failed=${failed}`);
  log(`installability=${report.installability}, addonLoadability=${report.addonLoadability}`);
  log(`walRecovery=${report.walRecovery}, dimensionBehavior=${report.dimensionBehavior}`);
  log(`averageSearchLatencyMs=${report.averageSearchLatencyMs}`);
  log(`recommendedSyncMode=${report.recommendedSyncMode}`);
  log(`goNoGo=${report.goNoGo}`);
  log(`keyStatus=${JSON.stringify(keyStatus)}`);

  console.log(`${PREFIX} report-json ${JSON.stringify(report, null, 2)}`);
}

main().catch((error) => {
  console.error(`${PREFIX} fatal:`, toErrorMessage(error));
  process.exit(1);
});
