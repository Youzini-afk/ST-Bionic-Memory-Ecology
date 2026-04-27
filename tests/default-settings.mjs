import assert from "node:assert/strict";

import {
  defaultSettings,
  mergePersistedSettings,
} from "../runtime/settings-defaults.js";

assert.equal(defaultSettings.extractContextTurns, 2);
assert.equal(defaultSettings.extractActionMode, "pending");
assert.equal(defaultSettings.extractAutoDelayLatestAssistant, false);
assert.equal(defaultSettings.hideOldMessagesRenderLimitEnabled, true);
assert.equal(defaultSettings.hideOldMessagesRenderLimit, 10);
assert.equal(defaultSettings.recallTopK, 20);
assert.equal(defaultSettings.recallMaxNodes, 12);
assert.equal(defaultSettings.recallEnableVectorPrefilter, true);
assert.equal(defaultSettings.recallEnableGraphDiffusion, true);
assert.equal(defaultSettings.recallDiffusionTopK, 100);
assert.equal(defaultSettings.recallLlmCandidatePool, 30);
assert.equal(defaultSettings.recallLlmContextMessages, 4);
assert.equal(defaultSettings.recallUseAuthoritativeGenerationInput, false);
assert.equal(defaultSettings.recallEnableMultiIntent, true);
assert.equal(defaultSettings.recallMultiIntentMaxSegments, 4);
assert.equal(defaultSettings.recallEnableContextQueryBlend, true);
assert.equal(defaultSettings.recallContextAssistantWeight, 0.2);
assert.equal(defaultSettings.recallContextPreviousUserWeight, 0.1);
assert.equal(defaultSettings.recallEnableLexicalBoost, true);
assert.equal(defaultSettings.recallLexicalWeight, 0.18);
assert.equal(defaultSettings.recallTeleportAlpha, 0.15);
assert.equal(defaultSettings.recallEnableTemporalLinks, true);
assert.equal(defaultSettings.recallTemporalLinkStrength, 0.2);
assert.equal(defaultSettings.recallEnableDiversitySampling, true);
assert.equal(defaultSettings.recallDppCandidateMultiplier, 3);
assert.equal(defaultSettings.recallDppQualityWeight, 1.0);
assert.equal(defaultSettings.recallEnableCooccurrenceBoost, false);
assert.equal(defaultSettings.recallCooccurrenceScale, 0.1);
assert.equal(defaultSettings.recallCooccurrenceMaxNeighbors, 10);
assert.equal(defaultSettings.recallEnableResidualRecall, false);
assert.equal(defaultSettings.recallResidualBasisMaxNodes, 24);
assert.equal(defaultSettings.recallNmfTopics, 15);
assert.equal(defaultSettings.recallNmfNoveltyThreshold, 0.4);
assert.equal(defaultSettings.recallResidualThreshold, 0.3);
assert.equal(defaultSettings.recallResidualTopK, 5);
assert.equal(defaultSettings.enableScopedMemory, true);
assert.equal(defaultSettings.enablePovMemory, true);
assert.equal(defaultSettings.enableRegionScopedObjective, true);
assert.equal(defaultSettings.recallCharacterPovWeight, 1.25);
assert.equal(defaultSettings.recallUserPovWeight, 1.05);
assert.equal(defaultSettings.recallObjectiveCurrentRegionWeight, 1.15);
assert.equal(defaultSettings.recallObjectiveAdjacentRegionWeight, 0.9);
assert.equal(defaultSettings.recallObjectiveGlobalWeight, 0.75);
assert.equal(defaultSettings.injectUserPovMemory, true);
assert.equal(defaultSettings.injectObjectiveGlobalMemory, true);
assert.equal(defaultSettings.enableCognitiveMemory, true);
assert.equal(defaultSettings.enableSpatialAdjacency, true);
assert.equal(defaultSettings.injectLowConfidenceObjectiveMemory, false);
assert.equal(defaultSettings.enableStoryTimeline, true);
assert.equal(defaultSettings.injectStoryTimeLabel, true);
assert.equal(defaultSettings.storyTimeSoftDirecting, true);
assert.equal(defaultSettings.injectDepth, 9999);
assert.equal(defaultSettings.enabled, true);
assert.equal(defaultSettings.debugLoggingEnabled, false);
assert.equal(defaultSettings.enableReflection, true);
assert.equal(defaultSettings.consolidationAutoMinNewNodes, 2);
assert.equal(defaultSettings.enableAutoCompression, true);
assert.equal(defaultSettings.compressionEveryN, 10);
assert.equal(defaultSettings.cloudStorageMode, "automatic");
assert.equal(defaultSettings.worldInfoFilterMode, "default");
assert.equal(defaultSettings.worldInfoFilterCustomKeywords, "");
assert.equal("maintenanceAutoMinNewNodes" in defaultSettings, false);
assert.equal(defaultSettings.embeddingTransportMode, "direct");
assert.equal(defaultSettings.authorityEnabled, "auto");
assert.equal(defaultSettings.authorityBaseUrl, "/api/plugins/authority");
assert.equal(defaultSettings.authorityPrimaryWhenAvailable, true);
assert.equal(defaultSettings.authorityStorageMode, "auto-server-primary");
assert.equal(defaultSettings.authorityVectorMode, "auto-primary");
assert.equal(defaultSettings.authoritySqlPrimary, true);
assert.equal(defaultSettings.authorityTriviumPrimary, true);
assert.equal(defaultSettings.authorityGraphQueryEnabled, true);
assert.equal(defaultSettings.authorityJobsEnabled, true);
assert.equal(defaultSettings.authorityBlobCheckpointEnabled, true);
assert.equal(defaultSettings.authorityBrowserCacheMode, "minimal");
assert.equal(defaultSettings.authorityOfflineWritePolicy, "queue-local-dirty");
assert.equal(defaultSettings.authorityOfflineQueueMaxBytes, 1048576);
assert.equal(defaultSettings.authorityOfflineQueueMaxItems, 128);
assert.equal(defaultSettings.authorityOfflineQueueMaxAgeMs, 3600000);
assert.equal(defaultSettings.authorityVectorSyncChunkSize, 1000);
assert.equal(defaultSettings.authorityVectorFailOpen, true);
assert.equal(defaultSettings.authorityDiagnosticsEnabled, true);
assert.equal(defaultSettings.authorityProbeIntervalMs, 60000);
assert.equal(defaultSettings.graphUseNativeLayout, true);
assert.equal(defaultSettings.graphNativeLayoutThresholdNodes, 280);
assert.equal(defaultSettings.graphNativeLayoutThresholdEdges, 1600);
assert.equal(defaultSettings.graphNativeLayoutWorkerTimeoutMs, 260);
assert.equal(defaultSettings.persistUseNativeDelta, true);
assert.equal(defaultSettings.persistNativeDeltaThresholdRecords, 20000);
assert.equal(defaultSettings.persistNativeDeltaThresholdStructuralDelta, 600);
assert.equal(defaultSettings.persistNativeDeltaThresholdSerializedChars, 4000000);
assert.equal(defaultSettings.persistNativeDeltaBridgeMode, "json");
assert.equal(defaultSettings.loadUseNativeHydrate, true);
assert.equal(defaultSettings.loadNativeHydrateThresholdRecords, 30000);
assert.equal(defaultSettings.nativeRolloutVersion, 2);
assert.equal(defaultSettings.nativeEngineFailOpen, true);
assert.equal(defaultSettings.graphNativeForceDisable, false);
assert.equal(defaultSettings.taskProfilesVersion, 3);
assert.ok(defaultSettings.taskProfiles);
assert.ok(defaultSettings.taskProfiles.extract);
assert.ok(defaultSettings.taskProfiles.recall);
assert.ok(defaultSettings.globalTaskRegex);
assert.deepEqual(
  defaultSettings.globalTaskRegex.localRules.map((rule) => rule.id),
  [
    "default-contamination-thinking-blocks",
    "default-contamination-choice-blocks",
    "default-contamination-updatevariable-tags",
    "default-contamination-status-current-variable-tags",
    "default-contamination-status-placeholder-tags",
  ],
);

