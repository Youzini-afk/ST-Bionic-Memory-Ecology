import { t } from "../i18n/index.js";

const TOOL_META = Object.freeze({
  memory_task_context: [
    "panel.agentFlow.tool.memoryContext",
    "panel.agentFlow.tool.memoryContextRunning",
  ],
  memory_run_pipeline: [
    "panel.agentFlow.tool.memoryPipeline",
    "panel.agentFlow.tool.memoryPipelineRunning",
  ],
  memory_complete_without_changes: [
    "panel.agentFlow.tool.noChanges",
    "panel.agentFlow.tool.noChangesRunning",
  ],
  recall_context: [
    "panel.agentFlow.tool.recallContext",
    "panel.agentFlow.tool.recallContextRunning",
  ],
  recall_search: [
    "panel.agentFlow.tool.recallSearch",
    "panel.agentFlow.tool.recallSearchRunning",
  ],
  recall_get: [
    "panel.agentFlow.tool.recallGet",
    "panel.agentFlow.tool.recallGetRunning",
  ],
  recall_neighbors: [
    "panel.agentFlow.tool.recallNeighbors",
    "panel.agentFlow.tool.recallNeighborsRunning",
  ],
  recall_publish: [
    "panel.agentFlow.tool.recallPublish",
    "panel.agentFlow.tool.recallPublishRunning",
  ],
});

const TERMINAL_TYPES = new Set([
  "run_completed",
  "run_suspended",
  "run_failed",
  "run_cancelled",
]);
const UI_TIMELINE_ENTRY_LIMIT = 120;
const UI_TOOL_GROUP_ITEM_LIMIT = 24;
const UI_MODEL_CONTENT_CHAR_LIMIT = 12_000;
const UI_REASONING_CHAR_LIMIT = 6_000;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseJson(value, fallback = null) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function pretty(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {}
  }
  const text = String(value);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function clipAgentText(value, maxChars = 0) {
  const text = String(value || "");
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit || text.length <= limit) return text;
  return `${t("panel.agentFlow.previewClipped", {
    count: text.length - limit,
  })}\n${text.slice(-limit)}`;
}

function toolName(toolCall = {}) {
  return String(toolCall?.name || toolCall?.function?.name || "").trim();
}

function toolArguments(toolCall = {}) {
  return String(
    toolCall?.arguments ?? toolCall?.function?.arguments ?? "",
  );
}

function toolTitle(name = "") {
  const key = TOOL_META[name]?.[0];
  return key ? t(key) : t("panel.agentFlow.tool.generic", { name: name || t("common.unknown") });
}

function toolRunningText(name = "") {
  const key = TOOL_META[name]?.[1];
  return key ? t(key) : t("panel.agentFlow.tool.genericRunning");
}

function getToolResult(event = {}) {
  return parseJson(event?.payload?.message?.content, null);
}

function summarizeToolResult(name, result, ok = true) {
  if (!ok) {
    return String(result?.error?.message || t("panel.agentFlow.tool.failed"));
  }
  switch (name) {
    case "memory_task_context":
      return t("panel.agentFlow.summary.memoryContext", {
        messages: Array.isArray(result?.messages) ? result.messages.length : 0,
        nodes: Number(result?.graphStats?.activeNodes || 0),
        edges: Number(result?.graphStats?.edges || 0),
      });
    case "memory_run_pipeline":
      return Number.isFinite(Number(result?.result?.processedFloor))
        ? t("panel.agentFlow.summary.processedFloor", {
            floor: Number(result.result.processedFloor),
          })
        : t("panel.agentFlow.summary.pipelineCompleted");
    case "memory_complete_without_changes":
      return Number.isFinite(Number(result?.result?.processedFloor))
        ? t("panel.agentFlow.summary.noChangesFloor", {
            floor: Number(result.result.processedFloor),
          })
        : t("panel.agentFlow.summary.noChanges");
    case "recall_context":
      return t("panel.agentFlow.summary.recallContext", {
        candidates: Array.isArray(result?.candidates) ? result.candidates.length : 0,
        selected: Array.isArray(result?.baselineSelectedMemoryIds)
          ? result.baselineSelectedMemoryIds.length
          : 0,
      });
    case "recall_search":
      return t("panel.agentFlow.summary.recallSearch", {
        count: Array.isArray(result?.items) ? result.items.length : 0,
      });
    case "recall_get":
      return t("panel.agentFlow.summary.recallGet", {
        count: Array.isArray(result?.items) ? result.items.length : 0,
        missing: Array.isArray(result?.missingMemoryIds)
          ? result.missingMemoryIds.length
          : 0,
      });
    case "recall_neighbors":
      return t("panel.agentFlow.summary.recallNeighbors", {
        relations: Array.isArray(result?.relations) ? result.relations.length : 0,
        neighbors: Array.isArray(result?.neighbors) ? result.neighbors.length : 0,
      });
    case "recall_publish":
      return result?.published === true
        ? t("panel.agentFlow.summary.recallPublished", {
            count: Array.isArray(result?.selectedMemoryIds)
              ? result.selectedMemoryIds.length
              : 0,
          })
        : t("panel.agentFlow.summary.recallRejected");
    default:
      return ok
        ? t("panel.agentFlow.tool.completed")
        : t("panel.agentFlow.tool.failed");
  }
}

function formatDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function effectiveElapsed(run, now = Date.now()) {
  if (run?.terminal) return Number(run.elapsedMs || 0);
  return Math.max(0, Number(now) - Number(run?.startedAt || now));
}

function agentLabel(run = {}) {
  if (run.agentKind === "graph-memory-steward" || run.taskType === "agent_steward") {
    return t("panel.agentFlow.agent.steward");
  }
  if (run.agentKind === "graph-recall-agent" || run.taskType === "agent_recall") {
    return t("panel.agentFlow.agent.recall");
  }
  return t("panel.agentFlow.agent.generic");
}

function displayStatus(run = {}) {
  if (run?.outcome?.completed === true && run.status !== "completed") {
    return {
      key: "completedFallback",
      label: t("panel.agentFlow.status.completedFallback"),
      tone: "success",
    };
  }
  const status = run.terminal ? run.status : run.phase || run.status;
  const normalized = [
    "starting",
    "model",
    "streaming",
    "decision",
    "tool",
    "tool-result",
    "tool-interrupted",
    "compaction",
    "cancelling",
    "completed",
    "suspended",
    "failed",
    "cancelled",
  ].includes(status)
    ? status
    : "running";
  const tone = ["completed"].includes(normalized)
    ? "success"
    : ["failed", "tool-interrupted"].includes(normalized)
      ? "error"
      : ["suspended", "cancelling"].includes(normalized)
        ? "warning"
        : ["cancelled"].includes(normalized)
          ? "neutral"
          : "running";
  return {
    key: normalized,
    label: t(`panel.agentFlow.status.${normalized}`),
    tone,
  };
}

function runScope(run = {}) {
  const start = Number(run?.metadata?.startFloor);
  const end = Number(run?.metadata?.endFloor);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return t("panel.agentFlow.scope.floorRange", { start, end });
  }
  const candidates = Number(run?.metadata?.candidateCount);
  if (Number.isFinite(candidates)) {
    return t("panel.agentFlow.scope.recallCandidates", { count: candidates });
  }
  return t("panel.agentFlow.scope.currentChat");
}

function normalizeToolEntry(started, finished = null) {
  const call = started?.payload?.toolCall || finished?.payload?.toolCall || {};
  const name = toolName(call);
  const result = finished ? getToolResult(finished) : null;
  const ok = finished ? finished?.payload?.ok !== false && finished.eventType !== "tool_interrupted" : null;
  return {
    id: `tool:${String(call?.id || started?.id || finished?.id || "")}`,
    kind: "tool",
    name,
    title: toolTitle(name),
    description: finished
      ? summarizeToolResult(name, result, ok)
      : toolRunningText(name),
    status: finished ? (ok ? "completed" : "failed") : "running",
    arguments: toolArguments(call),
    result: finished ? String(finished?.payload?.message?.content || "") : "",
    toolCallNumber: Number(
      started?.payload?.toolCallNumber || finished?.payload?.toolCallNumber || 0,
    ),
  };
}

