# 提取算法

写入链路的核心：助手回复落地后，把新对话提炼成图谱节点与关系。

运行时入口是自动提取计划 `resolveAutoExtractionPlanController()`（`maintenance/extraction-controller.js`），核心提取是 `extractMemories()`（`maintenance/extractor.js`）。

> `extractor.js` 头注释概括为"Mem0 精确对照 + Graphiti 时序边 + MemoRAG 全局概要"。这些技术名是灵感来源，实际实现见下，部分比原论文更简化。

## 1. 自动提取计划

`resolveAutoExtractionPlanController()` 决定是否运行：

- 设置启用、自动提取启用（`extractAutoEnabled=true`）
- 上次处理之后的待处理助手楼层数
- 可选 lag-one 策略（`extractAutoDelayLatestAssistant`，默认 false）：延迟一层提取，避开最新一条还在变动
- 可选智能触发（见下）

**触发条件**：待处理数达到 `extractEvery`（默认 1，即每条助手消息都提取），或智能触发命中。

### 智能触发（`smart-trigger.js`）

`enableSmartTrigger`（默认 false）启用时，给待处理消息打分：

| 信号 | 加分 |
| --- | --- |
| 关键词命中（`DEFAULT_TRIGGER_KEYWORDS`） | `min(2, 命中数)` |
| 自定义正则（`triggerPatterns`）首个命中 | +2 |
| 角色切换 ≥ 2 次 | +1 |
| ≥ 2 个 `!?！？` | +1 |
| 实体型正则命中 | +1 |

`triggered = score >= max(1, smartTriggerThreshold)`（默认阈值 2）。

## 2. 构建结构化提取输入

`buildExtractionInputContext()`（`extraction-context.js`）：

- 规范化角色/内容/说话者/序号
- **先应用助手提取规则**，再应用排除规则
- **过滤系统提取消息**和被排除标签的内容（默认排除 `think,analysis,reasoning`）
- 丢弃空消息
- 构建原始和过滤后的 transcript

可选近期消息上限 `extractRecentMessageCap`（默认 0 = 不限）。提示词模式 `extractPromptStructuredMode` 默认 `"both"`（可选 `transcript` / `structured` / `both`）。

## 3. 默认双阶段提取管线

默认提取没有旧版单请求回退。同一批结构化输入固定进入两个职责更窄的 LLM 阶段：

1. **客观阶段**（`extract_objective`）：只保留客观图谱操作，例如事件、角色、地点、规则、线程、区域和故事时间。该阶段输出中的 `pov_memory` 与 cognition 更新会被过滤掉。
2. **主观/POV 阶段**（`extract_subjective`）：只保留 `pov_memory` 与 cognition 更新。该阶段输出中的客观节点、区域更新和批次故事时间会被过滤掉。

两个阶段都通过校验后，才合并为一个 commit plan，并一次性写入图谱；如果主观阶段失败或输出无效，客观阶段不会先落库。这保证默认提取仍然保持“一次 batch、一次提交、一次持久化”的原子边界。

旧版 `extract` task profile、`extractPrompt` 与 `legacy-single` 管线已移除。默认预设只保留 `extract_objective` / `extract_subjective`，UI 也只暴露“客观提取 / 主观提取”。

## 4. 构建提取提示词

双阶段管线复用同一套提取 Prompt 上下文构建能力，但分别使用对应 task type 进入 LLM 调用。上下文分层包括：

1. 当前对话（结构化 + transcript）
2. 图谱状态上下文（`buildTaskGraphStats()`，topK 12、diffusionTopK 48、多意图开、最大文本 1200）
3. 活跃总结（`extractIncludeSummaries !== false`，默认含）
4. 故事时间上下文（`extractIncludeStoryTime !== false`，默认含）
5. schema 定义
6. 认知增强提示

LLM JSON 调用，maxRetries 2。

## 5. 规范化 LLM 操作

从多种可能的容器键里提取操作数组，规范化每个操作的 `action` / `type` / `nodeId` / `ref` / `links` / `clusters` / `scope` / `storyTime` / `fields`，以及 `cognitionUpdates` / `regionUpdates` / `batchStoryTime`。

## 6. 写入图谱

遍历规范化操作：

- **create** → `handleCreate()`：新建节点。`latestOnly` 类型若同名节点已存在则直接更新（Mem0 式精确对照的一种）。
- **update** → `handleUpdate()`：更新节点 + 时序边（见下）。
- **delete** → 归档（archive，不物理删除）。
- **`_skip`** → 忽略。

链接（links）先排队，所有节点操作后统一应用。可选在本批变更节点之间建默认 `related` 边（`extractDefaultBatchRelatedEdgeStrength`，默认 0.25）。直连向量模式下为缺向量的节点生成 embedding。最后应用认知更新、区域更新、批次故事时间。

## 时序边（Graphiti 式）

update 操作触发时序处理：

- 使旧 `updates` 边和旧 `temporal_update` 边失效
- 若有 `sourceNodeId` 且与目标不同：建 `temporal_update` 边（`strength` 默认 0.95，edgeType 0）
- 若字段有变化：建一个描述"状态更新"的 `event` 节点（重要度夹在 `[4, 8]`），并从该事件节点建 `updates` 边指向被更新节点（strength 0.9）

显式链接里 `contradicts` 映射为抑制边（edgeType 255，默认强度 0.8）——这就是扩散算法里的抑制边来源。

## 故事时间线（temporal metadata）

`batchStoryTime` 和操作级 `storyTime` 规范化后应用：

- `event` / `pov_memory` 用时间点 `storyTime`
- `thread` / `synopsis` / `reflection` 用时间跨度 `storyTimeSpan`
- 操作故事时间会解析/更新时间线段

## 全局概要（MemoRAG 式）

遗留的 `generateSynopsis()` 在 ≥ 3 个活跃事件节点时，把所有活跃事件/角色/线程总结成一个 `synopsis` 节点（重要度 9.0，200 字以内）。

> 当前默认后处理优先走**分层总结**（hierarchical summary），而非 `generateSynopsis()`。分层总结见 [`consolidation-and-compression.md`](consolidation-and-compression.md)。

## 7. 后处理

`handleExtractionSuccessController()`（`maintenance/extraction-success-controller.js`）在提取成功后依次处理：整合去重 → 分层总结 → 反思 → 睡眠遗忘 → 压缩 → 向量同步。这些见 [`consolidation-and-compression.md`](consolidation-and-compression.md)。

## 关键默认参数

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `extractAutoEnabled` | true | 自动提取 |
| `extractEvery` | 1 | 每 N 条助手消息提取 |
| `extractContextTurns` | 2 | 上下文轮数 |
| `extractAutoDelayLatestAssistant` | false | lag-one 延迟提取 |
| `extractPromptStructuredMode` | "both" | 提示词模式 |
| `enableSmartTrigger` | false | 智能触发 |
| 排除标签 | think,analysis,reasoning | 提取时过滤 |
