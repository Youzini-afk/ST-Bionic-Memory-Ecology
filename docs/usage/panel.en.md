# Panel guide

[中文](panel.md) · **English**

This page is split out from the [README](../../README.en.md) as a user guide to the ST-BME panel areas, preserving the original item structure for daily lookup.

### Overview

- **Active nodes, edge connections, archived, fragmentation ratio**
- **Current chat ID**
- **History status**
- **Vector status**
- **Recent recovery**
- **Recent extraction**
- **Recent persistence**
- **Recent vector**
- **Recent recall**
- **Cognitive / spatial status**

### Tasks

The tasks page is used to observe ST-BME's background task flow in realtime.

- **Pipeline overview**
  - Stage status for extraction, recall, persistence, vectors, and more.

- **Task timeline**
  - Timeline and stage results for recent tasks.

- **Memory browser**
  - Browse, filter, and inspect node details.

- **Injection preview**
  - View the currently constructed injection text and token estimate.

- **Message tracing**
  - Trace turns, extraction ranges, recall sources, and persistent records.

- **Persistence**
  - View diagnostics for IndexedDB, sync, recovery, sidecar, native hydrate, and more.

### Actions

- **Re-extract**
  - `提取未处理`: only process assistant turns that have not been extracted yet.
  - `重新提取范围`: rerun a specified range by start/end turn.

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
  - Roll back the most recent reversible maintenance action.

- **Rebuild vectors / Range rebuild / Direct re-embed**
  - Rebuild node vectors to fix recall quality or inconsistencies after switching vector models.

- **Export / import / rebuild graph**
  - Graph management and dangerous operations.

- **Persistence repair**
  - Retry persistence, re-detect the graph, rebuild the local cache, and repair/compact the main sidecar.

### Config

The config page contains these workspaces:

- **API config**
  - Memory LLM.
  - Embedding backend mode/direct mode.

- **Feature toggles**
  - Main capabilities such as extraction, recall, consolidation, summary, reflection, compression, forgetting, and probabilistic recall.
  - Cloud storage mode.
  - World info filtering.
  - Hide old turns and limit rendered chat turns.

- **Detailed parameters**
  - Extraction frequency, context window, recall Top-K, graph diffusion, cognitive weights, maintenance thresholds, and more.

- **Task presets**
  - Prompt blocks, generation parameters, regex, world info, and EJS templates for each task type.

- **ENA Planner**
  - API, model, planning config, and task preset entry point for ENA Planner.

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
