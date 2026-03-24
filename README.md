# ST-BME Memory Graph

> 面向 SillyTavern 第三方扩展体系的图谱记忆插件。  
> 它把聊天历史转换成结构化记忆图，在生成前按场景召回并注入，服务于长期 RP、持续剧情、角色状态维护和多轮世界观演化。

## 1. 项目定位

ST-BME 的核心目标不是“把所有聊天全文塞回上下文”，而是把对话中的长期信息拆成可维护、可更新、可压缩、可检索的记忆图。

当前版本坚持 3 个原则：

1. **不改酒馆本体**
   - 作为可发布的第三方扩展运行。
   - 不要求用户给 SillyTavern 打补丁。

2. **图谱真相源留在聊天元数据**
   - 图谱主体继续跟随当前聊天保存在 `chat_metadata.st_bme_graph`。
   - 不把图谱主数据迁移到独立数据库或服务器文件。

3. **向量与图谱解耦**
   - 图谱负责结构、时序、压缩、召回分层。
   - 向量只负责语义候选预筛，可以走后端索引，也可以走独立直连兜底。

---

## 2. 当前能力概览

### 2.1 写入能力

- assistant 回复后自动提取未处理楼层
- LLM 结构化输出 `create / update / delete`
- 支持事件、角色、地点、规则、主线、概要、反思节点
- 支持时序边、更新边、矛盾边
- 支持 Mem0 风格近邻对照，减少重复写入
- 支持 A-MEM 风格记忆进化
- 支持全局概要生成
- 支持反思条目生成
- 支持主动遗忘
- 支持层级压缩

### 2.2 读取能力

- 生成前自动召回记忆
- 向量预筛
- 图扩散
- 混合评分
- 可选 LLM 精确召回
- 场景重构
- 分桶注入：状态记忆 / 情景事件 / 反思锚点 / 规则约束

### 2.3 运维与安全能力

- 新聊天、分支聊天、切换聊天自动隔离
- 支持图谱导入导出
- 支持图谱全量重建
- 支持向量全量重建
- 支持向量范围重建
- 支持直连模式全量重嵌
- 支持历史回退检测与自动恢复

---

## 3. 系统架构

### 3.1 三层结构

ST-BME 当前可以理解成三层：

1. **图谱真相层**
   - 存储在当前聊天 `chat_metadata.st_bme_graph`
   - 保存节点、边、层级压缩关系、上次召回结果等

2. **运行时状态层**
   - 仍然跟随图谱一起保存在 `chat_metadata`
   - 保存历史处理指针、楼层 hash、脏区、向量索引映射、batch journal

3. **向量候选层**
   - `backend` 模式：使用酒馆现成 `/api/vector/*`
   - `direct` 模式：使用插件自己的 OpenAI-compatible Embedding 直连

### 3.2 为什么不把图谱挪到服务器

因为插件发布要求不能改 SillyTavern 本体，而当前插件最重要的“聊天作用域绑定、聊天分支隔离、导入导出图谱、随着聊天一起迁移”这几件事，天然都和 `chat_metadata` 更契合。

所以当前设计是：

- **图谱本体**：继续在 `chat_metadata`
- **插件设置**：保存到服务器文件 `st-bme-settings.json`
- **向量索引**：按模式选择后端索引或前端直连

---

## 4. 与 SillyTavern 的集成方式

主入口在 [index.js](./index.js)。

插件不是轮询式运行，而是挂在 SillyTavern 的事件周期上：

| ST 事件 | 插件逻辑 | 作用 |
| --- | --- | --- |
| `CHAT_CHANGED` | `onChatChanged()` | 切换聊天时重新加载该聊天图谱与运行时状态 |
| `GENERATION_AFTER_COMMANDS` | `runExtraction()` | assistant 回复后提取新记忆 |
| `GENERATE_BEFORE_COMBINE_PROMPTS` | `runRecall()` | 生成前召回并注入 |
| `MESSAGE_RECEIVED` | `onMessageReceived()` | 新消息到达时保存图状态 |
| `MESSAGE_DELETED` / `MESSAGE_EDITED` / `MESSAGE_SWIPED` / `MESSAGE_UPDATED` | 历史变动检测 | 触发“先止损，再恢复” |