const migratedSettings = mergePersistedSettings({
  maintenanceAutoMinNewNodes: 7,
  extractAutoDelayLatestAssistant: true,
});
assert.equal(migratedSettings.consolidationAutoMinNewNodes, 7);
assert.equal(migratedSettings.extractAutoDelayLatestAssistant, true);
assert.equal(migratedSettings.enableAutoCompression, true);
assert.equal(migratedSettings.compressionEveryN, 10);
assert.equal(migratedSettings.cloudStorageMode, "automatic");
assert.equal("maintenanceAutoMinNewNodes" in migratedSettings, false);

const migratedLegacyCompressionDisabled = mergePersistedSettings({
  compressionEveryN: 0,
});
assert.equal(migratedLegacyCompressionDisabled.enableAutoCompression, false);
assert.equal(
  migratedLegacyCompressionDisabled.compressionEveryN,
  defaultSettings.compressionEveryN,
);

const migratedLegacyNativeDisabled = mergePersistedSettings({
  graphUseNativeLayout: false,
  persistUseNativeDelta: false,
  loadUseNativeHydrate: false,
  graphNativeForceDisable: true,
});
assert.equal(migratedLegacyNativeDisabled.graphUseNativeLayout, true);
assert.equal(migratedLegacyNativeDisabled.persistUseNativeDelta, true);
assert.equal(migratedLegacyNativeDisabled.loadUseNativeHydrate, true);
assert.equal(migratedLegacyNativeDisabled.loadNativeHydrateThresholdRecords, 30000);
assert.equal(migratedLegacyNativeDisabled.graphNativeForceDisable, true);
assert.equal(migratedLegacyNativeDisabled.nativeRolloutVersion, 2);

const migratedVersionedManualNativeDisabled = mergePersistedSettings({
  nativeRolloutVersion: 2,
  graphUseNativeLayout: false,
  persistUseNativeDelta: false,
  loadUseNativeHydrate: false,
  graphNativeForceDisable: true,
});
assert.equal(migratedVersionedManualNativeDisabled.graphUseNativeLayout, false);
assert.equal(migratedVersionedManualNativeDisabled.persistUseNativeDelta, false);
assert.equal(migratedVersionedManualNativeDisabled.loadUseNativeHydrate, false);
assert.equal(migratedVersionedManualNativeDisabled.graphNativeForceDisable, true);
assert.equal(migratedVersionedManualNativeDisabled.nativeRolloutVersion, 2);

const migratedLegacyHydrateThresholdDefault = mergePersistedSettings({
  nativeRolloutVersion: 1,
  loadNativeHydrateThresholdRecords: 12000,
});
assert.equal(migratedLegacyHydrateThresholdDefault.loadNativeHydrateThresholdRecords, 30000);
assert.equal(migratedLegacyHydrateThresholdDefault.nativeRolloutVersion, 2);

const preservedCustomHydrateThreshold = mergePersistedSettings({
  nativeRolloutVersion: 1,
  loadNativeHydrateThresholdRecords: 45000,
});
assert.equal(preservedCustomHydrateThreshold.loadNativeHydrateThresholdRecords, 45000);
assert.equal(preservedCustomHydrateThreshold.nativeRolloutVersion, 2);

console.log("default-settings tests passed");
