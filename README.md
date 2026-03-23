# ST-BME

> 面向 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的图谱记忆扩展。它把聊天过程转成结构化记忆图，再在生成前按场景召回并注入，服务于长对话、角色扮演、持续剧情和世界观管理。

## 项目概览

ST-BME 的全称是 **ST-Bionic-Memory-Ecology**。它不是一个独立的后端服务，也不是一个通用数据库，而是一个运行在 SillyTavern 第三方扩展体系内的前端记忆层。

它主要做两件事：

1. **写入**：从聊天内容中抽取结构化记忆，存入当前聊天对应的知识图谱。
2. **读取**：在下一次生成前，从图谱中找出与当前输入最相关的记忆，并把它们整理成适合模型理解的上下文片段。

项目目标不是替代大模型的原生上下文能力，而是为长期互动补上一层可累计、可更新、可压缩、可检索的外部记忆系统。

## 这个项目解决什么问题

在长期 RP 或持续陪伴式对话里，模型通常会遇到几类典型问题：

- 早期剧情、角色状态、地点细节很快被上下文窗口挤掉。
- 模型会记得“有这回事”，但不容易稳定地记住“谁在什么时候做了什么、现在又变成什么状态”。
- 角色状态和地点状态会随剧情变化，旧信息与新信息容易混杂。
- 世界规则、主线目标、前情提要常常需要持续注入，但又不能把所有历史全文塞回 prompt。

ST-BME 的思路是把“聊天历史”变成“图谱化记忆”：

- 事件、角色、地点、规则、主线、概要、反思都以节点表示。
- 节点之间通过关系边连接，形成可扩散的结构。
- 重要、常驻的信息直接进入 Core 注入。
- 与当前用户输入强相关的状态和补充记忆再走召回注入。

## 项目边界

当前实现很明确地有以下边界：

- **单聊天作用域**：每个聊天维护一份独立图谱，图状态挂在当前聊天 `chat_metadata` 下。
- **无独立数据库**：没有额外服务端存储层，所有持久化都依赖 SillyTavern 的聊天元数据保存机制。
- **LLM 与 Embedding 分离**：
  - 结构化提取、精确召回、压缩、进化、概要、反思都通过 ST 内部的 `sendOpenAIRequest('quiet', ...)` 调用聊天模型。
  - 向量检索依赖单独配置的 OpenAI 兼容 Embedding API。
- **图谱是工程化记忆，不是事实真相库**：它依赖 LLM 的结构化输出质量，因此仍然存在抽取偏差、更新遗漏、关系误判等风险。

## 运行依赖

| 依赖 | 是否必需 | 作用 |
| --- | --- | --- |
| SillyTavern 第三方扩展系统 | 必需 | 提供事件钩子、设置存储、聊天上下文、Prompt 注入接口 |
| 当前可用的聊天模型 | 必需 | 用于提取、精确召回、压缩、进化、概要、反思等所有 LLM 子任务 |
| OpenAI 兼容 Embedding API | 向量检索相关功能必需 | 用于节点 embedding、向量预筛、Mem0 风格近邻对照、记忆进化近邻搜索 |
| 当前聊天元数据 | 必需 | 存储图谱状态、最后处理楼层、最后召回结果 |

## 系统总览

```text
聊天消息
  ├─ assistant 回复完成后
  │   └─ ST-BME 提取未处理片段
  │      ├─ LLM 生成 create/update/delete 操作
  │      ├─ 执行图谱写入
  │      ├─ 生成缺失 embedding
  │      ├─ 可选执行进化 / 概要 / 反思 / 遗忘 / 压缩
  │      └─ 保存回 chat_metadata
  │
  └─ 下次生成前
      └─ ST-BME 检索当前图谱
         ├─ 可见性过滤
         ├─ 向量预筛
         ├─ 图扩散
         ├─ 混合评分
         ├─ 可选 LLM 精确召回
         ├─ 场景重构
         └─ 格式化为注入文本并送入 prompt
```