export function buildAgentRunTimeline(run = {}, options = {}) {
  const contentLimit = Number(options.contentCharLimit) || 0;
  const reasoningLimit = Number(options.reasoningCharLimit) || 0;
  const entries = [];
  const modelsByRequestEventId = new Map();
  const toolsByNumber = new Map();
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    const payload = event?.payload || {};
    if (event.eventType === "run_started") {
      entries.push({
        id: event.id,
        kind: "marker",
        status: "completed",
        title: t("panel.agentFlow.event.started"),
        description: runScope(run),
      });
      continue;
    }
    if (event.eventType === "model_requested") {
      const entry = {
        id: event.id,
        kind: "model",
        status: "running",
        requestNumber: Number(payload.requestNumber || 0),
        purpose: String(payload.purpose || "agent-turn"),
        title:
          payload.purpose === "context-compaction"
            ? t("panel.agentFlow.event.compaction")
            : t("panel.agentFlow.event.modelRound", {
                number: Number(payload.requestNumber || 0),
              }),
        content: "",
        reasoning: "",
        toolCalls: [],
      };
      entries.push(entry);
      modelsByRequestEventId.set(event.id, entry);
      continue;
    }
    if (event.eventType === "assistant_message") {
      const entry = modelsByRequestEventId.get(String(payload.requestEventId || ""));
      if (entry) {
        entry.status = "completed";
        entry.content = clipAgentText(payload?.message?.content, contentLimit);
        entry.reasoning = clipAgentText(payload.reasoningContent, reasoningLimit);
        entry.toolCalls = Array.isArray(payload?.message?.tool_calls)
          ? payload.message.tool_calls.map((call) => ({
              id: String(call?.id || ""),
              name: toolName(call),
              arguments: toolArguments(call),
            }))
          : [];
      }
      continue;
    }
    if (event.eventType === "context_summary_created") {
      const entry = modelsByRequestEventId.get(String(payload.requestEventId || ""));
      if (entry) {
        entry.status = "completed";
        entry.content = clipAgentText(payload.summary, contentLimit);
      }
      continue;
    }
    if (event.eventType === "tool_started") {
      const entry = normalizeToolEntry(event);
      entries.push(entry);
      toolsByNumber.set(Number(payload.toolCallNumber || 0), entry);
      continue;
    }
    if (event.eventType === "tool_finished" || event.eventType === "tool_interrupted") {
      const number = Number(payload.toolCallNumber || 0);
      const existing = toolsByNumber.get(number);
      const completed = normalizeToolEntry(null, event);
      if (existing) Object.assign(existing, completed, { id: existing.id });
      else entries.push(completed);
      continue;
    }
    if (event.eventType === "context_compacted") {
      entries.push({
        id: event.id,
        kind: "marker",
        status: "completed",
        title: t("panel.agentFlow.event.contextCompacted"),
        description: t("panel.agentFlow.event.contextCompactedSummary", {
          before: Number(payload.beforeTokens || 0),
          after: Number(payload.afterTokens || 0),
        }),
      });
      continue;
    }
    if (TERMINAL_TYPES.has(event.eventType)) {
      entries.push({
        id: event.id,
        kind: "terminal",
        status: String(event.eventType).replace(/^run_/, ""),
        title: t(`panel.agentFlow.event.${String(event.eventType).replace(/^run_/, "")}`),
        description: String(payload.reason || payload.content || ""),
        details: pretty(payload),
      });
    }
  }

  if (run?.outcome?.completed === true && run.status !== "completed") {
    entries.push({
      id: `outcome:${String(run.runId || "fallback")}`,
      kind: "terminal",
      status: "completed",
      title: t("panel.agentFlow.status.completedFallback"),
      description: t("panel.agentFlow.event.fallbackCompleted"),
    });
  }

  if (run?.stream?.active) {
    let entry = entries
      .filter((item) => item.kind === "model")
      .find((item) => Number(item.requestNumber) === Number(run.stream.requestNumber));
    if (!entry) {
      entry = {
        id: `live-model:${run.runId}:${run.stream.requestNumber}`,
        kind: "model",
        requestNumber: Number(run.stream.requestNumber || 0),
        purpose: String(run.stream.purpose || "agent-turn"),
        title: t("panel.agentFlow.event.modelRound", {
          number: Number(run.stream.requestNumber || 0),
        }),
      };
      entries.push(entry);
    }
    Object.assign(entry, {
      status: "streaming",
      content: clipAgentText(run.stream.content, contentLimit),
      reasoning: clipAgentText(run.stream.reasoningContent, reasoningLimit),
      toolCalls: Array.isArray(run.stream.toolCalls) ? run.stream.toolCalls : [],
    });
  }

  if (run?.substage && !run.terminal) {
    const activeToolNumber = Number(run?.activeTool?.toolCallNumber || 0);
    const activeTool = entries.find(
      (entry) =>
        entry.kind === "tool" &&
        entry.status === "running" &&
        (!activeToolNumber || entry.toolCallNumber === activeToolNumber),
    );
    if (activeTool) {
      activeTool.description = [run.substage.text, run.substage.meta]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" · ") || activeTool.description;
      activeTool.substageLevel = String(run.substage.level || "info");
    }
  }

  const grouped = groupConsecutiveTools(entries, {
    maxGroupItems: options.maxToolGroupItems,
  });
  const maxEntries = Math.max(0, Math.floor(Number(options.maxEntries) || 0));
  const omittedByLimit = maxEntries ? Math.max(0, grouped.length - maxEntries) : 0;
  const omitted = Math.max(0, Number(run.omittedEventCount) || 0) + omittedByLimit;
  if (!omitted) return grouped;
  return [
    {
      id: `window:${run.runId || "run"}`,
      kind: "marker",
      status: "completed",
      title: t("panel.agentFlow.event.olderCollapsed", { count: omitted }),
    },
    ...(omittedByLimit ? grouped.slice(-maxEntries) : grouped),
  ];
}