这意味着：

- **写入发生在回复之后**
- **读取发生在下一轮生成之前**
- **删楼层、编辑、切 swipe** 会被当作历史变动，而不是简单忽略

---

## 5. 数据结构

### 5.1 图谱主键

图谱键名固定为：

```text
chat_metadata.st_bme_graph
```

### 5.2 图状态核心字段

| 字段 | 含义 |
| --- | --- |
| `version` | 图数据版本，当前为 v4 |
| `lastProcessedSeq` | 兼容字段，表示已处理到的 assistant 楼层 |
| `nodes` | 全部节点 |
| `edges` | 全部关系边 |
| `lastRecallResult` | 最近一次召回节点 ID |
| `historyState` | 历史处理与恢复状态 |
| `vectorIndexState` | 向量索引状态 |
| `batchJournal` | 批次恢复日志 |

### 5.3 historyState

| 字段 | 含义 |
| --- | --- |
| `chatId` | 当前聊天标识 |
| `lastProcessedAssistantFloor` | 已处理到的 assistant 楼层 |
| `processedMessageHashes` | 已处理区间的楼层 hash 快照 |
| `historyDirtyFrom` | 检测到历史变动后的最早脏楼层 |
| `lastMutationReason` | 最近一次脏化原因 |
| `lastRecoveryResult` | 最近一次恢复结果 |

### 5.4 vectorIndexState

| 字段 | 含义 |
| --- | --- |
| `mode` | `backend` 或 `direct` |
| `collectionId` | 当前聊天的向量集合 ID，固定为 `st-bme::<chatId>` |
| `source` | 当前向量源 |
| `modelScope` | 当前向量模型作用域签名 |
| `hashToNodeId` | 向量 hash -> 节点 ID 映射 |
| `nodeToHash` | 节点 ID -> 向量 hash 映射 |
| `dirty` | 当前向量索引是否待重建 |
| `lastSyncAt` | 上次同步时间 |
| `lastStats` | 向量状态统计 |
| `lastWarning` | 最近一次向量告警 |

### 5.5 batchJournal

每次写入批次都会记录恢复信息。它不是审计日志，而是为了在历史回退时执行“受影响后缀回滚 + 重放”。

当前 journal 包含：

- `processedRange`
- `createdNodeIds`
- `createdEdgeIds`
- `updatedNodeSnapshots`
- `archivedNodeSnapshots`
- `invalidatedEdgeSnapshots`
- `vectorHashesInserted`
- `postProcessArtifacts`
- `snapshotBefore`

其中 `postProcessArtifacts` 用于标记该批次是否额外触发了：

- `evolution`
- `synopsis`
- `reflection`
- `sleep`
- `compression`

---

## 6. 节点与关系

默认 Schema 定义在 [schema.js](./schema.js)。

### 6.1 节点类型

| 类型 | 用途 | 常驻注入 | 备注 |
| --- | --- | --- | --- |
| `event` | 事件、动作、剧情推进 | 是 | 支持层级压缩 |
| `character` | 角色状态 | 否 | 同名会优先 update |
| `location` | 地点状态 | 否 | 同名会优先 update |
| `rule` | 世界规则、约束 | 是 | 常驻注入 |
| `thread` | 主线/任务线 | 是 | 支持层级压缩 |
| `synopsis` | 全局前情提要 | 是 | 只保留最新 |
| `reflection` | 反思与长期锚点 | 否 | 支持层级压缩 |

### 6.2 关系类型

默认关系类型包括：

- `related`
- `involved_in`
- `occurred_at`
- `advances`
- `updates`
- `contradicts`
- `evolves`
- `temporal_update`