## 与 SillyTavern 的集成方式

ST-BME 的主入口在 [index.js](./index.js)。它不是轮询式工作的，而是绑定在 SillyTavern 的事件生命周期上：

| ST 事件 | 对应逻辑 | 作用 |
| --- | --- | --- |
| `CHAT_CHANGED` | `onChatChanged()` | 切换聊天时重新加载该聊天的图谱 |
| `GENERATION_AFTER_COMMANDS` | `runExtraction()` | assistant 回复完成后，处理尚未提取的内容 |
| `GENERATE_BEFORE_COMBINE_PROMPTS` | `runRecall()` | 下一轮生成前召回记忆并注入 |
| `MESSAGE_RECEIVED` | `onMessageReceived()` | 新消息到达时保存当前图状态 |

这意味着 ST-BME 的运行时机非常清楚：

- **写入发生在回复之后**，记录刚刚发生了什么。
- **读取发生在下一次生成之前**，决定接下来模型应该看见哪些记忆。

## 数据存储与持久化

图谱键名固定为 `st_bme_graph`，存储在当前聊天的 `chat_metadata` 中。

图状态的核心结构如下：

| 字段 | 含义 |
| --- | --- |
| `version` | 图数据版本号，当前实现为 v3 |
| `lastProcessedSeq` | 已处理到的聊天楼层索引 |
| `nodes` | 全部节点，包括活跃和归档节点 |
| `edges` | 全部关系边，包括失效边和历史边 |
| `lastRecallResult` | 最近一次召回选中的节点 ID 列表 |

图数据由 [graph.js](./graph.js) 管理，支持：

- 空图创建
- 节点/边增删改查
- 时序链表维护
- 时序边失效处理
- 版本迁移与兼容反序列化
- 导入导出

### 节点公共字段

所有节点都会带有一套统一元数据：

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `type` | 节点类型 |
| `level` | 压缩层级，原始节点为 0 |
| `parentId` / `childIds` | 压缩层级父子关系 |
| `seq` | 该节点对应的主楼层索引 |
| `seqRange` | 节点覆盖的楼层范围 |
| `archived` | 是否归档 |
| `fields` | 业务字段主体 |
| `embedding` | 向量表示 |
| `importance` | 重要性，范围 0-10 |
| `accessCount` | 被召回/注入的访问次数 |
| `lastAccessTime` | 最近被访问时间 |
| `createdTime` | 节点创建时间 |
| `prevId` / `nextId` | 同类型节点的时间链表 |
| `clusters` | 额外标签/聚类信息 |

### 边公共字段

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `fromId` / `toId` | 边起点和终点 |
| `relation` | 关系类型 |
| `strength` | 边强度，范围 0-1 |
| `edgeType` | 边类型标记，`255` 表示抑制边 |
| `createdTime` | 创建时间 |
| `validAt` | 生效时间 |
| `invalidAt` | 失效时间 |
| `expiredAt` | 系统标记过期时间 |

其中 `contradicts` 关系会被映射成抑制边，后续在扩散阶段会传递负能量。

## 默认 Schema

默认 Schema 定义在 [schema.js](./schema.js)。它不仅定义了字段，还定义了注入策略、更新策略和压缩策略。

| 类型 | 作用 | `alwaysInject` | `latestOnly` | 压缩 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `event` | 事件、动作、阶段推进 | 是 | 否 | 分层压缩 | 当前实现里属于 Core 常驻注入 |
| `character` | 角色状态快照 | 否 | 是 | 不压缩 | 同名 `create` 会转成 `update` |
| `location` | 地点状态快照 | 否 | 是 | 不压缩 | 同名 `create` 会转成 `update` |
| `rule` | 规则、约束、世界设定 | 是 | 否 | 不压缩 | 常驻注入 |
| `thread` | 主线或任务线 | 是 | 否 | 分层压缩 | 常驻注入 |
| `synopsis` | 全局前情提要 | 是 | 是 | 不压缩 | 只保留最新一条概要 |
| `reflection` | 高层反思与长期提示 | 否 | 否 | 分层压缩 | 通过召回进入上下文 |