function groupConsecutiveTools(entries, { maxGroupItems = 0 } = {}) {
  const itemLimit = Math.max(0, Math.floor(Number(maxGroupItems) || 0));
  const grouped = [];
  for (const entry of entries) {
    const previous = grouped.at(-1);
    if (
      entry.kind === "tool" &&
      entry.status !== "running" &&
      previous?.kind === "tool" &&
      previous.status !== "running" &&
      previous.name === entry.name
    ) {
      grouped.splice(-1, 1, {
        id: `tool-group:${previous.id}`,
        kind: "tool-group",
        name: entry.name,
        title: entry.title,
        status:
          previous.status === "failed" || entry.status === "failed"
            ? "failed"
            : "completed",
        items: itemLimit ? [previous, entry].slice(-itemLimit) : [previous, entry],
        totalCount: 2,
        omittedCount: itemLimit ? Math.max(0, 2 - itemLimit) : 0,
      });
    } else if (
      entry.kind === "tool" &&
      entry.status !== "running" &&
      previous?.kind === "tool-group" &&
      previous.name === entry.name
    ) {
      previous.totalCount = Number(previous.totalCount || previous.items.length) + 1;
      previous.items.push(entry);
      if (itemLimit && previous.items.length > itemLimit) {
        previous.items.splice(0, previous.items.length - itemLimit);
        previous.omittedCount = previous.totalCount - previous.items.length;
      }
      if (entry.status === "failed") previous.status = "failed";
    } else {
      grouped.push(entry);
    }
  }
  return grouped;
}

function renderDiagnostics(diagnosticId, { hasArguments = false, hasResult = false } = {}) {
  if (!hasArguments && !hasResult) return "";
  return `
    <details class="bme-agent-diagnostics" data-agent-diagnostic-id="${esc(diagnosticId)}">
      <summary>${esc(t("panel.agentFlow.diagnostics"))}</summary>
      <div class="bme-agent-diagnostics__content" data-agent-diagnostic-content></div>
    </details>`;
}

