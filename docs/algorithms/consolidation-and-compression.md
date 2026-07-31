# 整合、压缩与分层总结

提取后处理链路里的三个维护算法：记忆整合/去重、压缩遗忘、分层总结。它们让图谱长期保持精简、不无限膨胀。

实现：`maintenance/consolidator.js`、`maintenance/compressor.js`、`maintenance/hierarchical-summary.js`。

## 整合 / 去重（Mem0 式）

分两层：自动整合门 + 整合执行。

### 自动整合门（`analyzeAutoConsolidationGate`）

决定要不要触发整合。默认 `conflictThreshold = 0.85`。对每个新节点：

- 候选 = 活跃、未归档、非自身、且 scope/故事时间兼容（`canMergeTemporalScopedMemories`）的节点
- 若类型是 `latestOnly`：对 `name`/`title` 做规范化精确匹配（去空白、折叠空格、小写），命中则触发，分数 1
- 否则：对 scoped 候选做向量 top-1 相似度，分数 ≥ 阈值则触发

更高层门控：候选数 ≥ `consolidationAutoMinNewNodes`（默认 2）则无条件运行；不足且分析触发则运行。

### 整合执行（`consolidateMemories`）

需要有效向量配置，否则跳过。

- **Phase 0**：收集有向量文本的活跃新节点。少于 2 个则全保留。
- **Phase 1/2**：直连模式一次 `embedBatch()` 嵌入所有新节点；从有 embedding 的活跃节点建候选池；本地余弦 `searchSimilar()` 找邻居（默认 `neighborCount=5`）。
- **Phase 3**：LLM 批量决策，每个新节点返回 `action: keep|merge|skip`、`merge_target_id`、`merged_fields`、`evolution`。
- **Phase 4** 应用：
  - `skip`：新节点归档
  - `merge`（目标活跃且兼容）：用 `merged_fields` 或用新节点填补目标缺失字段；更新 `seq`/`seqRange`；复制缺失的 storyTime；清空目标 embedding；归档新节点
  - `keep`：保留；并对 evolution 建 `related` 边（strength 0.7）、更新邻居 state/summary、记录 `_evolutionHistory`

> Mem0 式精确匹配主要体现在 `latestOnly` 类型的同名即时更新和整合门的精确匹配；更广的去重/合并是"LLM 在向量邻居上决策"，不是纯确定性精确匹配。

| 参数 | 默认 |
| --- | --- |
| `enableConsolidation` | true |
| `consolidationNeighborCount` | 5 |
| `consolidationThreshold` | 0.85 |
| `consolidationAutoMinNewNodes` | 2 |

## 压缩（分层）

`compressAll()` 对每个 `compression.mode === "hierarchical"` 的 schema 类型运行 `compressType()`。

自动调度：`enableAutoCompression`（默认 true），`compressionEveryN`（默认 10，夹 1..500），当 `extractionCount % everyN === 0` 时调度。

压缩窗口参数来自各 schema 类型的 `compression` 配置：

- `fanIn`（min 2，缺省 2）：每组压缩多少个子节点
- `threshold`（缺省 = fanIn）：组多大才压缩
- `keepRecentLeaves`（缺省 0）：保留最近 N 个叶子不压缩
- `maxDepth`（缺省 1）：最大压缩层级

压缩流程：取某类型某层级的活跃节点按 seq 排序 → 按 POV owner / 客观区域分组 → 跳过太小的组 → 对 `fanIn` 个一批 LLM 总结成一个压缩节点（`level + 1`，importance 取子节点最大，seqRange 覆盖首末）→ 子节点归档并设 `parentId` → 外部边迁移到压缩节点（内部边忽略）。

## 遗忘 / 睡眠周期

`sleepCycle()`（`compressor.js`）。自动触发：`enableSleepCycle`（默认 false）且 `extractionCount % sleepEveryN === 0`（默认 10）。

跳过：`synopsis`/`rule`/`thread` 类型、`importance >= 8`、创建不足 1 小时的节点。

保留价值计算：

```
ageHours       = (now - createdTime) / 3600000
recency        = 1 / (1 + log10(1 + ageHours))
accessFreq     = accessCount / max(1, ageHours / 24)
retentionValue = (importance / 10) × recency × (1 + accessFreq)
```

`retentionValue < forgetThreshold`（默认 0.5）的节点归档（不物理删除）。

> 已知边界：`sleepCycle` 直接用 `node.accessCount`，若未初始化会算出 NaN，使该节点不被遗忘（NaN < threshold 为 false）。

## 分层总结

`runHierarchicalSummaryPostProcess()`（`hierarchical-summary.js`）。默认启用（`enableHierarchicalSummary !== false`）。

### 小总结（small summary）

`generateSmallSummary()`：阈值 `smallSummaryEveryNExtractions`（默认 3，夹 1..100）。当 `currentExtractionCount - lastSummarizedExtractionCount >= 阈值` 时，把自上次以来的提取切片（含当前批次）总结成一条 `synopsis`（80-220 字），记为 `level:0, kind:"small", status:"active"`，带 extractionRange/messageRange/sourceBatchIds 等。

### 卷积/折叠总结（rollup）

`rollupSummaryFrontier()`：fan-in `summaryRollupFanIn`（默认 3，夹 2..10）。当同层活跃总结条目数 > fanIn 时，取前 fanIn 条 LLM 卷成一条更高层总结（120-260 字），源总结标记为 folded，新总结记为 `level + 1, kind:"rollup"`。循环直到没有可折叠的组。

这形成一个"小总结 → 折叠总结 → 更高层折叠"的金字塔，让久远的剧情用越来越浓缩的形式保留。

| 参数 | 默认 |
| --- | --- |
| `enableHierarchicalSummary` | true |
| `smallSummaryEveryNExtractions` | 3 |
| `summaryRollupFanIn` | 3 |
| `enableAutoCompression` | true |
| `compressionEveryN` | 10 |
| `enableSleepCycle` | false |
| `forgetThreshold` | 0.5 |
| `sleepEveryN` | 10 |
