import assert from "node:assert/strict";

import { ensureDexieLoaded } from "../sync/bme-db.js";

const previousDocument = globalThis.document;
const previousDexie = globalThis.Dexie;
const previousLoadPromise = globalThis.__stBmeDexieLoadPromise;

try {
  globalThis.document = {};
  delete globalThis.Dexie;
  delete globalThis.__stBmeDexieLoadPromise;

  const DexieCtor = await ensureDexieLoaded();
  assert.equal(typeof DexieCtor, "function");
  assert.equal(globalThis.Dexie, DexieCtor);
} finally {
  if (previousDocument === undefined) {
    delete globalThis.document;
  } else {
    globalThis.document = previousDocument;
  }

  if (previousDexie === undefined) {
    delete globalThis.Dexie;
  } else {
    globalThis.Dexie = previousDexie;
  }

  if (previousLoadPromise === undefined) {
    delete globalThis.__stBmeDexieLoadPromise;
  } else {
    globalThis.__stBmeDexieLoadPromise = previousLoadPromise;
  }
}

console.log("dexie-loader tests passed");