### 关系类型

默认关系类型包括：

- `related`
- `involved_in`
- `occurred_at`
- `advances`
- `updates`
- `contradicts`
- `evolves`
- `temporal_update`

## 写入链路详解

写入逻辑主要集中在 [index.js](./index.js) 和 [extractor.js](./extractor.js)。

### 1. 提取触发条件

ST-BME 只统计 **assistant 消息** 来决定何时提取。

默认策略：

- `extractEvery = 1` 时，每 1 条 assistant 回复提取一次。
- `lastProcessedSeq` 记录的是聊天数组索引，因此它用的是“楼层”语义，而不是消息 ID。

如果开启 `enableSmartTrigger`，则会在普通频率判断外再做一次轻量触发评分。评分来源包括：

- 命中默认关键词
- 命中自定义正则
- 用户与助手多轮往返
- 感叹号/问号等情绪波动
- 疑似新实体/新地点

当评分达到阈值时，即使未到 `extractEvery`，也会直接处理所有待处理 assistant 楼层。

### 2. 提取上下文打包

真正送去提取的不是单条消息，而是一段上下文窗口。

当前实现会：

- 找到本批 assistant 楼层的起止索引 `startIdx` / `endIdx`
- 从 `startIdx - extractContextTurns * 2` 开始回溯
- 取到 `endIdx` 为止的非系统消息
- 用 `#楼层 [role]: content` 的形式拼成对话文本

这样做的目的，是让 LLM 在提取时看到足够的上下文因果关系，而不是孤立处理单条回复。

### 3. LLM 结构化提取

提取调用在 [llm.js](./llm.js) 中统一封装，要求模型返回严格 JSON，核心产物是：

```json
{
  "thought": "对这一批对话的理解",
  "operations": [
    {
      "action": "create",
      "type": "event",
      "fields": {
        "summary": "......"
      }
    }
  ]
}
```

当前默认提示词会约束模型：

- 支持的节点类型必须来自当前 Schema
- 每批对话最多创建 1 个事件节点
- 角色/地点优先更新已有同名节点，而不是无脑新建
- 关系类型必须来自允许列表
- `importance` 落在 1-10
- `summary` 应该是抽象摘要，而非原文复制

### 4. Mem0 风格精确对照

如果开启 `enablePreciseConflict` 且配置了 Embedding API，则在正式执行操作前，会先对所有 `create` 操作做近邻对照：

1. 对新事实文本生成 embedding。
2. 在已有活跃节点中搜最相似近邻。
3. 若最高相似度超过阈值，则调用 LLM 判断：
   - `add`
   - `update`
   - `skip`

这一步的目标是降低重复节点、弱冲突节点和应该被视作“状态更新”的伪新增节点。

### 5. 操作执行语义

#### `create`

- 正常创建新节点。
- 若类型是 `latestOnly` 且存在同名旧节点，则自动转为更新旧节点。
- 同批次创建的节点支持通过 `ref` / `targetRef` 建立链接。

#### `update`

更新的处理比普通字段覆盖更复杂，当前实现还会补出一层“可追踪更新语义”：

- 合并字段更新。
- 刷新 `seq` 与 `seqRange`。
- 清空 embedding，等待后续重建。
- 失效掉旧的 `updates` / `temporal_update` 关系边。
- 若存在 `sourceNodeId`，则补建新的 `temporal_update` 边。
- 根据字段差异自动生成一条新的 `event` 节点，摘要形如 `field: before -> after`。
- 再用 `updates` 边把这个事件挂回被更新节点。

这让“状态变化”不只是覆盖写入，还能留下被检索的更新痕迹。