其中：

- `contradicts` 用于矛盾/冲突
- `updates` 与 `temporal_update` 用于状态更新和时序替代
- `evolves` 用于新信息影响旧记忆的理解

---

## 7. 写入流程

写入主流程分为 6 步。

### 7.1 触发

默认按 assistant 楼层触发：

- `extractEvery = 1`：每 1 条 assistant 回复提取一次
- 若启用 `enableSmartTrigger`，则可提前触发

### 7.2 上下文打包

插件不是只看一条回复，而是从本批次 assistant 楼层向前回看若干轮，把非系统消息整理成：

```text
#12 [user]: ...
#13 [assistant]: ...
```

### 7.3 结构化提取

提取器要求记忆 LLM 返回严格 JSON：

- `create`
- `update`
- `delete`

如果 LLM 返回非法 JSON，会自动重试。

### 7.4 精确对照

若向量配置可用，会对新建记忆做近邻对照：

- 完全重复：跳过
- 是旧记忆修正：转成 `update`
- 真正新信息：保留 `create`

### 7.5 图谱副作用

提取完成后，可能继续触发：

- 记忆进化
- 全局概要
- 反思条目
- 主动遗忘
- 层级压缩

### 7.6 写入日志与向量同步

批次完成后会：

1. 同步向量状态
2. 记录 `batchJournal`
3. 更新已处理楼层与楼层 hash
4. 保存回 `chat_metadata`

---

## 8. 读取流程

召回逻辑主要在 [retriever.js](./retriever.js)。

### 8.1 总体流程

```text
用户输入
  -> 向量候选预筛
  -> 图扩散
  -> 混合评分
  -> 可选 LLM 精排
  -> 场景重构
  -> 注入格式化
```

### 8.2 候选预筛

这里是本次版本最重要的变化之一：

- `backend` 模式：通过酒馆 `/api/vector/query`
- `direct` 模式：插件自己请求 Embedding API，再做余弦相似度

两种模式都会把结果统一成 `[{ nodeId, score }]`，后续流程不区分。

### 8.3 图扩散与混合评分

候选节点进入图扩散后，会结合：

- 图扩散能量
- 向量得分
- 节点重要性
- 时间衰减

最后得到综合排序。

### 8.4 注入格式

注入模块在 [injector.js](./injector.js)。

它会把结果分成：

- `Core` 常驻注入
- `Recalled` 动态召回注入

并进一步分桶为：

- 当前状态记忆
- 情景事件记忆
- 反思与长期锚点
- 规则与约束
- 其他关联记忆

---

## 9. 向量模式

当前版本支持两种 Embedding 工作模式。

### 9.1 backend 模式

适用场景：

- 希望尽量走酒馆后端
- 希望发布后少受浏览器跨域限制
- 向量 provider 在酒馆现成支持范围内

支持来源：

- `openai`
- `openrouter`
- `cohere`
- `mistral`
- `electronhub`
- `chutes`
- `nanogpt`
- `ollama`
- `llamacpp`
- `vllm`

实现方式：

- 使用酒馆 `/api/vector/insert`
- 使用酒馆 `/api/vector/query`
- 使用酒馆 `/api/vector/delete`
- 使用酒馆 `/api/vector/purge`

说明：

- `openai/openrouter/cohere/...` 这类 provider 依赖宿主已有 provider/secret 体系
- `ollama/llamacpp/vllm` 这类 provider 需要额外填写地址

### 9.2 direct 模式

适用场景：

- 你需要完全独立的第二 Embedding URL/Key/Model
- 目标服务不在酒馆现成 provider 边界内

实现方式：

- 插件直接请求你配置的 OpenAI-compatible `/embeddings`
- 节点 embedding 继续保存在图节点里

### 9.3 模式切换行为

切换以下任一项时，向量状态都会被标记为 `dirty`：