function renderEntry(entry) {
  if (entry.kind === "tool-group") {
    const totalCount = Number(entry.totalCount || entry.items.length);
    const details = entry.items
      .map((item, index) => `
        <div class="bme-agent-tool-group__item">
          <strong>#${index + 1}</strong>
          <span>${esc(item.description)}</span>
          ${renderDiagnostics(`${entry.id}:${index}`, {
            hasArguments: Boolean(item.arguments),
            hasResult: Boolean(item.result),
          })}
        </div>`)
      .join("");
    return `
      <div class="bme-agent-entry__icon"><i class="fa-solid fa-screwdriver-wrench"></i></div>
      <div class="bme-agent-entry__body">
        <div class="bme-agent-entry__title">${esc(entry.title)} <span class="bme-agent-entry__count">×${totalCount}</span></div>
        <details class="bme-agent-tool-group"${entry.status === "failed" ? " open" : ""}>
          <summary>${esc(t("panel.agentFlow.groupedCalls", { count: totalCount }))}</summary>
          ${entry.omittedCount ? `<div class="bme-agent-entry__text">${esc(t("panel.agentFlow.groupedCallsClipped", { count: entry.omittedCount }))}</div>` : ""}
          ${details}
        </details>
      </div>`;
  }
  if (entry.kind === "tool") {
    return `
      <div class="bme-agent-entry__icon"><i class="fa-solid ${entry.status === "running" ? "fa-spinner fa-spin" : entry.status === "failed" ? "fa-triangle-exclamation" : "fa-check"}"></i></div>
      <div class="bme-agent-entry__body">
        <div class="bme-agent-entry__title">${esc(entry.title)}</div>
        <div class="bme-agent-entry__text">${esc(entry.description)}</div>
        ${renderDiagnostics(entry.id, {
          hasArguments: Boolean(entry.arguments),
          hasResult: Boolean(entry.result),
        })}
      </div>`;
  }
  if (entry.kind === "model") {
    const toolPreview = Array.isArray(entry.toolCalls) && entry.toolCalls.length
      ? `<div class="bme-agent-model-tools">${entry.toolCalls.map((call) => `<span><i class="fa-solid fa-screwdriver-wrench"></i>${esc(toolTitle(toolName(call)))}</span>`).join("")}</div>`
      : "";
    return `
      <div class="bme-agent-entry__icon"><i class="fa-solid ${entry.status === "streaming" ? "fa-wave-square" : "fa-sparkles"}"></i></div>
      <div class="bme-agent-entry__body">
        <div class="bme-agent-entry__title">${esc(entry.title)}${entry.status === "streaming" ? `<span class="bme-agent-live-label">${esc(t("panel.agentFlow.live"))}</span>` : ""}</div>
        ${entry.content ? `<div class="bme-agent-model-content">${esc(entry.content)}${entry.status === "streaming" ? '<span class="bme-agent-stream-caret"></span>' : ""}</div>` : `<div class="bme-agent-entry__text">${esc(entry.status === "streaming" ? t("panel.agentFlow.waitingForModel") : t("panel.agentFlow.noTextOutput"))}</div>`}
        ${toolPreview}
        ${entry.reasoning ? `<details class="bme-agent-reasoning"><summary>${esc(t("panel.agentFlow.reasoning"))}</summary><pre>${esc(entry.reasoning)}</pre></details>` : ""}
      </div>`;
  }
  return `
    <div class="bme-agent-entry__icon"><i class="fa-solid ${entry.kind === "terminal" ? "fa-flag-checkered" : "fa-circle"}"></i></div>
    <div class="bme-agent-entry__body">
      <div class="bme-agent-entry__title">${esc(entry.title)}</div>
      ${entry.description ? `<div class="bme-agent-entry__text">${esc(entry.description)}</div>` : ""}
      ${entry.details ? renderDiagnostics(entry.id, { hasResult: true }) : ""}
    </div>`;
}

export function buildAgentEntryRenderSignature(entry = {}) {
  if (entry.kind === "tool-group") {
    return JSON.stringify([
      entry.kind,
      entry.status,
      entry.title,
      entry.totalCount || entry.items?.length || 0,
      ...(entry.items || []).flatMap((item) => [
        item.id,
        item.status,
        item.description,
        Boolean(item.arguments),
        Boolean(item.result),
      ]),
    ]);
  }
  if (entry.kind === "tool") {
    return JSON.stringify([
      entry.kind,
      entry.id,
      entry.status,
      entry.title,
      entry.description,
      Boolean(entry.arguments),
      Boolean(entry.result),
    ]);
  }
  if (entry.kind === "model") {
    return JSON.stringify([
      entry.kind,
      entry.id,
      entry.status,
      entry.title,
      entry.content,
      entry.reasoning,
      (entry.toolCalls || []).map((call) => toolName(call)),
    ]);
  }
  return JSON.stringify([
    entry.kind,
    entry.id,
    entry.status,
    entry.title,
    entry.description,
    Boolean(entry.details),
  ]);
}