#### `delete`

当前是**软删除**，不会真的移除节点，只是把节点标记为 `archived = true`。

### 6. Embedding 补齐

提取结束后，系统会为所有缺少 embedding 的活跃节点批量生成向量。拼接文本时优先使用：

- `summary`
- `name`
- `title`
- `traits`
- `state`
- `constraint`

如果这些字段都没有，就退化为节点类型名。

### 7. 提取后增强流程

在一次成功提取后，当前实现还可能继续执行以下步骤：

#### 记忆进化 `enableEvolution`

新节点写入后，[evolution.js](./evolution.js) 会：

1. 为新节点找近邻旧节点。
2. 调用 LLM 判断新信息是否改变了对旧记忆的理解。
3. 若需要：
   - 给新旧节点补链接
   - 回溯更新旧节点的 `state` / `summary` / `core_note`
   - 更新旧节点的 `clusters`
   - 记录 `_evolutionHistory`

#### 全局概要 `enableSynopsis`

每 `synopsisEveryN` 次提取后，会基于：

- 事件时间线
- 角色状态
- 主线状态

生成或更新一个 `synopsis` 节点，用于充当前情提要锚点。

#### 反思条目 `enableReflection`

每 `reflectEveryN` 次提取后，会基于：

- 最近事件
- 近期角色状态
- 当前主线
- 已知矛盾边

生成 `reflection` 节点，并用 `evolves` 边连接到最近事件。

#### 主动遗忘 `enableSleepCycle`

[compressor.js](./compressor.js) 中的 `sleepCycle()` 会按保留价值归档低价值节点。当前保留价值大致由以下因素决定：

- 重要性
- 新近性
- 访问频率

规则、概要、主线和高重要性节点默认不会被遗忘。

#### 层级压缩

对支持分层压缩的类型，系统会：

- 从最低层级开始扫描
- 只压缩超过阈值且不属于“最近保留叶子”的旧节点
- 以 `fanIn` 为批次调用 LLM 总结
- 新建更高层级节点
- 把被压缩子节点归档，并建立 `parentId` / `childIds`

当前默认支持分层压缩的类型是：

- `event`
- `thread`
- `reflection`

## 读取链路详解

读取逻辑主要集中在 [retriever.js](./retriever.js) 和 [injector.js](./injector.js)。

### 1. 活跃节点筛选

读取开始前会先获取当前图中的活跃节点，并过滤掉：

- `archived = true` 的节点
- `seqRange` 不完整的异常节点

如果启用了 `enableVisibility`，还会根据节点 `fields.visibility` 进行认知边界过滤：

- 支持数组形式
- 支持逗号分隔字符串
- 支持 `*` 通配
- 当前视角默认取 `context.name2`

### 2. 自适应检索策略

检索策略会根据活跃节点规模自动调整：

| 活跃节点数 | 检索策略 |
| --- | --- |
| `< 20` | 不做向量预筛，所有节点参与评分，可选直接走 LLM 精确召回 |
| `20 - 200` | 向量预筛 + 图扩散 + 混合评分，默认不走 LLM 精确召回 |
| `> 200` | 向量预筛 + 图扩散 + 混合评分 + LLM 精确召回 |

这套阈值定义在 [retriever.js](./retriever.js) 的 `STRATEGY_THRESHOLDS` 中。

### 3. 向量预筛

如果图规模达到阈值且配置了 Embedding API，会：

1. 对当前用户输入生成 query embedding。
2. 对已有节点 embedding 做暴力余弦相似度检索。
3. 取 Top-K 作为候选。

当前实现明确采用暴力搜索，而不是 HNSW/ANN，因为它假设 ST 使用场景通常是中小图规模。

### 4. 实体锚点与交叉检索

系统会额外从用户输入中做一层简单实体锚定：

- 如果消息里直接出现了某个节点的 `name` 或 `title`
- 就把它视为一个高能量种子