- `mode`
- `source`
- `model`
- `apiUrl`
- `autoSuffix`
- 导入图谱

之后：

- 召回前会自动修复索引
- 或者你也可以手动点击“重建向量”

---

## 10. 历史回退恢复

这是本版本与旧实现最大的行为升级之一。

### 10.1 旧问题

旧实现只能线性推进 `lastProcessedSeq`。  
一旦用户：

- 删除旧楼层
- 编辑旧楼层
- 切换 swipe

图谱和已处理指针就可能和真实聊天历史不一致。

### 10.2 新策略：先止损，再恢复

插件会在历史变动事件发生时：

1. 比对已处理楼层的消息 hash
2. 找出最早受影响楼层
3. 立刻清空旧注入、停止本轮继续推进
4. 记录 `historyDirtyFrom`
5. 在下一次提取或召回前自动恢复

### 10.3 恢复方式

优先策略：

- 从 `batchJournal` 找到受影响前的恢复点
- 回滚受影响后缀
- 删除对应向量 hash
- 从脏楼层重新提取和后处理

兜底策略：

- 如果 journal 缺失或损坏
- 直接按当前聊天全文重建图谱与向量索引

### 10.4 不是 Engram 式的“只对齐指针”

这里必须强调：

ST-BME 当前的恢复不是简单地把“上次提取楼层”对齐到当前楼层然后跳过。

因为 ST-BME 的写入副作用很多：

- 更新节点
- 压缩节点
- 概要
- 反思
- 进化
- 迁移边

所以必须做真正的“回滚 + 重放”，否则图谱会留下脏状态。

---

## 11. 面板与操作

图谱面板现在主要分 5 个区域：

- 总览
- 记忆浏览
- 注入预览
- 操作
- 配置

### 11.1 新增运行状态

总览页会显示：

- 当前聊天 `chatId`
- 历史状态
- 向量状态
- 最近恢复结果

### 11.2 手动操作

当前支持：

- 手动提取
- 手动压缩
- 执行遗忘
- 更新概要
- 导出图谱
- 导入图谱
- 重建图谱
- 强制进化
- 重建向量
- 范围重建
- 直连重嵌

说明：

- “重建图谱”会按当前聊天重放整个提取流程
- “重建向量”会重建当前聊天全部向量
- “范围重建”只重建与指定楼层范围相交的节点向量
- “直连重嵌”仅在 `direct` 模式下有意义

---

## 12. 设置说明

### 12.1 记忆 LLM

这套配置用于：

- 提取
- 精确召回
- 压缩
- 进化
- 概要
- 反思

实现方式：

- 留空：复用当前 SillyTavern 聊天模型
- 填写后：通过酒馆现成后端代理转发到你配置的 OpenAI-compatible 聊天接口

### 12.2 Embedding

当前设置项分成两组：

#### 后端模式相关

| 字段 | 作用 |
| --- | --- |
| `embeddingTransportMode` | `backend` / `direct` |
| `embeddingBackendSource` | 后端向量源 |
| `embeddingBackendModel` | 后端模型 |
| `embeddingBackendApiUrl` | 仅部分后端源需要 |
| `embeddingAutoSuffix` | 自动补全后缀 |

#### 直连模式相关

| 字段 | 作用 |
| --- | --- |
| `embeddingApiUrl` | 直连 Embedding API 地址 |
| `embeddingApiKey` | 直连 API Key |
| `embeddingModel` | 直连模型 |

---

## 13. 导入导出与兼容

### 13.1 导出

导出时会主动剥离：

- 节点 embedding
- 向量索引映射
- batch journal

这样导出的文件仍然是“轻量图谱文件”，而不是整段运行时缓存快照。

### 13.2 导入

导入后会：

- 保留图谱结构
- 清空节点 embedding
- 清空 batch journal
- 标记向量状态为 `dirty`

也就是说：

- 图谱可以立即查看
- 向量需要后续重建

