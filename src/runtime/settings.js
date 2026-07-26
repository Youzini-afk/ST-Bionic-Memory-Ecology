import {
  createDefaultGlobalTaskRegex,
  createDefaultTaskProfiles,
  ensureTaskProfiles,
  normalizeGlobalTaskRegex,
} from "../../prompting/prompt-profiles.js";
import { normalizeEnaOptions } from "../planner/ena-planner.js";

export const SETTINGS_KEY = "st_bme_v9";
export const STORAGE_PRIMARIES = Object.freeze(["indexeddb", "authority"]);

const DEFAULTS = Object.freeze({
  enabled: true,
  primary: "indexeddb",
  debugLoggingEnabled: false,
  timeoutMs: 300000,

  extractAutoEnabled: true,
  extractEvery: 1,
  extractContextTurns: 2,
  extractAutoDelayLatestAssistant: false,
  extractAssistantExtractTags: "",
  extractAssistantExcludeTags: "think,analysis,reasoning",
  extractAssistantExtractRules: [],
  extractAssistantExcludeRules: [],
  extractRecentMessageCap: 0,
  extractPromptStructuredMode: "both",
  extractSplitExecutionMode: "parallel",
  extractWorldbookMode: "active",
  extractIncludeStoryTime: true,
  extractIncludeSummaries: true,
  extractActionMode: "pending",

  recallEnabled: true,
  recallTopK: 20,
  recallMaxNodes: 12,
  recallEnableLLM: true,
  recallEnableVectorPrefilter: true,
  recallEnableGraphDiffusion: true,
  recallDiffusionTopK: 100,
  recallLlmCandidatePool: 30,
  recallLlmContextMessages: 4,
  recallEnableMultiIntent: true,
  recallMultiIntentMaxSegments: 4,
  recallEnableContextQueryBlend: true,
  recallContextAssistantWeight: 0.2,
  recallContextPreviousUserWeight: 0.1,
  recallEnableLexicalBoost: true,
  recallLexicalWeight: 0.18,
  recallTeleportAlpha: 0.15,
  recallEnableTemporalLinks: true,
  recallTemporalLinkStrength: 0.2,
  recallEnableDiversitySampling: true,
  recallDppCandidateMultiplier: 3,
  recallDppQualityWeight: 1,
  recallEnableCooccurrenceBoost: false,
  recallCooccurrenceScale: 0.1,
  recallCooccurrenceMaxNeighbors: 10,
  recallEnableResidualRecall: false,
  recallResidualBasisMaxNodes: 24,
  recallNmfTopics: 15,
  recallNmfNoveltyThreshold: 0.4,
  recallResidualThreshold: 0.3,
  recallResidualTopK: 5,
  enableScopedMemory: true,
  enablePovMemory: true,
  enableRegionScopedObjective: true,
  enableCognitiveMemory: true,
  enableSpatialAdjacency: true,
  enableStoryTimeline: true,
  injectStoryTimeLabel: true,
  storyTimeSoftDirecting: true,
  recallCharacterPovWeight: 1.25,
  recallUserPovWeight: 1.05,
  recallObjectiveCurrentRegionWeight: 1.15,
  recallObjectiveAdjacentRegionWeight: 0.9,
  recallObjectiveGlobalWeight: 0.75,
  injectUserPovMemory: true,
  injectObjectiveGlobalMemory: true,
  injectLowConfidenceObjectiveMemory: false,

  injectPosition: 1,
  injectDepth: 9999,
  injectRole: 0,
  graphWeight: 0.6,
  vectorWeight: 0.3,
  importanceWeight: 0.1,

  llmApiUrl: "",
  llmApiKey: "",
  llmModel: "",
  llmPresets: {},
  llmActivePreset: "",

  embeddingApiUrl: "",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  embeddingTransportMode: "direct",
  embeddingBackendSource: "openai",
  embeddingBackendModel: "text-embedding-3-small",
  embeddingBackendApiUrl: "",
  embeddingAutoSuffix: true,
  embeddingDimensions: 0,
  embeddingBatchSize: 10,

  authorityBaseUrl: "/api/plugins/authority",
  authorityGraphQueryEnabled: true,

  taskProfiles: null,
  globalTaskRegex: null,

  enableConsolidation: true,
  consolidationNeighborCount: 5,
  consolidationThreshold: 0.85,
  enableHierarchicalSummary: true,
  smallSummaryEveryNExtractions: 3,
  summaryRollupFanIn: 3,
  enableVisibility: true,
  enableCrossRecall: true,
  enableSmartTrigger: false,
  triggerPatterns: "",
  smartTriggerThreshold: 2,
  enableSleepCycle: false,
  forgetThreshold: 0.5,
  sleepEveryN: 10,
  enableProbRecall: false,
  probRecallChance: 0.15,
  enableReflection: true,
  reflectEveryN: 10,
  consolidationAutoMinNewNodes: 2,
  enableAutoCompression: true,
  compressionEveryN: 10,
  parallelVectorQueryConcurrency: 3,
  parallelNeighborQueryConcurrency: 3,
  parallelLlmConcurrency: 2,

  ena: null,
  panelTheme: "crimson",
});

