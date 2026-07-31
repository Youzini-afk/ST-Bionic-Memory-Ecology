# Configuration

[中文](configuration.md) · **English**

This page is split out from the [README](../../README.en.md) as the main ST-BME user configuration reference, preserving setting names, defaults, and tables for quick lookup by feature.

### Interface language

`Interface Language` only affects ST-BME frontend UI: the panel, menu entries, floating button, status messages, Toasts, recall cards, and graph system labels.

Options:

- `Auto`: follows the SillyTavern / browser language when available, otherwise falls back to Chinese.
- `Simplified Chinese`: forces the Chinese UI.
- `English`: forces the English UI.

This setting **does not** translate chat content, user input, AI replies, memory nodes, recall injection text, or prompt construction. Switching the interface language does not change the memory graph or model behavior.

### Memory LLM

The memory LLM is BME's dedicated Agent model. It powers the Memory Steward's
extraction, reconciliation, and evolution, the Recall Agent, and ENA Planner.

Configuration options:

- **Leave blank**
  - Agent work never falls back to the current SillyTavern chat model or DOA's model. Background work is deferred and foreground work reports a clear configuration error.

- **Fill in OpenAI-compatible config**
  - Use one independent model for all BME Agent work.
  - Set the model's context window; BME compacts Agent context by tokens before reaching it.
  - Background work defaults to 500 tool calls and eight minutes. Both runaway guards are configurable.

Security recommendations:

- Do not publicly share exported `extension_settings` or browser storage that contains API keys.
- Debug logs are off by default; enable them temporarily only when troubleshooting.

### Embedding

Embedding is the core of smart recall.

#### Direct Embedding API (default)

In direct mode, the browser requests an independent embedding service directly:

- Requires filling in the API URL, key, and model.
- May hit CORS restrictions.
- Suitable for a self-hosted gateway or independent embedding service.

#### SillyTavern backend index

Backend index mode reuses SillyTavern's embedding provider:

- Usually avoids storing the embedding API key directly in the browser.
- Limited to sources supported by SillyTavern, such as OpenAI, Cohere, Mistral, Ollama, LlamaCpp, and vLLM.

> After switching embedding mode or model, run "rebuild vectors".

### Agent memory writes

After an assistant reply enters the chat, BME first stores it as immutable
evidence and admits durable work, then wakes the Memory Steward in the
background. The Steward decides from the evidence and current memory whether
to extract, revise, reconcile, summarize, archive, or explicitly make no
change. These capabilities no longer run as mandatory stages on fixed counts
or similarity thresholds.

- Tags such as `think`, `analysis`, and `reasoning` are still cleaned before Agent input.
- Generation and recall never wait for background work; they read the latest committed ledger version.
- Manual “extract”, “compress”, or “evolve” actions submit a background intent to the Steward instead of starting a second legacy writer.
- Every publish validates source evidence and read dependencies in one per-chat transaction.

### Recall settings

| Setting | Default | Description |
| --- | --- | --- |
| Enable recall | `true` | Automatically retrieve memories before generation |
| Vector prefilter | `true` | Use embedding to find candidates first |
| Graph diffusion | `true` | Diffuse along graph relations to related nodes |
| Recall Agent | `true` | Start from fast candidates, query deeper when needed, and publish the result |
| Recall Top-K | `20` | Vector prefilter count |
| Final memory limit | `12` | Maximum number of nodes kept before injection |
| Diffusion Top-K | `100` | Graph diffusion candidate count |
| Agent candidate pool | `30` | Initial candidate packet size |
| Multi-intent queries | `true` | Split one input into multiple retrieval intents |
| Context-blended query | `true` | Blend the current input, previous assistant reply, and previous user message |
| Lexical boost | `true` | Weight exact keyword matches |
| Temporal links | `true` | Mutually boost temporally nearby nodes |
| Diversity sampling | `true` | Avoid overly homogeneous recall results |

### Cognitive and spatial settings

| Setting | Default | Description |
| --- | --- | --- |
| Scoped Memory | `true` | Enable scoped memory |
| POV Memory | `true` | Enable character/user POV memory |
| Region targeting | `true` | Distinguish current region, adjacent regions, and global |
| Cognitive memory | `true` | Enable subjective/objective cognitive attribution |
| Spatial adjacency | `true` | Allow adjacency relations between regions |
| Story timeline | `true` | Enable story timeline tags |
| Inject story-time tags | `true` | Hint the current story time in injection |
| Soft time guidance | `true` | Guide by prompting, without forcing rewrites |

