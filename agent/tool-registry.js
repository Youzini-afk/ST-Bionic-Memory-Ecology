import {
  cloneDomainValue,
  freezeDomainValue,
  hashDomainValue,
  stableStringify,
} from "../domain/memory-id.js";
import { BmeAgentProtocolError, isAbortLikeError } from "./errors.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "object") return isPlainObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    return typeof value === type;
  });
}

function validateSchemaNode(value, schema, path, issues) {
  if (!isPlainObject(schema)) return;
  if (schema.const !== undefined && stableStringify(value) !== stableStringify(schema.const)) {
    issues.push(`${path} must equal the schema constant`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => stableStringify(candidate) === stableStringify(value))
  ) {
    issues.push(`${path} is not one of the allowed values`);
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}; received ${valueType(value)}`);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateSchemaNode(value, child, path, issues);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((child) => {
      const nested = [];
      validateSchemaNode(value, child, path, nested);
      return nested.length === 0;
    });
    if (!matched) issues.push(`${path} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const count = schema.oneOf.filter((child) => {
      const nested = [];
      validateSchemaNode(value, child, path, nested);
      return nested.length === 0;
    }).length;
    if (count !== 1) issues.push(`${path} must match exactly one allowed schema`);
  }
  if (isPlainObject(schema.not)) {
    const nested = [];
    validateSchemaNode(value, schema.not, path, nested);
    if (nested.length === 0) issues.push(`${path} matches a forbidden schema`);
  }
  if (typeof value === "string") {
    if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) {
      issues.push(`${path} is shorter than minLength`);
    }
    if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) {
      issues.push(`${path} is longer than maxLength`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(String(schema.pattern)).test(value)) {
          issues.push(`${path} does not match the required pattern`);
        }
      } catch {
        issues.push(`${path} has an invalid schema pattern`);
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isFinite(Number(schema.minimum)) && value < Number(schema.minimum)) {
      issues.push(`${path} is below minimum`);
    }
    if (Number.isFinite(Number(schema.maximum)) && value > Number(schema.maximum)) {
      issues.push(`${path} is above maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(Number(schema.minItems)) && value.length < Number(schema.minItems)) {
      issues.push(`${path} has fewer than minItems`);
    }
    if (Number.isFinite(Number(schema.maxItems)) && value.length > Number(schema.maxItems)) {
      issues.push(`${path} has more than maxItems`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateSchemaNode(item, schema.items, `${path}[${index}]`, issues),
      );
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        issues.push(`${path}.${required} is required`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (properties[key]) {
        validateSchemaNode(entry, properties[key], `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push(`${path}.${key} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateSchemaNode(entry, schema.additionalProperties, `${path}.${key}`, issues);
      }
    }
  }
}

export function validateAgentToolArguments(value, schema = {}) {
  const issues = [];
  validateSchemaNode(value, schema, "$", issues);
  return { valid: issues.length === 0, issues };
}

function normalizeToolDefinition(definition = {}) {
  const source = definition?.type === "function" ? definition.function || {} : definition;
  const name = String(source.name || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
    throw new TypeError(`invalid Agent tool name: ${name || "<empty>"}`);
  }
  const parameters = isPlainObject(source.parameters)
    ? source.parameters
    : isPlainObject(source.inputSchema)
      ? source.inputSchema
      : { type: "object", properties: {}, additionalProperties: false };
  return freezeDomainValue({
    type: "function",
    function: {
      name,
      description: String(source.description || "").trim(),
      parameters: cloneDomainValue(parameters, parameters),
    },
  });
}

function parseToolArguments(value) {
  if (isPlainObject(value)) return cloneDomainValue(value, value);
  if (value === null || value === undefined || value === "") return {};
  if (typeof value !== "string") {
    throw new BmeAgentProtocolError("tool arguments must be a JSON object or JSON string");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new BmeAgentProtocolError("tool arguments are not valid JSON", {
      parseError: error?.message || String(error),
    });
  }
  if (!isPlainObject(parsed)) {
    throw new BmeAgentProtocolError("tool arguments must decode to an object");
  }
  return parsed;
}

function serializeToolResult(value) {
  if (typeof value === "string") return value;
  const serialized = stableStringify(value);
  return serialized === undefined ? "null" : serialized;
}

function failureResult(code, message, details = {}) {
  const value = { ok: false, error: { code, message, details } };
  return {
    ok: false,
    value,
    content: serializeToolResult(value),
    error: value.error,
  };
}

export class AgentToolRegistry {
  constructor() {
    this._entries = new Map();
    this._version = 0;
  }

  register(definition, handler, options = {}) {
    if (typeof handler !== "function") throw new TypeError("Agent tool handler is required");
    const normalizedDefinition = normalizeToolDefinition(definition);
    const name = normalizedDefinition.function.name;
    if (this._entries.has(name) && options.replace !== true) {
      throw new Error(`Agent tool is already registered: ${name}`);
    }
    this._version += 1;
    const entry = Object.freeze({
      name,
      definition: normalizedDefinition,
      handler,
      registrationVersion: this._version,
      readOnly: options.readOnly === true,
      idempotent: options.idempotent === true,
      parallelSafe: options.parallelSafe === true,
      projectResult: typeof options.projectResult === "function" ? options.projectResult : null,
    });
    this._entries.set(name, entry);
    return () => {
      if (this._entries.get(name) === entry) this._entries.delete(name);
    };
  }

  capture() {
    const entries = new Map(this._entries);
    const definitions = freezeDomainValue(
      [...entries.values()].map((entry) => cloneDomainValue(entry.definition, entry.definition)),
    );
    const fingerprint = hashDomainValue(
      [...entries.values()].map((entry) => ({
        definition: entry.definition,
        registrationVersion: entry.registrationVersion,
      })),
    );
    return Object.freeze({
      fingerprint,
      definitions,
      names: Object.freeze([...entries.keys()]),
      execute: async (toolCall, scope = {}) => {
        const name = String(toolCall?.name || toolCall?.function?.name || "").trim();
        const entry = entries.get(name);
        if (!entry) return failureResult("unknown_tool", `Unknown Agent tool: ${name || "<empty>"}`);
        let args;
        try {
          args = parseToolArguments(
            toolCall?.arguments ?? toolCall?.function?.arguments ?? {},
          );
        } catch (error) {
          return failureResult(error.code || "invalid_arguments", error.message, error.details);
        }
        const validation = validateAgentToolArguments(
          args,
          entry.definition.function.parameters,
        );
        if (!validation.valid) {
          return failureResult(
            "invalid_arguments",
            `Invalid arguments for ${name}`,
            { issues: validation.issues },
          );
        }
        try {
          const rawValue = await entry.handler(args, {
            ...scope,
            toolName: name,
            registrationVersion: entry.registrationVersion,
            readOnly: entry.readOnly,
            idempotent: entry.idempotent,
          });
          const projected = entry.projectResult
            ? await entry.projectResult(rawValue, { ...scope, arguments: args })
            : rawValue;
          const value = projected === undefined ? null : projected;
          return { ok: true, value, content: serializeToolResult(value), error: null };
        } catch (error) {
          if (isAbortLikeError(error) || scope.signal?.aborted) throw error;
          return failureResult("tool_error", error?.message || String(error), {
            name: error?.name || "Error",
            code: String(error?.code || ""),
            details:
              error?.details && typeof error.details === "object"
                ? cloneDomainValue(error.details, {})
                : {},
          });
        }
      },
    });
  }
}
