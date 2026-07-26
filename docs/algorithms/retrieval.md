# 检索 / 召回算法

读取链路的核心：在生成前，把与当前用户输入相关的记忆召回出来、注入提示词。这是一条多阶段混合管线，不是单一算法。

运行时入口是 `runRecallController()`（`retrieval/recall-controller.js`），核心检索是 `retrieve()`（`retrieval/retriever.js`）。

> 说明：`retriever.js` 头注释把它概括为"三层混合检索"，但实际管线阶段更多（下列）。本文档以代码实际行为为准。

## 管线阶段（按顺序）

```
1. 控制器门禁与输入选择      recall-controller.js
2. 可复用持久召回？命中则跳过 recall-controller.js
3. retrieve 选项映射          index.js: buildRecallRetrieveOptions
4. Authority 候选预筛（可选）  retriever.js
5. 向量预筛（多查询/多意图）   shared-ranking.js: rankNodesForTaskContext
6. 图扩散（PEDSA）            diffusion.js
7. 混合评分                   shared-ranking.js / retriever.js
8. 认知边界过滤               retriever.js
9. 交叉召回 / 共现 / 残差（可选）retriever.js / retrieval-enhancer.js
10. DPP 多样性候选池          retriever.js / retrieval-enhancer.js
11. LLM 精排（可选）          retriever.js: llmRecall
12. 访问强化 + 概率召回（可选）retriever.js / dynamics.js
13. 注入格式化                injector.js: formatInjection
```

## 1-2. 输入选择与持久复用

召回输入按优先级解析（`resolveRecallInputController`）：override → 待发送意图（send intent）→ 聊天尾部用户楼层 → 已发送用户 → 最新用户楼层。

控制器里的来源/类型判定保持为小型纯 helper：active input source、no-new-user generation type、可信 user-floor source、持久复用输入构造分别独立测试。它们只做字符串规范化和布尔判定，不调用 `retrieve()`、不写消息、也不触碰生成事务。

**持久召回复用有两条路径：**

1. **no-new-user 主路径**（`reapplyPersistedRecallBlock`）：reroll / swipe / regenerate / continue 由宿主 `type` 判定为 no-new-user 后，`GENERATION_AFTER_COMMANDS` 不计算召回；`GENERATE_BEFORE_COMBINE_PROMPTS` 直接读取父 user 楼层的 `message.extra.bme_recall`，校验绑定文本未过期后确定性重放注入块。命中后不会进入 transaction / `runRecall` / 新检索。
2. **compute fallback 内部复用**（`resolveReusablePersistedRecallRecord`）：当主路径没有可用记录（例如无记录或陈旧）而落回 `runRecallController()` 时，如果当前输入匹配某条已持久化的用户楼层召回记录，可在控制器内复用已存注入内容，跳过新检索，返回 `llm.status="persisted"`。

内部复用命中后，控制器只重写本次 effective recall input 的来源为 `persisted-user-floor`，并保留原 delivery mode / hook / source candidates 等上下文字段；真正注入、generation count bump、metadata save 仍由原路径执行。

fresh `normal` 发送仍走正常输入选择与召回计算路径；no-new-user 的父楼层绑定来自宿主生成上下文，而不是根据 textarea / send-intent 等输入源猜测（见 [`../architecture/control-plane.md`](../architecture/control-plane.md) 的 reroll 不变量）。

## 5. 向量预筛

`rankNodesForTaskContext()` 构建向量查询计划：

- **上下文查询融合**：当前用户文本与近期上下文融合成查询。
- **多意图拆分**（`enableMultiIntent`）：`splitIntentSegments()` 按中英文标点和连接词（`顺便|另外|还有|对了|然后|而且|并且|同时`）拆分当前用户文本，最多 `maxSegments=4` 段，每段最小长度 3。
- **多查询并发**：对各查询并发调用向量搜索，按 max score 合并命中。

## 6. 图扩散（PEDSA）

种子来自向量命中和精确实体锚点，在图上做扩散激活。详细公式、参数、衰减见 [`diffusion-and-dynamics.md`](diffusion-and-dynamics.md)。

## 7. 混合评分

融合图分、向量分、词法分、重要度，乘以时间衰减。公式与权重见 [`diffusion-and-dynamics.md`](diffusion-and-dynamics.md)。

## 8. 认知边界过滤

两套机制：

- **遗留可见性过滤**（`filterByVisibility`）：按角色名匹配 `fields.visibility`，仅当 `enableVisibility && visibilityFilter` 时启用。
- **认知记忆门**（`computeKnowledgeGateForNode`）：评分时计算节点对当前视角是否可见，不可见的节点跳过。

注入时也会对客观节点重新应用可见性（`buildScopedInjectionBuckets`）。

## 9. 可选增强

