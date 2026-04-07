import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  onBeforeCombinePromptsController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageReceivedController,
  onMessageSentController,
} from "../../event-binding.js";
import {
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  MODULE_NAME,
} from "../../graph-persistence.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  readPersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  writePersistedRecallToUserMessage,
} from "../../recall-persistence.js";
import {
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  getGenerationRecallHookStateFromResult,
  getRecallHookLabel,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTerminalGenerationRecallHookState,
  isTrivialUserInput,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  shouldRunRecallForTransaction,
} from "../../ui-status.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../../index.js");

export function createGenerationRecallHarness(options = {}) {
  const { realApplyFinal = false } = options;
  return fs.readFile(indexPath, "utf8").then((source) => {
    const start = source.indexOf("const RECALL_INPUT_RECORD_TTL_MS = 60000;");
    const end = source.indexOf(
      'function onMessageReceived(messageId = null, type = "") {',
    );
    const endFallback = source.indexOf("async function runExtraction()");
    const resolvedEnd = end >= 0 ? end : endFallback;
    if (start < 0 || resolvedEnd < 0 || resolvedEnd <= start) {
      throw new Error("无法从 index.js 提取生成召回事务定义");
    }
    const snippet = source
      .slice(start, resolvedEnd)
      .replace(/^export\s+/gm, "");
    const context = {
      console,
      Date,
      Map,
      setTimeout,
      clearTimeout,
      __sendTextareaValue: "",
      document: {
        getElementById(id) {
          if (
            id === "send_textarea" &&
            typeof context.__sendTextareaValue === "string" &&
            context.__sendTextareaValue
          ) {
            return { value: context.__sendTextareaValue };
          }
          return null;
        },
      },
      result: null,
      currentGraph: {},
      _panelModule: null,
      defaultSettings: {},
      settings: {},
      graphPersistenceState: createGraphPersistenceState(),
      extension_settings: { [MODULE_NAME]: {} },
      extension_prompt_types: {
        NONE: 0,
        BEFORE_PROMPT: 1,
        IN_PROMPT: 2,
        IN_CHAT: 3,
      },
      extension_prompt_roles: {
        SYSTEM: 0,
        USER: 1,
        ASSISTANT: 2,
      },
      clampInt: (value, fallback = 0, min = 0, max = 9999) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(max, Math.max(min, Math.trunc(numeric)));
      },
      getHostAdapter: () => null,
      migrateLegacyTaskProfiles: (settings = {}) => ({
        taskProfilesVersion: settings?.taskProfilesVersion || 0,
        taskProfiles: settings?.taskProfiles || {},
      }),
      refreshPanelLiveStateController: () => {
        context.refreshPanelCalls += 1;
      },
      isRecalling: false,
      getCurrentChatId: () => "chat-main",
      normalizeRecallInputText: (text = "") => String(text || "").trim(),
      isTrivialUserInput,
      getLatestUserChatMessage: (chat = []) =>
        [...chat].reverse().find((message) => message?.is_user) || null,
      getLastNonSystemChatMessage: (chat = []) =>
        [...chat].reverse().find((message) => !message?.is_system) || null,
      getSendTextareaValue: () => context.__sendTextareaValue,
      getRecallUserMessageSourceLabel: (source = "") => source,
      getRecallUserMessageSourceLabelController: (source = "") => source,
      buildRecallRecentMessages: (
        chat = [],
        _limit,
        syntheticUserMessage = "",
      ) =>
        syntheticUserMessage
          ? [...chat, { is_user: true, mes: syntheticUserMessage }]
          : [...chat],
      getContext: () => ({
        chatId: "chat-main",
        chat: context.chat,
      }),
      chat: [],
      runRecallCalls: [],
      runExtractionCalls: [],
      extractionIssues: [],
      applyFinalCalls: [],
      moduleInjectionCalls: [],
      recordedInjectionSnapshots: [],
      refreshPanelCalls: 0,
      hideScheduleCalls: [],
      isExtracting: false,
      isRecoveringHistory: false,
      isAssistantChatMessage: (message) =>
        Boolean(message) && !message.is_user && !message.is_system,
      createRecallInputRecord,
      createRecallRunResult,
      hashRecallInput,
      isFreshRecallInputRecord,
      isTerminalGenerationRecallHookState,
      shouldRunRecallForTransaction,
      getGenerationRecallHookStateFromResult,
      createUiStatus,
      createGraphPersistenceState,
      getRecallHookLabel,
      getStageNoticeTitle,
      getStageNoticeDuration,
      normalizeStageNoticeLevel,
      MODULE_NAME,
      GRAPH_LOAD_STATES,
      GRAPH_METADATA_KEY,
      GRAPH_PERSISTENCE_META_KEY,
      onBeforeCombinePromptsController,
      onGenerationAfterCommandsController,
      onGenerationStartedController,
      readPersistedRecallFromUserMessage,
      writePersistedRecallToUserMessage,
      buildPersistedRecallRecord,
      resolveFinalRecallInjectionSource,
      bumpPersistedRecallGenerationCount,
      applyModuleInjectionPrompt: (text = "") => {
        const normalizedText = String(text || "");
        context.moduleInjectionCalls.push(normalizedText);
        return {
          applied: Boolean(normalizedText.trim()),
          source: normalizedText.trim() ? "module-injection" : "rewrite-clear",
          mode: normalizedText.trim() ? "module-injection" : "rewrite-clear",
        };
      },
      getSettings: () => context.settings,
      $: () => ({}),
      triggerChatMetadataSave: () => {
        context.metadataSaveCalls += 1;
        return "debounced";
      },
      refreshPanelLiveState: () => {
        context.refreshPanelCalls += 1;
      },
      recordInjectionSnapshot: (_kind, snapshot = {}) => {
        context.recordedInjectionSnapshots.push({ ...snapshot });
      },
      schedulePersistedRecallMessageUiRefresh: () => {
        context.recallUiRefreshCalls += 1;
      },
      getMessageHideSettings: () => ({}),
      getHideRuntimeAdapters: () => ({}),
      scheduleHideSettingsApply: (...args) => {
        context.hideScheduleCalls.push(args);
      },
      estimateTokens: (text = "") =>
        normalizeRecallInputText(text)
          .split(/\s+/)
          .filter(Boolean).length || (normalizeRecallInputText(text) ? 1 : 0),
      resolveGenerationTargetUserMessageIndex: (
        chat = [],
        { generationType } = {},
      ) => {
        const normalized = String(generationType || "normal");
        if (!Array.isArray(chat) || chat.length === 0) return null;
        if (normalized === "normal")
          return chat[chat.length - 1]?.is_user ? chat.length - 1 : null;
        for (let index = chat.length - 1; index >= 0; index--)
          if (chat[index]?.is_user) return index;
        return null;
      },
      metadataSaveCalls: 0,
      recallUiRefreshCalls: 0,
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { hashRecallInput, buildPreGenerationRecallKey, buildGenerationAfterCommandsRecallInput, buildNormalGenerationRecallInput, cleanupGenerationRecallTransactions, buildGenerationRecallTransactionId, beginGenerationRecallTransaction, markGenerationRecallTransactionHookState, shouldRunRecallForTransaction, createGenerationRecallContext, onGenerationStarted, onGenerationEnded, onGenerationAfterCommands, onBeforeCombinePrompts, applyFinalRecallInjectionForGeneration, ensurePersistedRecallRecordForGeneration, findRecentGenerationRecallTransactionForChat, getGenerationRecallTransactionResult, generationRecallTransactions, freezeHostGenerationInputSnapshot, consumeHostGenerationInputSnapshot, getPendingHostGenerationInputSnapshot, clearPendingHostGenerationInputSnapshot, recordRecallSendIntent, clearPendingRecallSendIntent, recordRecallSentUserMessage, getPendingRecallSendIntent: () => pendingRecallSendIntent, getLastRecallSentUserMessage: () => lastRecallSentUserMessage, getCurrentGenerationTrivialSkip, markCurrentGenerationTrivialSkip, clearCurrentGenerationTrivialSkip, consumeCurrentGenerationTrivialSkip, deferAutoExtraction, maybeResumePendingAutoExtraction, clearPendingAutoExtraction, getPendingAutoExtraction: () => ({ ...pendingAutoExtraction }), getIsHostGenerationRunning: () => isHostGenerationRunning, runPlannerRecallForEna, getGraphPersistenceState: () => graphPersistenceState, setGraphPersistenceState: (value = {}) => { graphPersistenceState = { ...graphPersistenceState, ...(value || {}) }; return graphPersistenceState; } };`,
      context,
      { filename: indexPath },
    );
    Object.defineProperties(context, {
      pendingRecallSendIntent: {
        get() {
          return context.result.getPendingRecallSendIntent();
        },
        set(value) {
          if (value?.text) {
            context.result.recordRecallSendIntent(
              value?.text || "",
              value?.source,
            );
            return;
          }
          context.result.clearPendingRecallSendIntent();
        },
        configurable: true,
      },
      lastRecallSentUserMessage: {
        get() {
          return context.result.getLastRecallSentUserMessage();
        },
        set(value) {
          context.result.recordRecallSentUserMessage(
            value?.messageId,
            value?.text || "",
            value?.source,
          );
        },
        configurable: true,
      },
    });
    const originalApplyFinalRecallInjectionForGeneration =
      context.result.applyFinalRecallInjectionForGeneration;
    context.applyFinalRecallInjectionForGeneration = (payload = {}) => {
      context.applyFinalCalls.push({ ...payload });
      if (realApplyFinal) {
        return originalApplyFinalRecallInjectionForGeneration(payload);
      }
      return {
        source: "fresh",
        targetUserMessageIndex: null,
      };
    };
    context.runRecall = async (options = {}) => {
      context.runRecallCalls.push({ ...options });
      const overrideUserMessage = String(
        options.overrideUserMessage || options.userMessage || "",
      );
      return {
        status: "completed",
        didRecall: true,
        ok: true,
        injectionText: `注入:${overrideUserMessage}`,
        deliveryMode: String(options.deliveryMode || "immediate"),
        source: options.overrideSource,
        sourceLabel: options.overrideSourceLabel,
        reason: options.overrideReason,
        sourceCandidates: Array.isArray(options.sourceCandidates)
          ? options.sourceCandidates.map((candidate) => ({ ...candidate }))
          : [],
        selectedNodeIds: ["node-test-1"],
        retrievalMeta: {
          vectorHits: 1,
          vectorMergedHits: 0,
          diffusionHits: 0,
          candidatePoolAfterDpp: 1,
        },
        llmMeta: {
          status: "disabled",
          reason: "test-disabled",
          candidatePool: 0,
        },
        stats: {
          coreCount: 1,
          recallCount: 1,
        },
      };
    };
    context.runExtraction = async (...args) => {
      context.runExtractionCalls.push(args);
      return {
        ok: true,
      };
    };
    context.invokeOnMessageSent = (messageId = null) =>
      onMessageSentController(
        {
          getContext: context.getContext,
          isTrivialUserInput,
          recordRecallSentUserMessage: context.result.recordRecallSentUserMessage,
          refreshPersistedRecallMessageUi: () => {
            context.recallUiRefreshCalls += 1;
          },
        },
        messageId,
      );
    context.invokeOnMessageReceived = (messageId = null, type = "") =>
      onMessageReceivedController(
        {
          console,
          consumeCurrentGenerationTrivialSkip:
            context.result.consumeCurrentGenerationTrivialSkip,
          createRecallInputRecord,
          deferAutoExtraction: context.result.deferAutoExtraction,
          getContext: context.getContext,
          getCurrentGraph: () => context.currentGraph,
          getGraphPersistenceState: () => context.result.getGraphPersistenceState(),
          getIsHostGenerationRunning: () =>
            context.result.getIsHostGenerationRunning(),
          getPendingHostGenerationInputSnapshot:
            context.result.getPendingHostGenerationInputSnapshot,
          getPendingRecallSendIntent: () => context.result.getPendingRecallSendIntent(),
          isAssistantChatMessage: (message) =>
            Boolean(message) && !message.is_user && !message.is_system,
          isFreshRecallInputRecord,
          isGraphMetadataWriteAllowed: () => true,
          syncGraphLoadFromLiveContext: () => {},
          maybeCaptureGraphShadowSnapshot: () => {},
          maybeFlushQueuedGraphPersist: () => {},
          notifyExtractionIssue: (message) => {
            context.extractionIssues.push(String(message || ""));
          },
          queueMicrotask: (task) => task(),
          runExtraction: context.runExtraction,
          refreshPersistedRecallMessageUi: () => {
            context.recallUiRefreshCalls += 1;
          },
          setPendingHostGenerationInputSnapshot: () => {},
          setPendingRecallSendIntent: (record) => {
            if (record?.text) {
              context.result.recordRecallSendIntent(
                record.text || "",
                record.source,
              );
              return;
            }
            context.result.clearPendingRecallSendIntent();
          },
        },
        messageId,
        type,
      );
    return context;
  });
}