### Agent runtime settings

| Setting | Default | Description |
| --- | --- | --- |
| Context window | `128000` tokens | Model context available to BME Agents; context is summarized and compacted by tokens before the limit |
| Background tool-call limit | `500` | Runaway guard for one Memory Steward task |
| Background run limit | `8` minutes | Runaway guard for one background Agent task |
| Probabilistic recall | `false` | Allow a small number of weak candidates into the programmatic candidate packet |

Extraction, reconciliation, summarization, relation repair, and forgetting are
chosen by the Memory Steward from current evidence and memory state. Generation
and recall never wait for maintenance: completed work is visible immediately,
while unfinished work leaves the current committed graph usable.

### Task presets and regex cleanup

Task preset types:

The live memory writer and recall path are owned by Agent tool loops. Task
profiles still customize generation parameters, regex, world info, and EJS
context, and remain available to ENA and explicit tool capabilities; they no
longer form a fixed per-turn pipeline.

- **`extract`**
  - Memory extraction.

- **`extract_objective` / `extract_subjective`**
  - Objective and subjective/POV templates available to explicit extraction tools; they are not mandatory two-stage work on every turn.

- **`recall`**
  - Recall reranking.

- **`compress`**
  - Memory compression.

- **`synopsis`**
  - Small summary generation.

- **`summary_rollup`**
  - Summary rollup.

- **`reflection`**
  - Long-term reflection.

- **`consolidation`**
  - Memory consolidation.

- **`planner`**
  - ENA Planner planning.

Regex cleanup reduces polluted tags from entering extraction, recall, and injection:

- `thinking` / `think` / `analysis` / `reasoning`
- `choice`
- `UpdateVariable`
- `status_current_variable`
- `StatusPlaceHolderImpl`

Users can adjust global regex rules and task-local rules in "Task presets". When an empty rule set is explicitly saved, the plugin will not automatically add the default rules back.

### ENA Planner

ENA Planner is now integrated through the `planner` task preset. For deeper implementation and flow details, see the [ENA Planner feature doc](../features/ena-planner.md). It can use:

- Character card blocks.
- World info blocks.
- Recent chat blocks.
- BME recalled memory blocks.
- Structured, persisted historical `<plot>` blocks.
- Current player input blocks.

Recommendations:

- Explicitly enable ENA and select a BME LLM preset under "Config → ENA Planner"; leave it empty to follow the current global BME LLM.
- Adjust the only active planning prompt structure and generation parameters under "Config → Task presets → planner".
- Reroll reruns neither recall nor ENA; it reuses the parent user turn's persisted Recall and Planner Artifacts.

### Hide old turns and render limit

These are two separate features; for deeper implementation and boundary details, see the [Hide old turns and render limit feature doc](../features/hide-and-render.md):

- **Hide old turns**
  - Controls context tokens.
  - Does not delete chat content.
  - Uses SillyTavern's hide mechanism so earlier turns no longer participate in the main reply or ST-BME reads.

- **Limit rendered chat turns**
  - Reduces lag in very long chat UIs.
  - Syncs to SillyTavern's `chat_truncation`.
  - Only controls how many recent turns the frontend loads at most.
  - It is not context hiding and is not message deletion.

Important notes:

- If you need to run "rerun extraction range" or full history recovery on very old turns, temporarily disable the render limit or increase the count and refresh.
- When ST-BME detects that the current `context.chat` is likely only a recent N-turn render slice, it pauses destructive history recovery to avoid wrongly clearing the runtime graph.

### Native acceleration

Native acceleration is currently a gradual rollout capability. For deeper implementation and fallback strategy details, see the [Native acceleration feature doc](../features/native-acceleration.md). It covers:

- Graph layout.
- Persist Delta.
- Snapshot Hydrate.

Default strategy:

- Automatically activates based on thresholds for node count, edge count, record count, structural changes, and serialized size.
- `Fail-open` is enabled by default; when Native is unavailable or fails, ST-BME falls back to JS.
- You can use "globally force-disable Native" to fall back to JS everywhere.
