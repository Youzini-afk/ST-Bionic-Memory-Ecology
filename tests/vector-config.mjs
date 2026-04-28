import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadVectorHelpers() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.resolve(__dirname, "../vector/vector-index.js");
  const source = await fs.readFile(sourcePath, "utf8");

  const pieces = [
    source.match(/export const BACKEND_VECTOR_SOURCES = \[[\s\S]*?\];/m)?.[0],
    source.match(/export const BACKEND_DEFAULT_MODELS = \{[\s\S]*?\};/m)?.[0],
    source.match(/const BACKEND_SOURCES_REQUIRING_API_URL = new Set\([\s\S]*?\);/m)?.[0],
    source.match(/const VECTOR_REQUEST_TIMEOUT_MS = \d+;/m)?.[0],
    source.match(/function getConfiguredTimeoutMs\(config = \{\}\) \{[\s\S]*?^\}/m)?.[0],
    source.match(/export function normalizeOpenAICompatibleBaseUrl\(value, autoSuffix = true\) \{[\s\S]*?^\}/m)?.[0],
    source.match(/export function getVectorConfigFromSettings\(settings = \{\}\) \{[\s\S]*?^\}/m)?.[0],
    source.match(/export function isBackendVectorConfig\(config\) \{[\s\S]*?^\}/m)?.[0],
    source.match(/export function isDirectVectorConfig\(config\) \{[\s\S]*?^\}/m)?.[0],
    source.match(/export function validateVectorConfig\(config\) \{[\s\S]*?^\}/m)?.[0],
  ].filter(Boolean);

  if (pieces.length < 10) {
    throw new Error("无法从 vector-index.js 提取向量配置辅助函数");
  }

  const context = vm.createContext({});
  const script = new vm.Script(`
${pieces.join("\n\n").replaceAll("export ", "")}
this.getVectorConfigFromSettings = getVectorConfigFromSettings;
this.validateVectorConfig = validateVectorConfig;
  `);
  script.runInContext(context);
  return {
    getVectorConfigFromSettings: context.getVectorConfigFromSettings,
    validateVectorConfig: context.validateVectorConfig,
  };
}

const { getVectorConfigFromSettings, validateVectorConfig } =
  await loadVectorHelpers();

const backendConfig = getVectorConfigFromSettings({
  embeddingTransportMode: "backend",
  embeddingBackendSource: "openai",
  embeddingBackendModel: "",
});
assert.equal(backendConfig.mode, "backend");
assert.equal(backendConfig.source, "openai");
assert.equal(backendConfig.model, "text-embedding-3-small");
assert.equal(validateVectorConfig(backendConfig).valid, true);

const directConfig = getVectorConfigFromSettings({
  embeddingTransportMode: "direct",
  embeddingApiUrl: "https://example.com/v1/embeddings",
  embeddingApiKey: "sk-test",
  embeddingModel: "text-embedding-3-small",
});
assert.equal(directConfig.mode, "direct");
assert.equal(directConfig.apiUrl, "https://example.com/v1");
assert.equal(validateVectorConfig(directConfig).valid, true);

const defaultModeConfig = getVectorConfigFromSettings({
  embeddingApiUrl: "https://example.com/v1/embeddings",
  embeddingApiKey: "sk-test",
  embeddingModel: "text-embedding-3-small",
});
assert.equal(defaultModeConfig.mode, "direct");
assert.equal(validateVectorConfig(defaultModeConfig).valid, true);

const validAuthorityConfig = {
  mode: "authority",
  source: "authority-trivium",
  baseUrl: "/api/plugins/authority",
  apiUrl: "https://example.com/v1",
  model: "text-embedding-3-small",
};
assert.equal(validateVectorConfig(validAuthorityConfig).valid, true);

const invalidAuthorityConfig = {
  mode: "authority",
  source: "authority-trivium",
  baseUrl: "/api/plugins/authority",
  apiUrl: "",
  model: "",
};
assert.equal(validateVectorConfig(invalidAuthorityConfig).valid, false);

const validAuthorityBackendConfig = {
  mode: "authority",
  source: "authority-trivium",
  baseUrl: "/api/plugins/authority",
  embeddingMode: "backend",
  embeddingSource: "openai",
  apiUrl: "",
  model: "text-embedding-3-small",
};
assert.equal(validateVectorConfig(validAuthorityBackendConfig).valid, true);

const invalidAuthorityBackendConfig = {
  mode: "authority",
  source: "authority-trivium",
  baseUrl: "/api/plugins/authority",
  embeddingMode: "backend",
  embeddingSource: "vllm",
  apiUrl: "",
  model: "BAAI/bge-m3",
};
assert.equal(validateVectorConfig(invalidAuthorityBackendConfig).valid, false);

const authorityLikeConfig = getVectorConfigFromSettings({
  embeddingApiUrl: "https://example.com/v1/embeddings",
  embeddingApiKey: "sk-test",
  embeddingModel: "text-embedding-3-small",
});
assert.equal(authorityLikeConfig.apiUrl, "https://example.com/v1");
assert.equal(authorityLikeConfig.model, "text-embedding-3-small");

const invalidBackendConfig = getVectorConfigFromSettings({
  embeddingTransportMode: "backend",
  embeddingBackendSource: "vllm",
  embeddingBackendApiUrl: "",
  embeddingBackendModel: "BAAI/bge-m3",
});
assert.equal(validateVectorConfig(invalidBackendConfig).valid, false);

console.log("vector-config tests passed");
