import { DEFAULT_NODE_SCHEMA } from "../../graph/schema.js";
import { estimateTokens, formatInjection } from "../../retrieval/injector.js";
import { resolveConcurrencyConfig } from "../../runtime/concurrency.js";
import { diffGraphs, diffStateGraph, materializeGraph } from "./graph-draft.js";

function recentMessageLines(history, limit) {
  const count = Math.max(1, Math.floor(Number(limit) || 4));
  return (Array.isArray(history) ? history : [])
    .filter(({ role }) => role === "user" || role === "assistant")
    .slice(-count)
    .map(({ role, text }) => `[${role}]: ${String(text ?? "")}`);
}

export function buildRecallOptions(settings, graph) {
  const concurrency = resolveConcurrencyConfig(settings);
  return {
    topK: settings.recallTopK,
    maxRecallNodes: settings.recallMaxNodes,
    enableLLMRecall: settings.recallEnableLLM,
    enableVectorPrefilter: settings.recallEnableVectorPrefilter,
    enableGraphDiffusion: settings.recallEnableGraphDiffusion,
    diffusionTopK: settings.recallDiffusionTopK,
    llmCandidatePool: settings.recallLlmCandidatePool,
    weights: {
      graphWeight: settings.graphWeight,
      vectorWeight: settings.vectorWeight,
      importanceWeight: settings.importanceWeight,
    },
    enableVisibility: settings.enableVisibility ?? false,
    visibilityFilter: settings.activeCharacterName || null,
    enableCrossRecall: settings.enableCrossRecall ?? false,
    enableProbRecall: settings.enableProbRecall ?? false,
    probRecallChance: settings.probRecallChance ?? 0.15,
    enableMultiIntent: settings.recallEnableMultiIntent ?? true,
    multiIntentMaxSegments: settings.recallMultiIntentMaxSegments ?? 4,
    enableContextQueryBlend: settings.recallEnableContextQueryBlend ?? true,
    contextAssistantWeight: settings.recallContextAssistantWeight ?? 0.2,
    contextPreviousUserWeight: settings.recallContextPreviousUserWeight ?? 0.1,
    enableLexicalBoost: settings.recallEnableLexicalBoost ?? true,
    lexicalWeight: settings.recallLexicalWeight ?? 0.18,
    teleportAlpha: settings.recallTeleportAlpha ?? 0.15,
    enableTemporalLinks: settings.recallEnableTemporalLinks ?? true,
    temporalLinkStrength: settings.recallTemporalLinkStrength ?? 0.2,
    enableDiversitySampling: settings.recallEnableDiversitySampling ?? true,
    dppCandidateMultiplier: settings.recallDppCandidateMultiplier ?? 3,
    dppQualityWeight: settings.recallDppQualityWeight ?? 1,
    enableCooccurrenceBoost: settings.recallEnableCooccurrenceBoost ?? false,
    cooccurrenceScale: settings.recallCooccurrenceScale ?? 0.1,
    cooccurrenceMaxNeighbors: settings.recallCooccurrenceMaxNeighbors ?? 10,
    enableResidualRecall: settings.recallEnableResidualRecall ?? false,
    residualBasisMaxNodes: settings.recallResidualBasisMaxNodes ?? 24,
    residualNmfTopics: settings.recallNmfTopics ?? 15,
    residualNmfNoveltyThreshold: settings.recallNmfNoveltyThreshold ?? 0.4,
    residualThreshold: settings.recallResidualThreshold ?? 0.3,
    residualTopK: settings.recallResidualTopK ?? 5,
    vectorQueryConcurrency: concurrency.vectorQueryConcurrency,
    authorityCandidateQueryConcurrency: concurrency.vectorQueryConcurrency,
    enableScopedMemory: settings.enableScopedMemory ?? true,
    enablePovMemory: settings.enablePovMemory ?? true,
    enableRegionScopedObjective: settings.enableRegionScopedObjective ?? true,
    enableCognitiveMemory: settings.enableCognitiveMemory ?? true,
    enableSpatialAdjacency: settings.enableSpatialAdjacency ?? true,
    enableStoryTimeline: settings.enableStoryTimeline ?? true,
    injectStoryTimeLabel: settings.injectStoryTimeLabel ?? true,
    storyTimeSoftDirecting: settings.storyTimeSoftDirecting ?? true,
    recallCharacterPovWeight: settings.recallCharacterPovWeight ?? 1.25,
    recallUserPovWeight: settings.recallUserPovWeight ?? 1.05,
    recallObjectiveCurrentRegionWeight: settings.recallObjectiveCurrentRegionWeight ?? 1.15,
    recallObjectiveAdjacentRegionWeight: settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
    recallObjectiveGlobalWeight: settings.recallObjectiveGlobalWeight ?? 0.75,
    injectUserPovMemory: settings.injectUserPovMemory ?? true,
    injectObjectiveGlobalMemory: settings.injectObjectiveGlobalMemory ?? true,
    injectLowConfidenceObjectiveMemory: settings.injectLowConfidenceObjectiveMemory ?? false,
    activeRegion: graph.historyState?.activeRegion || graph.historyState?.lastExtractedRegion || "",
    activeStorySegmentId: graph.historyState?.activeStorySegmentId || "",
    activeStoryTimeLabel: graph.historyState?.activeStoryTimeLabel || "",
    activeCharacterPovOwner: graph.historyState?.activeCharacterPovOwner || "",
    activeUserPovOwner: graph.historyState?.activeUserPovOwner || settings.activeUserName || "",
  };
}

export async function recallFromState({
  state,
  input,
  history = [],
  signal,
  settings = {},
  schema = DEFAULT_NODE_SCHEMA,
  embeddingConfig = {},
  onStreamProgress = null,
  retrieveFn = null,
} = {}) {
  if (settings.recallEnabled === false) {
    return { selectedNodeIds: [], injectionText: "", tokenEstimate: 0, changeSet: { changes: [] } };
  }
  const vectorReady = ![...(state?.vectorJobs?.values?.() || [])]
    .some((job) => job?.status === "pending");
  const effectiveSettings = vectorReady
    ? settings
    : {
        ...settings,
        recallEnableVectorPrefilter: false,
        authorityGraphQueryEnabled: false,
      };
  const before = materializeGraph(state);
  const draft = structuredClone(before);
  const runRetrieve = retrieveFn || (await import("../../retrieval/retriever.js")).retrieve;
  const result = await runRetrieve({
    graph: draft,
    userMessage: String(input ?? ""),
    recentMessages: recentMessageLines(history, settings.recallLlmContextMessages),
    embeddingConfig,
    schema,
    signal,
    settings: effectiveSettings,
    onStreamProgress,
    options: buildRecallOptions(effectiveSettings, draft),
  });
  const injectionText = formatInjection(result, schema).trim();
  const domainChanges = diffGraphs(before, draft);
  return {
    selectedNodeIds: Array.isArray(result?.selectedNodeIds) ? result.selectedNodeIds : [],
    injectionText,
    tokenEstimate: estimateTokens(injectionText),
    changeSet: domainChanges.changes.length > 0
      ? diffStateGraph(state, draft)
      : domainChanges,
    retrieval: result,
  };
}
