# Recall Agent 与多通道候选

读取链路采用“快速回想 + 按需深查”：程序算法先生成覆盖面广、成本低的候选包；Recall Agent 可以直接发布，也可以像人继续查目录、原文与关系。它不是把固定关键词交给一次 LLM 精排，也不会让生成等待后台 Memory Steward。

入口：`retrieval/recall-controller.js` → `BmeMemoryLifecycleRuntime.recall()` → `application/recall-agent-service.js`。候选包在 `retrieval/recall-candidate-packet.js` 构造，深查工具在 `agent/recall-agent-tools.js`。

## 1. 回合身份与 Artifact 复用

fresh user generation 根据稳定 `chatId + turnId + input/history fingerprint` 查找 Recall Artifact：

- 精确命中 `ready` 或 `empty` 时直接复用；
- 新输入只运行一个 Recall Agent；
- ENA 规划先触发这唯一一次召回，并把 Artifact 通过 handoff 交给正常生成；
- reroll / swipe / regenerate 复用父 user turn 的 Recall / Planner Artifact，不重跑 Agent；
- evidence 或输入版本失效时，旧 Artifact 不会被错误认领。

`empty` 是成功结果：第一层没有记忆也会落盘并显示召回卡片，避免 ENA 或 reroll 因“没文本”再次调用模型。

## 2. 程序化候选包

`buildRecallCandidatePacket()` 在账本的当前图谱投影副本上运行确定性检索，并强制关闭旧 LLM 精排和概率注入。它保留原有快速算法的价值：

1. 当前输入与近期上下文融合；
2. 多意图拆分与多查询向量预筛；
3. 精确实体/词法锚点；
4. PEDSA 图扩散；
5. 图分、向量分、词法分、重要度与时间衰减混合；
6. POV/owner/区域等认知边界；
7. 可选交叉、共现、残差与 DPP 多样性；
8. 生成按排名排列的稳定 memoryId 候选。

这一步是起点，不是 Agent 能看到的上限。默认 packet candidate limit 为 36（内部安全上限 120）；最终注入上限仍由召回设置控制。

## 3. 未索引尾部

召回不等待 embedding 或向量修复。候选包额外扫描：

- `replayRequiredNodeIds`；
- `pendingRepairFromFloor` 之后的新记忆；
- backend/Authority 模式尚无 index mapping 的节点；
- 没有 embedding 的节点；
- 整个向量状态 dirty 但没有精确目标时的近期尾部。

这些节点按近期楼层、重要度和稳定 ID 排序，带具体 channel/reason 进入 packet。大部分用户使用外部向量时，直连 Embedding API 是默认；后端返回真实 score/similarity/distance 就采用真实相似度，只返回 rank 时明确把 rank 当降级信号。

## 4. Recall Agent 深查工具

Agent 先调用 `recall_context` 读取 user turn、候选包和 memory state fingerprint。信息不足时可调用：

| 工具 | 作用 |
| --- | --- |
| `recall_search` | 越过初始候选，在完整活动 objective / POV / derived 目录中搜索 |
| `recall_get` | 查看稳定 memoryId 的精确当前/历史 revision 与 evidence |
| `recall_neighbors` | 沿 durable relation 深查邻居 |
| `recall_publish` | 发布唯一的、经校验的 memoryId 列表；空数组也是成功 |

工具按需使用，没有“一定再查几次”的固定步骤。Agent 若认为候选已足够，可以一次发布；复杂语境可追踪实体、旧称、因果、视角差异或更远关系。

## 5. 发布边界

模型只能返回稳定 memoryId，不能直接生成注入事实。发布时 BME：

1. 重新加载 ledger 并确认 memory state 未改变；
2. 重验每个 ID 当前存在、活动、证据有效且通过认知边界；
3. 从当前 revision 构建 core/recall/summary buckets；
4. 由 `formatInjection()` 生成最终文本；
5. 把候选 IDs、选择 IDs、依赖 revision、输入/历史/记忆 fingerprint 和注入快照写成一个 Recall Artifact。

这样模型幻觉文本不会穿过 publish boundary 变成记忆或注入。Steward 恰好在召回期间提交导致语义状态变化时，Recall Agent refresh 后重新判断；不会把旧 ID 盲目套到新状态。

## 6. 降级与失败

- 程序候选构建失败时，使用近期活动记忆尾部构造 emergency packet；
- Agent 模型失败、超时或未调用 publish 时，用 packet 的确定性 baseline 发布 `programmatic-fallback` Artifact；
- 没有任何耐久记忆时发布 `empty`；
- BME 专用模型未配置会明确报错，不借用当前 SillyTavern 聊天模型或 DOA 模型。

降级仍然产生一个可复用 Artifact，因此同一回合不会因为 provider 抖动重复扣费。

## 7. 注入与 UI

最终结果按角色 POV、用户 POV、客观当前区域、客观全局和活跃总结分桶，并受最终节点上限控制。消息级 `message.extra.bme_recall` 保存 UI 所需快照；账本 Artifact 保存领域级可复用语义。召回卡片即使结果为空也存在，ENA 规划内容显示在独立 tab，不与召回注入揉在一起。