function collectDiagnosticPayloads(entries) {
  const payloads = new Map();
  for (const entry of entries) {
    if (entry.kind === "tool-group") {
      entry.items.forEach((item, index) => {
        payloads.set(`${entry.id}:${index}`, {
          argumentsText: item.arguments,
          resultText: item.result,
        });
      });
    } else if (entry.kind === "tool") {
      payloads.set(entry.id, {
        argumentsText: entry.arguments,
        resultText: entry.result,
      });
    } else if (entry.details) {
      payloads.set(entry.id, { argumentsText: "", resultText: entry.details });
    }
  }
  return payloads;
}

function runTabsSignature(runs, timestamp = Date.now()) {
  return runs
    .map((run) =>
      `${run.runId}:${run.status}:${run.phase}:${run.cancellable}:${Math.floor(effectiveElapsed(run, timestamp) / 1000)}`,
    )
    .join("|");
}

export function buildAgentRunHeaderSignature(run = {}, timestamp = Date.now()) {
  const status = displayStatus(run);
  return JSON.stringify([
    run.runId, run.taskType, agentLabel(run), runScope(run), status.key, status.tone,
    Math.floor(effectiveElapsed(run, timestamp) / 1000), Number(run.modelRequestCount || 0),
    Number(run.toolCallCount || 0), Number(run?.usage?.total_tokens || run?.usage?.totalTokens || 0),
    run.cancellable === true, run.phase,
  ]);
}

