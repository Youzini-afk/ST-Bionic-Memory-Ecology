import assert from "node:assert/strict";

import {
  createVectorManifest,
  deriveVectorSpace,
  isVectorManifestCompatible,
  normalizeVectorApiUrl,
  summarizeVectorSpaceChange,
} from "../vector/vector-space.js";

assert.equal(
  normalizeVectorApiUrl("https://example.com/v1/embeddings?key=secret"),
  "https://example.com/v1",
);

const baseConfig = {
  mode: "direct",
  apiUrl: "https://example.com/v1/embeddings",
  apiKey: "sk-should-not-appear",
  model: "text-embedding-3-small",
};

const space1536 = deriveVectorSpace(baseConfig, 1536, { probedAt: 1 });
const sameSpace = deriveVectorSpace(
  { ...baseConfig, apiKey: "sk-different" },
  1536,
  { probedAt: 2 },
);
assert.equal(space1536.vectorSpaceId, sameSpace.vectorSpaceId);
assert.equal(JSON.stringify(space1536).includes("sk-should-not-appear"), false);
assert.equal(space1536.observedDim, 1536);

const space3072 = deriveVectorSpace(baseConfig, 3072, { probedAt: 3 });
assert.notEqual(space1536.vectorSpaceId, space3072.vectorSpaceId);
assert.equal(summarizeVectorSpaceChange(space1536, space3072), "dimension-changed");

const differentModel = deriveVectorSpace(
  { ...baseConfig, model: "text-embedding-3-large" },
  1536,
  { probedAt: 4 },
);
assert.notEqual(space1536.vectorSpaceId, differentModel.vectorSpaceId);
assert.equal(summarizeVectorSpaceChange(space1536, differentModel), "model-changed");

const differentEndpoint = deriveVectorSpace(
  { ...baseConfig, apiUrl: "https://other.example.com/v1/embeddings" },
  1536,
  { probedAt: 5 },
);
assert.notEqual(space1536.vectorSpaceId, differentEndpoint.vectorSpaceId);
assert.equal(summarizeVectorSpaceChange(space1536, differentEndpoint), "endpoint-changed");

const manifest = createVectorManifest({
  backend: "local",
  vectorSpace: space1536,
  status: "clean",
  nodeCount: 2,
  embeddedNodeCount: 2,
});
assert.equal(isVectorManifestCompatible(manifest, space1536), true);
assert.equal(isVectorManifestCompatible(manifest, space3072), false);
assert.equal(
  isVectorManifestCompatible({ ...manifest, status: "stale" }, space1536),
  false,
);

console.log("vector-space tests passed");
