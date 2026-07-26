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

The memory LLM is used for:

- Memory extraction.
- Recall reranking.
- Consolidation.
- Compression.
- Small summaries.
- Summary rollup.
- Reflection.
- ENA Planner planning.

Configuration options:

- **Leave blank**
  - Reuse the current SillyTavern chat model.

- **Fill in OpenAI-compatible config**
  - Use an independent model for memory tasks.
  - Useful when you want to separate the main chat model from the background maintenance model.

Security recommendations:

- Do not publicly share exported `extension_settings` or browser storage that contains API keys.
- Debug logs are off by default; enable them temporarily only when troubleshooting.

### Embedding

Embedding is the core of smart recall.

#### Backend mode

Backend mode is recommended first:

- Reuse SillyTavern backend's embedding provider.
- Usually avoids storing the embedding API key directly in the browser.
- Can use sources already supported by SillyTavern, such as OpenAI, Cohere, Mistral, Ollama, LlamaCpp, and vLLM.

#### Direct mode

In direct mode, the browser requests the embedding service directly:

- Requires filling in the API URL, key, and model.
- May hit CORS restrictions.
- Suitable for a self-hosted gateway or independent embedding service.

> After switching embedding mode or model, run "rebuild vectors".

### Extraction settings

| Setting | Default | Description |
| --- | --- | --- |
| 每 N 条回复提取 | `1` | Trigger extraction every N assistant replies |
| 提取上下文轮数 | `2` | Number of conversation rounds to look back during extraction |
| 自动延后最新助手 | `false` | Allows the latest reply to stabilize before extraction |
| Extraction pipeline version | `split-v1` | Default two-stage extraction: objective facts, then subjective/POV. Old custom extraction prompts automatically fall back to the legacy single-call path. |
| Assistant 排除标签 | `think,analysis,reasoning` | Excludes reasoning tags by default |
| 提取消息上限 | `0` | `0` means unlimited |
| 提取 Prompt 结构模式 | `both` | Provides both transcript and structured messages |
| 提取世界书模式 | `active` | Reuses the currently active world info context |
| 包含故事时间 | `true` | Provides the story timeline during extraction |
| 包含总结快照 | `true` | Provides active summaries during extraction |
| 手动提取模式 | `pending` | Default extraction mode in the panel |

### Recall settings

| Setting | Default | Description |
| --- | --- | --- |
| 启用召回 | `true` | Automatically retrieve memories before generation |
| 向量预筛 | `true` | Use embedding to find candidates first |
| 图扩散 | `true` | Diffuse along graph relations to related nodes |
| LLM 精排 | `true` | Let the LLM select final results from candidates |
| 召回 Top-K | `20` | Vector prefilter count |
| 最终节点上限 | `12` | Maximum number of nodes kept before injection |
| 图扩散 Top-K | `100` | Graph diffusion candidate count |
| LLM 候选池 | `30` | Candidate pool size for reranking |
| 多意图拆分 | `true` | Split one input into multiple retrieval intents |
| 上下文混合查询 | `true` | Blend the current input, previous assistant reply, and previous user message |
| 词法增强 | `true` | Weight exact keyword matches |
| 时序链接 | `true` | Mutually boost temporally nearby nodes |
| 多样性采样 | `true` | Avoid overly homogeneous recall results |

### Cognitive and spatial settings

| Setting | Default | Description |
| --- | --- | --- |
| Scoped Memory | `true` | Enable scoped memory |
| POV Memory | `true` | Enable character/user POV memory |
| 区域目标 | `true` | Distinguish current region, adjacent regions, and global |
| 认知记忆 | `true` | Enable subjective/objective cognitive attribution |
| 空间邻接 | `true` | Allow adjacency relations between regions |
| 故事时间线 | `true` | Enable story timeline tags |
| 注入故事时间标签 | `true` | Hint the current story time in injection |
| 软时间引导 | `true` | Guide by prompting, without forcing rewrites |

### Maintenance settings

| Setting | Default | Description |
| --- | --- | --- |
| 启用整合 | `true` | Similar/conflicting memory analysis and merge |
| 整合阈值 | `0.85` | Similarity trigger threshold |
| 启用小总结 | `true` | Compatible with the old `synopsis` name |
| 启用层级总结 | `true` | Use a small summary + rollup summary system |
| 小总结频率 | `3` | Generate a small summary every N extractions |
| 总结折叠扇入 | `3` | Roll up summaries when this many exist at the same layer |
| 启用智能触发 | `false` | Enhance extraction only in high-information scenes |
| 启用主动遗忘 | `false` | Periodically lower the priority of low-value nodes |
| 启用概率召回 | `false` | Allow a small number of weakly related memories to enter by probability |
| 启用反思 | `true` | Periodically summarize long-term trends |
| 启用自动压缩 | `true` | Compress similar memories by extraction cycle |

### Task presets and regex cleanup

Task preset types:

- **`extract`**
  - Memory extraction.

- **`extract_objective` / `extract_subjective`**
  - Objective and subjective/POV stages for the default `split-v1` extraction pipeline. This version only splits task type and commit boundaries; it does not rewrite prompt text here. Old custom `extract` prompts/profiles automatically fall back to the legacy single-call path.

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
- Historical `<plot>` blocks.
- Current player input blocks.

Recommendations:

- Configure the base API and enabled state in "Config → ENA Planner".
- Adjust the planning prompt structure and generation parameters in "Config → Task presets → planner".

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