默认全部按需启用（注意：`enableCrossRecall` 在应用设置里默认**开**，其余增强项默认关，以代码为准）：

- **交叉召回**（`enableCrossRecall`）：精确实体锚点存在时，把相连的 `event` 邻居作为扩散种子加入（能量 `1.5 × edge.strength`）。范围比"双记忆交叉检索"窄，只走"精确锚点 → 相连事件邻居"。
- **共现增强**（`enableCooccurrenceBoost`）：用精确锚点和补充向量锚点构建共现索引，给图分加 bonus。
- **残差召回**（`enableResidualRecall`，需直连 embedding 模式）：NMF 新颖度分析 + 稀疏编码残差，找出向量空间里"被现有基底节点覆盖不到"的新颖节点。参数：`residualBasisMaxNodes=24`、`residualNmfTopics=15`、`residualNmfNoveltyThreshold=0.4`、`residualThreshold=0.3`、`residualTopK=5`。

## 10. DPP 多样性

`enableDiversitySampling`（默认开）用贪心 DPP（determinantal point process）从候选池里选出既相关又互相多样的节点，避免召回一堆近义节点。

- 候选池大小 = `min(scoredNodes, max(target, target × dppCandidateMultiplier))`，`dppCandidateMultiplier=3`。
- 候选数 ≤ target，或任一候选缺 embedding，则不应用。
- 贪心选择：质量项 `q_i = max(score, 1e-10)^dppQualityWeight`（默认 `dppQualityWeight=1.0`），迭代选最大对角值并做 Cholesky 式更新。

## 11. LLM 精排（可选）

`enableLLMRecall`（默认开）：把候选节点描述（短键、类型、scope、故事时间、认知模式、可见性、字段、分数）交给 LLM，期望返回 `selected_keys` / `active_owner_keys` / `active_owner_scores`。无效/空/失败时回退到 top 评分候选。

候选池大小 `llmCandidatePool=30`。

## 12. 访问强化与概率召回

- **访问强化**（`reinforceAccessBatch`）：被选中的节点 `accessCount += 1`、`importance += 0.1`（上限 10）、更新 `lastAccessTime`。见 [`diffusion-and-dynamics.md`](diffusion-and-dynamics.md)。
- **概率召回**（`enableProbRecall`，默认关）：在已选节点之外，从 `importance >= 6`、非 synopsis/rule 的活跃节点里按重要度取前 3，每个以 `probRecallChance`（夹在 `[0.01, 0.5]`）的概率额外纳入。

> 注意：没有"是否运行召回"的随机决策——召回是否运行只由确定性门禁决定（无图谱/未启用/空聊天/无用户输入/图谱不可读/历史恢复未就绪则跳过）。"概率"只作用于额外记忆的注入。

## 13. 注入格式化

`formatInjection()`（`injector.js`）把召回结果按以下顺序拼成提示词文本：

1. 活跃总结段（`[Summary - Active Frontier]`）
2. 分桶段（若有 scope buckets）：角色 POV / 用户 POV（带"非角色事实"警告）/ 客观当前区域 / 客观全局
3. 仅当没有分桶段时，回退到遗留段 `[Memory - Core]` / `[Memory - Recalled]`

表格按节点类型分组，单元格转义管道符、换行替空格、截断到 200 字符。最终注入顺序在 `buildResult()` 里按 `compareNodeRecallOrderWithContext()` 排序，全局客观桶上限 6，选中 ID 上限 `maxRecallNodes`（默认 8）。

## 关键默认参数

> 注意两套默认值的区别：下表"retrieve() 回退"是当调用方省略选项时 `retriever.js` 内部的兜底值；"应用设置"是 `runtime/settings-defaults.js` 里正常召回实际使用的默认，由 `index.js` 映射进 `retrieve()`。两者不同时，**正常召回看应用设置那一列**。

| 参数 | retrieve() 回退 | 应用设置（正常召回） | 含义 |
| --- | --- | --- | --- |
| topK | 20 | `recallTopK` 20 | 排序候选数 |
| maxRecallNodes | 8 | `recallMaxNodes` **12** | 最终注入节点上限 |
| diffusionTopK | 100 | 100 | 扩散保留节点数 |
| llmCandidatePool | 30 | 30 | LLM 精排候选池 |
| enableLLMRecall | true | true | LLM 精排 |
| enableVectorPrefilter | true | true | 向量预筛 |
| enableGraphDiffusion | true | true | 图扩散 |
| enableVisibility | （未设即关） | **true** | 可见性过滤 |
| enableCrossRecall | false | **true** | 交叉召回 |
| enableProbRecall | false | false | 概率召回 |
| enableDiversitySampling | true | true | DPP 多样性 |

> 所以正常召回的实际最终注入上限是 **12**（不是 8），且交叉召回和可见性过滤默认**开启**——除非用户改设置。