### 13.3 旧图谱迁移

当前版本会把旧版图谱自动迁移到 v4，并补出：

- `historyState`
- `vectorIndexState`
- `batchJournal`

迁移后默认会提示需要重建向量运行时状态。

---

## 14. 文件结构

这里列出最重要的模块：

| 文件 | 作用 |
| --- | --- |
| [index.js](./index.js) | 主入口，事件绑定、主流程调度、历史恢复、向量同步 |
| [graph.js](./graph.js) | 图数据模型、序列化、版本迁移、导入导出 |
| [extractor.js](./extractor.js) | 结构化提取、冲突对照、概要、反思 |
| [retriever.js](./retriever.js) | 向量候选、图扩散、混合评分、LLM 精排 |
| [runtime-state.js](./runtime-state.js) | 历史 hash、dirty 标记、journal、恢复点定位 |
| [vector-index.js](./vector-index.js) | backend/direct 向量模式与索引同步 |
| [llm.js](./llm.js) | 记忆 LLM 封装，支持酒馆后端代理 |
| [embedding.js](./embedding.js) | 直连 Embedding API 封装 |
| [compressor.js](./compressor.js) | 层级压缩与主动遗忘 |
| [evolution.js](./evolution.js) | 记忆进化 |
| [panel.html](./panel.html) / [panel.js](./panel.js) | 记忆图谱操控面板 |

---

## 15. 已知边界

当前版本已经解决了“不能改酒馆本体”的发布问题，但仍有一些边界需要明确：

1. **backend Embedding 不是任意 URL/Key 全兼容**
   - 它只能落在酒馆现成 `/api/vector/*` 已支持的 provider 边界内。

2. **direct 模式仍然受浏览器环境限制**
   - 例如 CORS、Mixed Content、远程访问时 `127.0.0.1` 指向错误等。

3. **历史恢复正确性优先于性能**
   - 当 journal 不可用时，会退化为当前聊天全量重建。

4. **图谱仍然依赖 LLM 提取质量**
   - 结构化输出如果失真，图谱也会跟着失真。

---

## 16. 测试

当前仓库内已有并正在使用的检查包括：

```powershell
node --check index.js
node --check extractor.js
node --check retriever.js
node --check graph.js
node --check runtime-state.js
node --check vector-index.js
node --check panel.js
```

测试脚本：

```powershell
node tests/smart-trigger.mjs
node tests/graph-retrieval.mjs
node tests/injector-format.mjs
node tests/runtime-history.mjs
node tests/vector-config.mjs
```

其中新增测试覆盖了：

- 历史 hash 检测
- journal 恢复点定位
- 向量模式配置归一化
- backend/direct 基本配置校验

---

## 17. 适合的使用方式

如果你的目标是：

- 长期 RP
- 世界观持续累积
- 多角色状态维护
- 任务线/主线长期跟踪
- 对话发生删改时尽量不留下脏记忆

那么当前 ST-BME 已经比最早版本更适合作为“长期记忆图谱层”使用。

推荐默认用法：

1. 记忆 LLM：可独立配置，也可复用当前酒馆模型
2. 向量：优先 `backend`
3. 只有当你明确需要第二套完全独立 Embedding URL/Key/Model 时，再切到 `direct`

---

## 18. 总结

当前 ST-BME 已经不是“只会抽点节点再注入”的原型版本，而是一套更完整的插件内记忆层：

- 图谱仍然和聊天强绑定
- 发布形态仍然是纯第三方扩展
- 向量层支持后端索引优先
- 历史变动支持真正恢复，而不只是指针对齐
- UI 里可以直接看到当前聊天、向量和恢复状态

如果你希望它继续往更重型方向发展，下一步最自然的演进会是：

- 扩展更细的恢复测试
- 增加范围级重放面板
- 增加 provider 级能力说明与自动诊断
- 继续压缩 `batchJournal` 的体积成本