const KEYS = new Set(Object.keys(DEFAULTS));

function clone(value) {
  return structuredClone(value);
}

export function createDefaultSettings() {
  return {
    ...clone(DEFAULTS),
    taskProfiles: createDefaultTaskProfiles(),
    globalTaskRegex: createDefaultGlobalTaskRegex(),
    ena: normalizeEnaOptions(),
  };
}

function normalizePrimitive(key, value, fallback) {
  if (typeof fallback === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
    return value;
  }
  if (typeof fallback === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${key} must be a finite number`);
    return number;
  }
  if (typeof fallback === "string") {
    if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
    return value;
  }
  return clone(value);
}

export function normalizeSettings(value = undefined) {
  const defaults = createDefaultSettings();
  if (value === undefined || value === null) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("BME v9 settings must be an object");
  }
  const unknown = Object.keys(value).find((key) => !KEYS.has(key));
  if (unknown) throw new TypeError(`unknown BME v9 setting: ${unknown}`);
  const settings = { ...defaults };
  for (const [key, entry] of Object.entries(value)) {
    if (["taskProfiles", "globalTaskRegex", "ena", "primary"].includes(key)) continue;
    if (key === "llmPresets") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("llmPresets must be an object");
      }
      settings.llmPresets = clone(entry);
      continue;
    }
    if (["extractAssistantExtractRules", "extractAssistantExcludeRules"].includes(key)) {
      if (!Array.isArray(entry)) throw new TypeError(`${key} must be an array`);
      settings[key] = clone(entry);
      continue;
    }
    settings[key] = normalizePrimitive(key, entry, defaults[key]);
  }
  const primary = String(value.primary ?? defaults.primary).trim().toLowerCase();
  if (!STORAGE_PRIMARIES.includes(primary)) {
    throw new TypeError(`primary must be one of: ${STORAGE_PRIMARIES.join(", ")}`);
  }
  settings.primary = primary;
  settings.taskProfiles = ensureTaskProfiles({ taskProfiles: value.taskProfiles ?? defaults.taskProfiles });
  settings.globalTaskRegex = normalizeGlobalTaskRegex(
    value.globalTaskRegex ?? defaults.globalTaskRegex,
  );
  settings.ena = normalizeEnaOptions(value.ena ?? defaults.ena);
  if (!Number.isSafeInteger(settings.injectPosition) || ![-1, 0, 1, 2].includes(settings.injectPosition)) {
    throw new TypeError("injectPosition must be a SillyTavern extension prompt position");
  }
  if (!Number.isSafeInteger(settings.injectRole) || ![0, 1, 2].includes(settings.injectRole)) {
    throw new TypeError("injectRole must be a SillyTavern extension prompt role");
  }
  if (!Number.isSafeInteger(settings.injectDepth) || settings.injectDepth < 0 || settings.injectDepth > 10000) {
    throw new TypeError("injectDepth must be an integer between 0 and 10000");
  }
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs < 1000) {
    throw new TypeError("timeoutMs must be at least 1000");
  }
  return settings;
}

export function patchSettings(current, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("settings patch must be an object");
  }
  return normalizeSettings({ ...clone(current), ...clone(patch) });
}