如果开启 `enableCrossRecall`，则会进一步：

- 沿着这些实体节点的有效边展开
- 找到相邻的 `event` 节点
- 把它们也作为附加扩散种子

这一步更偏向“场景联想”，而不是单纯语义相似。

### 5. 图扩散

[diffusion.js](./diffusion.js) 实现了一个轻量版 PEDSA 扩散引擎：

- 从种子节点出发传播能量
- 每步乘衰减因子
- 只保留 Top-K 活跃节点
- 抑制边会传递负能量
- 能量值会被钳位到固定区间

当前默认配置：

- 最多 2 步扩散
- 衰减系数 0.6
- 每步最多保留 100 个活跃节点

### 6. 混合评分

混合评分公式定义在 [dynamics.js](./dynamics.js)：

```text
FinalScore = (GraphScore * alpha + VectorScore * beta + ImportanceNorm * gamma) * TimeDecay
```

默认权重为：

- `graphWeight = 0.6`
- `vectorWeight = 0.3`
- `importanceWeight = 0.1`

时间衰减采用对数衰减，而不是快速指数衰减，目的是让久远但重要的记忆不要掉得太快。

### 7. LLM 精确召回

在小图或大图场景下，如果开启 `recallEnableLLM`，系统会：

1. 先把候选节点按混合得分排好。
2. 取前 30 个以内节点作为候选池。
3. 把最近对话、用户最新输入、候选节点字段摘要一起喂给 LLM。
4. 让 LLM 输出最终选中的节点 ID 列表。

如果 LLM 召回失败，则回退到纯评分排序结果。

### 8. 场景重构

在得到初始召回节点后，系统不会立刻结束，而是还会做一次“场景补全”：

- 若命中的是 `event`，会补入与该事件直接相关的角色、地点、主线、反思节点，以及时间上最邻近的事件。
- 若命中的是 `character` / `location`，会先找其关联事件，再围绕这些事件继续补场景。

这一步的目标，是避免只召回一个孤立节点，尽量把一个能被模型理解的局部情境一起带回来。

### 9. 概率触发回忆

如果开启 `enableProbRecall`，系统还会从未选中的高重要性节点里抽少量候选，并按概率追加进结果。这更像是“偶发闪回”，用于给长期剧情增加一点远程记忆回流。

### 10. 访问强化

被最终选中的节点会执行访问强化：

- `accessCount + 1`
- `importance + 0.1`
- 更新时间 `lastAccessTime`

这使得经常被召回、反复证明有用的节点，后续更容易继续存活和命中。

## 注入策略

注入文本由 [injector.js](./injector.js) 生成，格式是 Markdown 表格，主要分为两部分：

### 1. Core 常驻注入

凡是 Schema 中 `alwaysInject = true` 的类型，都会直接进入 Core：

- `event`
- `rule`
- `thread`
- `synopsis`

这意味着当前默认设计并不是“所有东西都走检索”，而是：

- **叙事主干**直接常驻
- **状态与补充记忆**按需召回

这是当前实现最值得注意的一个架构选择。

### 2. Recalled 召回注入

非 `alwaysInject` 且被选中的节点会进入召回区，并按桶组织：

- 当前状态记忆
- 情景事件记忆
- 反思与长期锚点
- 规则与约束
- 其他关联记忆

在默认 Schema 下，召回区最常见的其实是：

- `character`
- `location`
- `reflection`

因为事件、规则、主线、概要默认都属于 Core。

### 3. Token 估算

注入完成后，系统会做一个粗略 token 估算，便于观察注入体积。当前估算规则大致是：

- 2 个中文字符约等于 1 token
- 4 个英文字符约等于 1 token

## 一个完整运行示例

下面用一个简化示例说明从聊天到图谱、再到召回的大致闭环：

