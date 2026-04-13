import {
  createDefaultGlobalTaskRegex,
  createDefaultTaskProfiles,
} from "../prompting/prompt-profiles.js";

function clampIntValue(value, fallback = 0, min = 0, max = 9999) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

export const defaultSettings = {
  enabled: true,
  debugLoggingEnabled: false,
  timeoutMs: 300000,
  hideOldMessagesEnabled: false,
  hideOldMessagesKeepLastN: 12,

  // 提取设置
  extractEvery: 1,
  extractContextTurns: 2,
  extractAutoDelayLatestAssistant: false,
  extractAssistantExtractTags: "",
  extractAssistantExcludeTags: "think,analysis,reasoning",
  extractAssistantExtractRules: [],
  extractAssistantExcludeRules: [],
  extractRecentMessageCap: 0,
  extractPromptStructuredMode: "both",
  extractWorldbookMode: "active",
  extractIncludeStoryTime: true,
  extractIncludeSummaries: true,
  extractActionMode: "pending",

  // 召回设置
  recallEnabled: true,
  recallCardUserInputDisplayMode: "beautify_only",
  worldInfoFilterMode: "default",
  worldInfoFilterCustomKeywords: "",
  recallTopK: 20,
  recallMaxNodes: 8,
  recallEnableLLM: true,
  recallEnableVectorPrefilter: true,
  recallEnableGraphDiffusion: true,
  recallDiffusionTopK: 100,
  recallLlmCandidatePool: 30,
  recallLlmContextMessages: 4,
  recallUseAuthoritativeGenerationInput: false,
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
  recallDppQualityWeight: 1.0,
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
  enableAiMonitor: false,
  injectLowConfidenceObjectiveMemory: false,
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

  // 注入设置
  injectPosition: "atDepth",
  injectDepth: 9999,
  injectRole: 0,

  // 混合评分权重
  graphWeight: 0.6,
  vectorWeight: 0.3,
  importanceWeight: 0.1,

  // 记忆 LLM（留空时复用当前酒馆模型）
  llmApiUrl: "",
  llmApiKey: "",
  llmModel: "",
  llmPresets: {},
  llmActivePreset: "",

  // Embedding API 配置
  embeddingApiUrl: "",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  embeddingTransportMode: "direct",
  embeddingBackendSource: "openai",
  embeddingBackendModel: "text-embedding-3-small",
  embeddingBackendApiUrl: "",
  embeddingAutoSuffix: true,

  // Native 性能加速（灰度）
  graphUseNativeLayout: false,
  graphNativeLayoutThresholdNodes: 280,
  graphNativeLayoutThresholdEdges: 1600,
  graphNativeLayoutWorkerTimeoutMs: 260,
  persistUseNativeDelta: false,
  persistNativeDeltaThresholdRecords: 20000,
  persistNativeDeltaThresholdStructuralDelta: 600,
  persistNativeDeltaThresholdSerializedChars: 4000000,
  persistNativeDeltaBridgeMode: "json",
  nativeEngineFailOpen: true,
  graphNativeForceDisable: false,

  // Schema
  nodeTypeSchema: null,

  // 自定义提示词
  extractPrompt: "",
  recallPrompt: "",
  consolidationPrompt: "",
  compressPrompt: "",
  synopsisPrompt: "",
  summaryRollupPrompt: "",
  reflectionPrompt: "",
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
  globalTaskRegex: createDefaultGlobalTaskRegex(),

  // ====== v2 增强设置 ======
  enableConsolidation: true,
  consolidationNeighborCount: 5,
  consolidationThreshold: 0.85,
  enableSynopsis: true,
  synopsisEveryN: 5,
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

  // UI 面板
  noticeDisplayMode: "normal",
  panelTheme: "crimson",
  graphLocalStorageMode: "indexeddb",
  cloudStorageMode: "automatic",
};

const DEFAULT_SETTING_KEYS = Object.freeze(Object.keys(defaultSettings));

export function migrateLegacyAutoMaintenanceSettings(loaded = {}) {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return {};
  }

  const migrated = { ...loaded };
  if (
    !Object.prototype.hasOwnProperty.call(
      migrated,
      "consolidationAutoMinNewNodes",
    ) &&
    Object.prototype.hasOwnProperty.call(migrated, "maintenanceAutoMinNewNodes")
  ) {
    migrated.consolidationAutoMinNewNodes = clampIntValue(
      migrated.maintenanceAutoMinNewNodes,
      defaultSettings.consolidationAutoMinNewNodes,
      1,
      50,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(migrated, "enableAutoCompression")) {
    const parsedEveryN = Math.floor(Number(migrated.compressionEveryN));
    migrated.enableAutoCompression = !(
      Number.isFinite(parsedEveryN) && parsedEveryN <= 0
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(migrated, "compressionEveryN") &&
    Math.floor(Number(migrated.compressionEveryN)) <= 0
  ) {
    migrated.compressionEveryN = defaultSettings.compressionEveryN;
  }
  if (
    !Object.prototype.hasOwnProperty.call(migrated, "enableHierarchicalSummary") &&
    Object.prototype.hasOwnProperty.call(migrated, "enableSynopsis")
  ) {
    migrated.enableHierarchicalSummary = Boolean(migrated.enableSynopsis);
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      migrated,
      "smallSummaryEveryNExtractions",
    ) &&
    Object.prototype.hasOwnProperty.call(migrated, "synopsisEveryN")
  ) {
    migrated.smallSummaryEveryNExtractions = clampIntValue(
      migrated.synopsisEveryN,
      defaultSettings.smallSummaryEveryNExtractions,
      1,
      100,
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(migrated, "summaryRollupFanIn")
  ) {
    migrated.summaryRollupFanIn = defaultSettings.summaryRollupFanIn;
  }
  delete migrated.maintenanceAutoMinNewNodes;
  return migrated;
}

export function mergePersistedSettings(loaded = {}) {
  const compatibleLoaded = migrateLegacyAutoMaintenanceSettings(loaded);
  const merged = { ...defaultSettings };
  for (const key of DEFAULT_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(compatibleLoaded, key)) {
      merged[key] = compatibleLoaded[key];
    }
  }
  return merged;
}

export function getPersistedSettingsSnapshot(settings = defaultSettings) {
  const persisted = {};
  for (const key of DEFAULT_SETTING_KEYS) {
    persisted[key] = settings[key];
  }
  return persisted;
}
