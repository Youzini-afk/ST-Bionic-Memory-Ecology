import assert from "node:assert/strict";
import { AgentToolRegistry } from "../agent/tool-registry.js";

const registry = new AgentToolRegistry();
registry.register(
  {
    name: "lookup",
    description: "Look up one memory key",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  },
  async ({ key }) => ({ version: 1, key }),
  { readOnly: true, idempotent: true },
);
const firstSnapshot = registry.capture();
assert.deepEqual(firstSnapshot.catalog.map((entry) => entry.name), ["lookup"]);
assert.equal(firstSnapshot.catalog[0].readOnly, true);
assert.equal(firstSnapshot.catalog[0].idempotent, true);

registry.register(
  {
    name: "lookup",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" } },
      additionalProperties: false,
    },
  },
  async ({ key }) => ({ version: 2, key }),
  { replace: true },
);
const secondSnapshot = registry.capture();

const oldResult = await firstSnapshot.execute({
  id: "call-old",
  name: "lookup",
  arguments: '{"key":"alpha"}',
});
const newResult = await secondSnapshot.execute({
  id: "call-new",
  name: "lookup",
  arguments: '{"key":"alpha"}',
});
assert.equal(oldResult.value.version, 1, "captured runs keep their original implementation");
assert.equal(newResult.value.version, 2);
assert.notEqual(firstSnapshot.fingerprint, secondSnapshot.fingerprint);

const invalid = await firstSnapshot.execute({
  id: "call-invalid",
  name: "lookup",
  arguments: '{"key":"","extra":true}',
});
assert.equal(invalid.ok, false);
assert.equal(invalid.error.code, "invalid_arguments");
assert.ok(invalid.error.details.issues.length >= 2);

const unknown = await firstSnapshot.execute({ name: "missing", arguments: "{}" });
assert.equal(unknown.error.code, "unknown_tool");

const largePayload = "x".repeat(70_000);
const largeRegistry = new AgentToolRegistry();
largeRegistry.register({ name: "large" }, async () => largePayload);
const largeResult = await largeRegistry.capture().execute({ name: "large", arguments: "{}" });
assert.equal(largeResult.content.length, largePayload.length);

console.log("Agent tool registry tests passed");