1. 用户说：“我们先去钟楼看看，之前失踪案很可能和那里有关。”
2. 助手回复了一段剧情，描述角色艾琳进入钟楼，发现地下暗门。
3. 这轮回复结束后，提取器可能产出：
   - 一个 `event`：艾琳在钟楼发现地下入口
   - 一个 `location`：钟楼，状态为存在隐藏入口
   - 一个 `thread`：失踪案调查，状态推进
4. 如果图中本来就有“钟楼”地点节点，则该地点不会重复创建，而会变成更新。
5. 新节点生成后，系统补 embedding，并可能触发：
   - 记忆进化：修正旧事件对钟楼的理解
   - 全局概要：更新前情提要
6. 下一轮用户问：“地下入口会不会和之前失踪的人有关？”
7. 召回阶段会：
   - 命中“地下入口”“失踪”等语义相关节点
   - 把钟楼、相关事件、最近主线等一起拉回
   - 再用注入表格告诉模型当前关键情境
8. 模型在生成时，就不只是看当前一句话，而是能同时看到：
   - 最近核心事件
   - 当前地点/角色状态
   - 当前主线和概要

## 功能清单与成熟度

### 已实现主链路

| 功能 | 当前状态 | 说明 |
| --- | --- | --- |
| 聊天级图谱持久化 | 已实现 | 图谱跟随当前聊天保存与切换 |
| LLM 结构化提取 | 已实现 | 支持 `create/update/delete` |
| 节点 embedding 生成 | 已实现 | 依赖外部 Embedding API |
| 向量预筛 | 已实现 | 余弦相似度暴力检索 |
| 图扩散排序 | 已实现 | PEDSA 风格轻量扩散 |
| 混合评分 | 已实现 | 图分、向量分、重要性、时间衰减 |
| LLM 精确召回 | 已实现 | 小图/大图场景触发 |
| 场景重构 | 已实现 | 围绕事件和实体补上下文 |
| 层级压缩 | 已实现 | 事件/主线/反思支持 |
| 记忆进化 | 已实现 | 基于近邻与 LLM 回溯更新 |
| 全局概要 | 已实现 | 周期生成 `synopsis` |
| 反思条目 | 已实现 | 周期生成 `reflection` |
| 主动遗忘 | 已实现 | 按保留价值归档 |
| 导入/导出 | 已实现 | 导出时去掉 embedding |

### 实验性能力

| 功能 | 当前状态 | 备注 |
| --- | --- | --- |
| 精确对照（Mem0 风格） | 实验性 | 对不同剧情密度的收益仍需更多验证 |
| 认知边界过滤 | 实验性 | 依赖节点 `visibility` 字段质量 |
| 交叉检索 | 实验性 | 更像场景增强，不一定总是增益 |
| 概率触发回忆 | 实验性 | 可能提升“闪回感”，也可能增加噪声 |
| 反思节点召回策略 | 实验性 | 当前以结构就绪为主，策略仍可细化 |

### 已有实现但未完全打通的预留项

下面这些字段或配置已经出现在代码中，但当前还不应在 README 中当作完整能力宣传：

| 项 | 当前情况 |
| --- | --- |
| `nodeTypeSchema` | 设置层支持，但当前没有现成 UI 做 Schema 编辑 |
| `extractPrompt` | 设置层支持，但当前没有现成 UI 暴露自定义提取提示词 |
| `injectPosition` / `injectRole` | 默认设置存在，但实际注入调用当前只使用 `injectDepth` |
| `evoConsolidateEvery` | 设置项存在，但当前没有真正的“进化后整理”执行逻辑 |
| `forceUpdate` | Schema 元数据存在，但当前运行期没有用它强制产出节点 |

## 配置说明

设置面板定义在 [settings.html](./settings.html)，逻辑绑定在 [index.js](./index.js)。