export function createAgentRunViewController({
  root,
  getSnapshot,
  cancelRun,
  onError = () => {},
  now = () => Date.now(),
} = {}) {
  let selectedRunId = "";
  let runStripSignature = "";
  let runHeaderSignature = "";
  let shellMounted = false;
  let heartbeatTimer = null;
  let lastRuns = [];
  const entryNodes = new Map();
  let diagnosticPayloads = new Map();
  let timelineOrderSignature = "";

  function mountShell() {
    if (!root) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    root.innerHTML = `
      <div class="bme-agent-flow">
        <div class="bme-agent-run-strip-wrap">
          <div class="bme-agent-run-strip-label">${esc(t("panel.agentFlow.sessionRuns"))}</div>
          <div class="bme-agent-run-strip" data-agent-runs></div>
        </div>
        <div class="bme-agent-run-stage" data-agent-stage>
          <div class="bme-agent-run-header" data-agent-header></div>
          <div class="bme-agent-timeline" data-agent-timeline role="log" aria-live="polite" aria-relevant="additions"></div>
        </div>
        <div class="bme-agent-empty" data-agent-empty hidden>
          <div class="bme-agent-empty__icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
          <h3>${esc(t("panel.agentFlow.emptyTitle"))}</h3>
          <p>${esc(t("panel.agentFlow.emptyBody"))}</p>
        </div>
      </div>`;
    shellMounted = true;
    runStripSignature = "";
    runHeaderSignature = "";
    entryNodes.clear();
    diagnosticPayloads.clear();
    timelineOrderSignature = "";
  }

  function renderRunStrip(runs) {
    const strip = root?.querySelector?.("[data-agent-runs]");
    if (!strip) return;
    const timestamp = now();
    const signature = `${selectedRunId}|${runTabsSignature(runs, timestamp)}`;
    if (signature === runStripSignature) return;
    runStripSignature = signature;
    strip.innerHTML = runs
      .map((run) => {
        const status = displayStatus(run);
        return `<button class="bme-agent-run-chip${run.runId === selectedRunId ? " active" : ""}" type="button" data-agent-run-id="${esc(run.runId)}" aria-pressed="${run.runId === selectedRunId}" aria-label="${esc(`${agentLabel(run)} · ${status.label} · ${formatDuration(effectiveElapsed(run, timestamp))}`)}">
          <span class="bme-agent-run-chip__dot" data-tone="${esc(status.tone)}"></span>
          <span class="bme-agent-run-chip__name">${esc(agentLabel(run))}</span>
          <span class="bme-agent-run-chip__time">${esc(formatDuration(effectiveElapsed(run, timestamp)))}</span>
        </button>`;
      })
      .join("");
  }

  function renderHeader(run) {
    const header = root?.querySelector?.("[data-agent-header]");
    if (!header) return;
    const nextSignature = buildAgentRunHeaderSignature(run, now());
    if (nextSignature === runHeaderSignature) return;
    runHeaderSignature = nextSignature;
    const status = displayStatus(run);
    const usage = Number(run?.usage?.total_tokens || run?.usage?.totalTokens || 0);
    header.innerHTML = `
      <div class="bme-agent-run-heading">
        <div class="bme-agent-run-heading__icon"><i class="fa-solid ${run.taskType === "agent_recall" ? "fa-magnifying-glass" : "fa-brain"}"></i></div>
        <div>
          <div class="bme-agent-run-heading__title">${esc(agentLabel(run))}</div>
          <div class="bme-agent-run-heading__scope">${esc(runScope(run))}</div>
        </div>
        <span class="bme-agent-status-pill" data-tone="${esc(status.tone)}">${esc(status.label)}</span>
      </div>
      <div class="bme-agent-run-metrics">
        <span><i class="fa-regular fa-clock"></i>${esc(formatDuration(effectiveElapsed(run, now())))}</span>
        <span><i class="fa-solid fa-wave-square"></i>${esc(t("panel.agentFlow.metric.model", { count: Number(run.modelRequestCount || 0) }))}</span>
        <span><i class="fa-solid fa-screwdriver-wrench"></i>${esc(t("panel.agentFlow.metric.tools", { count: Number(run.toolCallCount || 0) }))}</span>
        ${usage > 0 ? `<span><i class="fa-solid fa-coins"></i>${esc(t("panel.agentFlow.metric.tokens", { count: usage }))}</span>` : ""}
        ${run.cancellable && run.phase !== "cancelling" ? `<button class="bme-agent-stop-btn" type="button" data-agent-action="cancel"><i class="fa-solid fa-stop"></i>${esc(t("panel.agentFlow.stop"))}</button>` : ""}
      </div>`;
  }

  function hydrateDiagnostic(details) {
    if (!details?.open || details.dataset.agentDiagnosticLoaded === "true") return;
    const payload = diagnosticPayloads.get(String(details.dataset.agentDiagnosticId || ""));
    const content = details.querySelector?.("[data-agent-diagnostic-content]");
    if (!payload || !content) return;
    content.innerHTML = `
      ${payload.argumentsText ? `<div class="bme-agent-diagnostics__label">${esc(t("panel.agentFlow.arguments"))}</div><pre>${esc(pretty(payload.argumentsText))}</pre>` : ""}
      ${payload.resultText ? `<div class="bme-agent-diagnostics__label">${esc(t("panel.agentFlow.result"))}</div><pre>${esc(pretty(payload.resultText))}</pre>` : ""}`;
    details.dataset.agentDiagnosticLoaded = "true";
  }

  function patchTimeline(run) {
    const timeline = root?.querySelector?.("[data-agent-timeline]");
    if (!timeline) return;
    const nearBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 72;
    const entries = buildAgentRunTimeline(run, {
      maxEntries: UI_TIMELINE_ENTRY_LIMIT,
      maxToolGroupItems: UI_TOOL_GROUP_ITEM_LIMIT,
      contentCharLimit: UI_MODEL_CONTENT_CHAR_LIMIT,
      reasoningCharLimit: UI_REASONING_CHAR_LIMIT,
    });
    diagnosticPayloads = collectDiagnosticPayloads(entries);
    const ids = new Set(entries.map((entry) => entry.id));
    for (const [id, node] of entryNodes) {
      if (!ids.has(id)) {
        node.remove();
        entryNodes.delete(id);
      }
    }
    for (const entry of entries) {
      let node = entryNodes.get(entry.id);
      if (!node) {
        node = document.createElement("article");
        node.dataset.agentEntryId = entry.id;
        entryNodes.set(entry.id, node);
      }
      const signature = buildAgentEntryRenderSignature(entry);
      if (node.dataset.signature !== signature) {
        const openDetails = [...(node.querySelectorAll?.("details[open]") || [])]
          .map((detail, index) =>
            detail.dataset.agentDiagnosticId || `${detail.className}:${index}`,
          );
        node.dataset.signature = signature;
        node.className = `bme-agent-entry is-${entry.kind} is-${entry.status || "idle"}`;
        node.innerHTML = renderEntry(entry);
        [...(node.querySelectorAll?.("details") || [])].forEach((detail, index) => {
          const key = detail.dataset.agentDiagnosticId || `${detail.className}:${index}`;
          if (openDetails.includes(key)) detail.open = true;
          hydrateDiagnostic(detail);
        });
      }
    }
    const nextOrderSignature = entries.map((entry) => entry.id).join("|");
    if (nextOrderSignature !== timelineOrderSignature) {
      const fragment = document.createDocumentFragment();
      for (const entry of entries) fragment.appendChild(entryNodes.get(entry.id));
      timeline.appendChild(fragment);
      timelineOrderSignature = nextOrderSignature;
    }
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }

  function scheduleHeartbeat(runs) {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (!runs.some((run) => !run.terminal)) return;
    const overlay = root?.closest?.("#st-bme-panel-overlay");
    if (overlay && !overlay.classList.contains("active")) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      const selected = lastRuns.find((run) => run.runId === selectedRunId);
      renderRunStrip(lastRuns);
      if (selected) renderHeader(selected);
      scheduleHeartbeat(lastRuns);
    }, 1000);
  }

  async function handleClick(event) {
    const runButton = event.target?.closest?.("[data-agent-run-id]");
    if (runButton) {
      selectedRunId = String(runButton.dataset.agentRunId || "");
      runStripSignature = "";
      refresh();
      return;
    }
    const cancelButton = event.target?.closest?.('[data-agent-action="cancel"]');
    if (!cancelButton || !selectedRunId || cancelButton.disabled) return;
    cancelButton.disabled = true;
    cancelButton.classList.add("is-pending");
    try {
      const result = await cancelRun?.(selectedRunId);
      if (result?.ok !== true) {
        throw new Error(result?.reason || t("panel.agentFlow.cancelFailed"));
      }
    } catch (error) {
      onError(error?.message || t("panel.agentFlow.cancelFailed"));
      cancelButton.disabled = false;
      cancelButton.classList.remove("is-pending");
    }
  }

  function handleToggle(event) {
    if (event.target?.matches?.("details.bme-agent-diagnostics")) {
      hydrateDiagnostic(event.target);
    }
  }

  function refresh({ reset = false, snapshot: suppliedSnapshot = null } = {}) {
    if (!root || typeof getSnapshot !== "function") return;
    if (reset || !shellMounted) mountShell();
    const snapshot =
      suppliedSnapshot || getSnapshot({ detailRunId: selectedRunId }) || {};
    const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    lastRuns = runs;
    if (!runs.some((run) => run.runId === selectedRunId)) {
      selectedRunId = runs.find((run) => !run.terminal)?.runId || runs[0]?.runId || "";
    }
    const empty = root.querySelector?.("[data-agent-empty]");
    const stage = root.querySelector?.("[data-agent-stage]");
    const stripWrap = root.querySelector?.(".bme-agent-run-strip-wrap");
    if (!runs.length) {
      if (empty) empty.hidden = false;
      if (stage) stage.hidden = true;
      if (stripWrap) stripWrap.hidden = true;
      scheduleHeartbeat(runs);
      return;
    }
    if (empty) empty.hidden = true;
    if (stage) stage.hidden = false;
    if (stripWrap) stripWrap.hidden = false;
    const selected = runs.find((run) => run.runId === selectedRunId) || runs[0];
    renderRunStrip(runs);
    renderHeader(selected);
    patchTimeline(selected);
    scheduleHeartbeat(runs);
  }

  root?.addEventListener?.("click", handleClick);
  root?.addEventListener?.("toggle", handleToggle, true);
  return Object.freeze({
    refresh,
    reset: () => refresh({ reset: true }),
    getSelectedRunId: () => selectedRunId,
  });
}
