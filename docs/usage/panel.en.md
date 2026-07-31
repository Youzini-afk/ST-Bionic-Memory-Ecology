# Panel guide

[中文](panel.md) · **English**

This page is split out from the [README](../../README.en.md) as a user guide to the ST-BME panel areas, preserving the original item structure for daily lookup.

### Overview

- **Active nodes, edge connections, archived, fragmentation ratio**
- **Current chat ID**
- **History status**
- **Vector status**
- **Recent recovery**
- **Background Memory Steward**
- **Recent persistence**
- **Recent vector**
- **Recent recall**
- **Cognitive / spatial status**

### Tasks

The tasks page is used to observe ST-BME's background task flow in realtime.

- **Pipeline overview**
  - Independent status for Memory Steward, Recall Agent, persistence, and vectors. Background maintenance does not keep foreground recall marked as extracting.

- **Task timeline**
  - Timeline and stage results for recent tasks.

- **Memory browser**
  - Browse, filter, and inspect node details.

- **Injection preview**
  - View the currently constructed injection text and token estimate.

- **Message tracing**
  - Trace turns, extraction ranges, recall sources, and persistent records.

- **Persistence**
  - View diagnostics for the selected primary storage, Cloud Sync, recovery, sidecar, native hydrate, and more.

### Actions

- **Re-extract**
  - “Extract unprocessed” and “Re-extract range” submit durable background intents. The Steward inspects those evidence ranges and decides revisions; they do not start a legacy pipeline.

- **Manual compression**
  - Compress redundant or similar memories.

- **Generate small summary**
  - Generate a staged summary based on a recent source text window.

- **Run summary rollup**
  - Fold multiple active summaries into a higher-level summary.

- **Rebuild summary state**
  - Rebuild summary state from extraction batches.

- **Force evolution**
  - Let new memories actively affect old memories.

- **Run forgetting**
  - Lower the priority of long-unused nodes or archive them.

- **Undo recent maintenance**
  - Compatibility entry for old maintenance logs. Agent-era revisions recover through ledger versions and evidence validity.

- **Rebuild vectors / Range rebuild / Direct re-embed**
  - Rebuild node vectors to fix recall quality or inconsistencies after switching vector models.

- **Export / import / rebuild graph**
  - Graph management and dangerous operations.

- **Persistence repair**
  - Retry persistence, re-detect the graph, rebuild the local cache, and repair/compact the main sidecar.

### Config

The config page contains these workspaces:

- **API config**
  - BME's dedicated Agent model, connection test, context window, and background runaway guards.
  - The default direct Embedding API / SillyTavern backend index mode.

- **Feature toggles**
  - BME, Recall Agent, ENA, cognitive/spatial memory, and probabilistic candidates. The Steward chooses reconciliation, summary, reflection, compression, and forgetting tools as needed.
  - Cloud Sync behavior. Standard ST selects OPFS / IndexedDB automatically; automatic Cloud Sync is disabled when Authority SQL or Luker chat-state is primary, while manual server backups remain optional.
  - World info filtering.
  - Hide old turns and limit rendered chat turns.

- **Detailed parameters**
  - Agent context window, default 500-tool / 8-minute background guards, recall Top-K, graph diffusion, and cognitive weights. Fixed maintenance cadence/similarity gates are no longer exposed.

- **Task presets**
  - Prompt blocks, generation parameters, regex, world info, and EJS templates for each task type.

- **ENA Planner**
  - Explicit enablement, BME LLM preset, planning context/filter options, tests and logs, plus the `planner` task preset entry point.

- **Panel appearance**
  - Theme, notification style, debug logs, and Native acceleration.

- **Data cleanup**
  - Cleanup entry points for local cache, legacy data, debug state, and more.

### Graph area

Desktop shows a realtime graph area with a deep-space visual style for the current memory graph. Nodes and edges use semantic styling; hovering or selecting an item keeps related structure highlighted while unrelated content is gently dimmed.

When recall or extraction runs while the graph is visible, the relevant nodes may show brief highlights for memories used or newly produced in that turn. These highlights are render-only and do not change the memory graph; reduced-motion preferences are respected.

New graphs start with a “memory star system” layout: core memories near the center, topic memories around them, and fragment memories near related anchors. Existing layouts are reused first.

Mobile provides subview switching:

- **Realtime graph**
- **Cognitive view**
- **Summary view**