### 基础与召回配置

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `extractEvery` | `1` | 每 N 条 assistant 回复提取一次 |
| `extractContextTurns` | `2` | 提取时往前带多少轮上下文 |
| `recallEnabled` | `true` | 是否启用生成前记忆注入 |
| `recallTopK` | `15` | 评分后的候选上限 |
| `recallMaxNodes` | `8` | LLM 精确召回最多选多少节点 |
| `recallEnableLLM` | `true` | 是否启用 LLM 精确召回 |
| `injectDepth` | `4` | 注入深度 |

### 混合评分权重

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `graphWeight` | `0.6` | 图扩散得分权重 |
| `vectorWeight` | `0.3` | 向量相似度权重 |
| `importanceWeight` | `0.1` | 节点重要性权重 |

### v2 增强功能配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enableEvolution` | `true` | 开启记忆进化 |
| `evoNeighborCount` | `5` | 进化近邻搜索数量 |
| `enablePreciseConflict` | `true` | 开启精确对照 |
| `conflictThreshold` | `0.85` | 触发精确对照的相似度阈值 |
| `enableSynopsis` | `true` | 开启全局概要 |
| `synopsisEveryN` | `5` | 每 N 次提取更新概要 |
| `enableVisibility` | `false` | 开启认知边界过滤 |
| `enableCrossRecall` | `false` | 开启交叉检索 |
| `enableSmartTrigger` | `false` | 开启轻量触发提取 |
| `triggerPatterns` | `""` | 自定义关键词或正则 |
| `smartTriggerThreshold` | `2` | 智能触发阈值 |
| `enableSleepCycle` | `false` | 开启主动遗忘 |
| `forgetThreshold` | `0.5` | 节点保留价值阈值 |
| `sleepEveryN` | `10` | 每 N 次提取执行一次遗忘 |
| `enableProbRecall` | `false` | 开启概率回忆 |
| `probRecallChance` | `0.15` | 概率回忆触发概率 |
| `enableReflection` | `false` | 开启反思条目 |
| `reflectEveryN` | `10` | 每 N 次提取生成反思 |

### Embedding 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `embeddingApiUrl` | `""` | OpenAI 兼容 API 基地址 |
| `embeddingApiKey` | `""` | API Key |
| `embeddingModel` | `text-embedding-3-small` | embedding 模型名 |

## 推荐使用方式

### 起步建议

如果你是第一次用这个扩展，建议先用最保守的组合：

- 开启 `enabled`
- 保持 `extractEvery = 1`
- 开启 `recallEnabled`
- 开启 `recallEnableLLM`
- 开启 `enableEvolution`
- 开启 `enableSynopsis`
- 暂时关闭 `enableVisibility`、`enableCrossRecall`、`enableProbRecall`
- `enableReflection` 可以先关闭，等剧情稳定后再打开

### 成本敏感场景

如果更在意 API 成本，可以尝试：

- `extractEvery = 2` 或 `3`
- 关闭 `recallEnableLLM`
- 提高 `synopsisEveryN`
- 关闭 `enableReflection`
- 仅保留 Embedding 相关能力

### 长剧情 / 高连续性场景

如果是重剧情、重状态变化的 RP：

- 保留 `enableEvolution`
- 保留 `enableSynopsis`
- 在确认节点 `visibility` 字段可控后，再测试 `enableVisibility`
- 对多地点、多人物切换频繁的剧情，可逐步开启 `enableCrossRecall`

## 操作面板

当前 UI 已经提供以下手动操作：

| 按钮 | 作用 |
| --- | --- |
| 查看图谱 | 显示活跃/归档节点数、边数、类型分布、最后处理楼层 |
| 查看注入 | 直接查看最近一次生成前的注入文本 |
| 重建图谱 | 清空当前聊天图谱，下次生成重新抽取 |
| 手动压缩 | 对当前图谱执行压缩 |
| 导出 | 导出图谱 JSON，不包含 embedding |
| 导入 | 导入图谱 JSON，导入后会清空所有 embedding |
| 测试连接 | 测试 Embedding API 是否可用 |

## 目录与模块职责

| 文件 | 作用 |
| --- | --- |
| [manifest.json](./manifest.json) | 扩展清单 |
| [index.js](./index.js) | 扩展入口、事件绑定、设置管理、总流程调度 |
| [settings.html](./settings.html) | 设置面板 UI |
| [style.css](./style.css) | 扩展样式 |
| [graph.js](./graph.js) | 图数据结构、时序边、序列化、导入导出 |
| [schema.js](./schema.js) | 默认 Schema 与关系类型定义 |
| [extractor.js](./extractor.js) | 写入路径、精确对照、概要、反思 |
| [retriever.js](./retriever.js) | 读取路径、图扩散、混合评分、精确召回 |
| [injector.js](./injector.js) | 注入文本组织与格式化 |
| [embedding.js](./embedding.js) | Embedding API 调用、向量相似度检索 |
| [llm.js](./llm.js) | LLM 请求与 JSON 解析封装 |
| [diffusion.js](./diffusion.js) | PEDSA 风格扩散引擎 |
| [dynamics.js](./dynamics.js) | 时间衰减、访问强化、混合评分 |
| [compressor.js](./compressor.js) | 层级压缩与主动遗忘 |
| [evolution.js](./evolution.js) | 记忆进化引擎 |
| [tests/](./tests) | 当前已有的轻量本地测试 |

## 测试与验证

当前仓库内已有的测试比较轻量，主要覆盖部分核心逻辑：

```bash
node tests/smart-trigger.mjs
node tests/graph-retrieval.mjs
node tests/injector-format.mjs
```

它们分别验证：

- 智能触发评分逻辑
- 时序边过滤与图扩散基础行为
- 注入文本格式化流程

当前**尚未**覆盖的重点包括：

- 真实 LLM 提取质量
- 真实 Embedding API 行为
- 完整的 ST 生命周期集成
- 大图规模下的性能与稳定性
- 导入导出后的重建与回归

## 已知限制

截至当前代码实现，建议明确接受以下限制：

1. 这是一个**聊天内图谱**，不是跨聊天统一记忆库。
2. 导入图谱后，所有节点 embedding 会被清空；当前没有单独的“全量重建 embedding”按钮，向量能力需要后续写入或额外处理来逐步恢复。
3. LLM 子任务很多，结构化输出质量会直接影响图谱质量。
4. 当前没有内建图谱可视化界面，调试主要依赖统计信息、日志和注入文本。
5. 默认 `event` / `rule` / `thread` / `synopsis` 都是 Core 常驻注入，项目当前更偏向“主干常驻 + 状态召回”，而不是纯检索式记忆架构。
6. 实验性功能已经接入主流程，但仍缺少更系统的 benchmark 和回归验证。

## 设计来源与参考

ST-BME 不是这些项目的直接移植，而是结合 SillyTavern 扩展场景做的工程化整合。当前设计大致受以下项目启发：

| 参考项目 | 启发点 |
| --- | --- |
| `A-MEM` | 记忆进化、基于近邻的回溯修正 |
| `EM-LLM` | 惊奇度触发、段落边界与提取时机 |
| `Graphiti` | 时序边、关系有效性和图建模思路 |
| `Mem0` | 新旧记忆对照、增量更新决策 |
| `RoleRAG` | 认知边界过滤 |
| `AriGraph` | 沿图边展开的交叉检索 |
| `MemoRAG` | 全局概要作为长期锚点 |
| `SleepGate` | 主动遗忘与保留价值评估 |
| `Reflexion` | 反思条目方向 |
| `PeroCore` | 图扩散、记忆动力学、向量检索策略 |

## 当前版本

- 扩展版本：`0.1.0`
- 清单文件：[`manifest.json`](./manifest.json)

## 许可证

本项目采用 AFPL License，详见 [LICENSE](./LICENSE)。
