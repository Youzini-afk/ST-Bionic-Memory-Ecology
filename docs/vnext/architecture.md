# ST-BME v9 架构基线

状态：Accepted

目标版本：9.0.0

范围：BME 浏览器扩展、BME 对 Authority 的接入层，以及二者之间的新数据协议。

## 1. 目标

v9 保留 BME 的产品能力，重写其有状态内核。重写首先解决以下问题：

- 持久化存在多个互相竞争的事实源；
- 删除、编辑、swipe 和 reroll 后，图谱与楼层历史不能可靠对应；
- reroll 有时重新召回，有时错误继承临时生成状态；
- 提取、维护、向量同步和 UI 可以绕过共同事务边界；
- 异步任务完成时可能已经切换聊天，却仍读取或写入“当前”全局状态；
- ENA、普通召回与 reroll 的生命周期被临时 handoff 和 TTL 状态缠绕。

v9 不是缩减版 BME。提取、图关系、维护、检索、向量、任务预设、ENA 和可视化仍属于产品范围；但只有完成新事务接入的功能才允许进入新入口。

## 2. Clean break

v9 不实现旧运行时兼容：

- 不读取、不迁移旧 graph snapshot、settings 或 chat metadata；
- 不读取 `message.extra.bme_recall` 或 `message.extra.st_bme_plot`；
- 不保留 IndexedDB/OPFS/Luker/metadata/shadow 之间的双读、双写或 fallback；
- 不保留旧内部 API、旧模块协议或旧 feature flag；
- 使用全新的 IndexedDB、Authority SQL 与向量集合 namespace；
- 旧数据不自动删除，但新运行时永远不访问它；
- 若未来需要抢救旧数据，只能提供与运行时分离的一次性离线工具。

## 3. 事实源

系统只承认三类事实，并禁止互相越权：

1. ST 当前聊天快照是聊天内容的事实源。
2. 当前显式选择的 BME Primary 是图谱、事务、召回和规划记录的唯一持久事实源。
3. 向量索引、UI 状态和诊断数据都是可重建派生物。

Primary 是安装级选择：`indexeddb` 或 `authority`。运行时不得自动切换、双写或以其他副本推进持久化 revision。Primary 不可用时，BME 写能力进入 blocked 状态，ST 聊天仍可继续。

## 4. 运行时边界

新运行时只保留四个逻辑边界：

### 4.1 HostAdapter

- 每次事件处理时重新读取 ST context；
- 将宿主事件转换为不可变的聊天或生成快照；
- `chatId` 只是由角色/群组与聊天文件名组成的宿主 locator，不得直接充当持久化主键；
- `chatKey` 是写入当前聊天 metadata 的 BME 随机身份；普通重命名保留该身份，分支、checkpoint 和仍保留源文件的副本必须获得新身份；
- 以 ST 提供的 generation type 判定 `fresh`、`no-new-user` 或 `skip`；
- 不保存业务状态，不把 ST 的聊天保存动作当作 BME 持久化确认。

### 4.2 ConversationEngine

- 按聊天串行化领域命令；
- 协调历史、生成、召回、提取和维护生命周期；
- 为每个任务固定 `chatKey`、`sessionEpoch`、`baseRevision` 和 `basisHistoryHash`；
- prompt/UI 副作用必须仍属于活动 session；
- 持久写入永远使用任务捕获的 `chatKey`，不得在完成时重新查询“当前聊天”。

### 4.3 Domain planners

提取、整合、压缩、遗忘、摘要、反思等领域逻辑只读取快照并返回 `ChangeSet`。它们不得直接修改共享 graph、调用存储或操作 UI。

### 4.4 StateStore

StateStore 接受可序列化的领域提交命令，在一个事务中校验 revision、应用 ChangeSet、追加事务日志、更新历史位置并写入派生索引任务。

IndexedDB 与 Authority 是这同一语义的两个实现，而不是两个同时工作的事实源。

## 5. 持久模型

### 5.1 ConversationHead

```js
{
  chatKey,
  revision,
  graphRevision,
  processedThrough,
  history: [{ messageHash, prefixHash }],
  updatedAt,
}
```

`history` 记录最后一次已协调的完整语义历史；`processedThrough` 记录已经产生有效领域事务的最后消息位置。

### 5.2 Graph records

节点、边和少量 graph runtime record 使用规范化记录存储。大图提交不得每次复制完整 JSON snapshot。

Embedding 连同 provider/model/dimension/space 标识保存在 Primary，因此外部向量索引可以完全重建。

### 5.3 ChangeSet

所有可持久变更使用一种记录形状：

```js
{
  changes: [
    { collection: 'nodes', id: '...', before: null, after: { /* ... */ } },
    { collection: 'edges', id: '...', before: { /* ... */ }, after: null },
  ],
}
```

`before` 和 `after` 都是完整、可结构化克隆的单条记录；`null` 表示不存在。ChangeSet 必须满足：

- 同一 collection/id 在一个 ChangeSet 中最多出现一次；
- `before` 必须与 base revision 中的记录一致；
- forward 应用 `after`，rollback 应用 `before`；
- 应用 forward 后再 rollback 必须恢复逐记录相等的状态。

### 5.4 TurnTransaction

```js
{
  id,
  chatKey,
  baseRevision,
  committedRevision,
  operation,
  basisHistoryLength,
  basisHistoryHash,
  processedThroughBefore,
  processedThroughAfter,
  changes,
  createdAt,
}
```

提取及其后的每次维护操作都产生独立事务，并按 revision 形成单一依赖链。任一事务基线失效时，该事务及所有更晚事务必须倒序回滚。

### 5.5 RecallRecord

```js
{
  turnKey,
  chatKey,
  boundUserMessageHash,
  historyPrefixHash,
  recallInput,
  selectedNodeIds,
  injectionText,
  tokenEstimate,
  graphRevision,
  createdAt,
  updatedAt,
}
```

`turnKey` 由 `chatKey + 父 user 楼层的 historyPrefixHash` 得出。记录保存最终注入文本，而不是只保存节点 ID；reroll 因而可以逐字重放原始上下文。

RecallRecord 的有效性只由 chat、父 user 历史前缀和绑定消息指纹决定。普通 reroll 不因当前设置、时间或临时生成状态而重新计算。

### 5.6 PlannerRecord

PlannerRecord 仅在 ENA 实际运行并产生规划时存在：

```js
{
  turnKey,
  chatKey,
  boundUserMessageHash,
  historyPrefixHash,
  rawUserInput,
  augmentedUserMessage,
  plotText,
  plotBlocks,
  promptProfileId,
  recallTurnKey,
  createdAt,
}
```

PlannerRecord 用于以后显式 ENA 规划的剧情历史，不参与 reroll 决策，也不是常驻 `storyPlan` 状态。它用与 RecallRecord 相同的 user 楼层指纹规则独立校验；`recallTurnKey` 只在本轮实际复用了非空 planner recall 时填写。

### 5.7 VectorJob

图谱事务在同一 Primary 事务内写入幂等 VectorJob。向量 worker 只能消费已提交 revision，并以 transaction ID 去重。索引结果返回后仍须依据当前 graph record 过滤。

## 6. 历史身份与协调

消息指纹包含：角色、说话者、语义文本和影响语义的 system 标志。它排除时间戳、DOM 状态、生成耗时、swipe 编号和其他 UI metadata。

每条消息同时形成链式 `prefixHash`。历史协调过程为：

1. 从 HostAdapter 获取当前聊天快照；
2. 与 ConversationHead.history 计算最长公共前缀；
3. 找出第一条其历史基线不再匹配的 TurnTransaction；
4. 将该事务及其后所有事务按 committedRevision 倒序应用 `before`；
5. 原子更新 graph、history、processedThrough、revision 和 VectorJob；
6. 从新的有效后缀继续提取。

删除未处理的尾部消息不触发图谱回滚。若已处理 assistant 消息内容变化，则公共前缀停在其父 user，旧 assistant 及其后的领域事务全部失效。

与失效 user 前缀绑定的 RecallRecord 和 PlannerRecord 失效；仍与公共前缀中父 user 匹配的 RecallRecord 必须保留。

## 7. 生成语义

### 7.1 普通新 user 生成

1. 捕获原始用户输入；
2. 协调当前历史；
3. 执行 fresh recall；
4. 用户楼层进入 chat 后，以实际消息前缀绑定 RecallRecord；
5. 注入 recall 文本；
6. assistant 完成后执行提取和维护；
7. 每个领域阶段通过 StateStore 原子提交。

### 7.2 swipe / regenerate / continue

这些 generation type 属于 `no-new-user`：

1. 不运行 ENA；
2. 先协调历史并回滚被替换 assistant 的领域事务；
3. 定位宿主 generation context 对应的父 user；
4. 校验并读取该 user 的 RecallRecord；
5. 逐字重放 `injectionText`，不进入 fresh recall；
6. 只有记录不存在或父 user 指纹不匹配时才重新召回；
7. 新 assistant 完成后重新提取。

召回复用与图谱回滚是两项独立义务，任何一项成功都不能跳过另一项。

## 8. ENA 语义

ENA 属于 BME，但它是默认关闭、由用户显式开启的发送前规划能力。

开启后的新 user 发送流程为：

1. 以原始用户输入执行 planner recall；
2. 构建角色卡、世界书、最近对话、历史 PlannerRecord 和记忆上下文；
3. planner LLM 产生并过滤 `<plot>` / `<note>` 等规划内容；
4. 将规划内容附加到真实用户输入并交给 ST；
5. 主生成复用 planner recall，避免对增强文本二次检索；
6. 用户楼层出现后，分别绑定 RecallRecord 和 PlannerRecord。

以下规则必须保持：

- ENA 关闭时绝不运行 planner；
- planner recall 使用原始输入；
- 只有非空 planner recall 才能阻止主生成 fresh recall；
- planner recall 失败不影响规划结果的持久化；
- 规划失败遵循明确的 fail-open 用户发送语义；
- PlannerRecord 与 RecallRecord 是独立记录；
- reroll 不运行或重放 ENA，只重放 RecallRecord；
- 附加到实际用户消息中的规划文本属于聊天语义历史。

规划完成到用户楼层建立之间只允许一个 session-scoped pending send；绑定完成或 session 变化后立即清除，不使用多个 TTL Map 猜测归属。

## 9. 异步隔离

每个异步任务持有不可变 lease：

```js
{ chatKey, sessionEpoch, baseRevision, basisHistoryHash }
```

- prompt、recall 和 ENA 的 UI/注入副作用要求 sessionEpoch 仍活动；
- 提取和维护只能向 lease.chatKey 提交，并必须通过 CAS 与历史基线校验；
- 任务不得在完成时调用 `getCurrentChatId()` 决定写入目标；
- 非当前聊天的成功提交不得更新当前 UI；
- 冲突结果必须丢弃或基于新快照重新规划，不能强行覆盖。

## 10. 向量一致性

向量索引不是事务主源，因此采用以下最小恢复模型：

- graph commit 与 VectorJob 同事务；
- worker 的 upsert/delete 幂等；
- rollback 产生对应的反向 job；
- Primary 记录索引已确认 revision；
- recall 不能信任高于或不属于当前 graph revision 的候选；
- 索引落后时允许等待、修复或回退非向量检索，但不能返回已失效节点。

## 11. Settings 与 UI

- 新 settings schema 从默认值开始，严格拒绝未知或无效值；
- ENA `enabled` 默认 `false`；
- 内部调度阈值不是用户设置，只有确有产品意义的参数进入 UI；
- Task profiles 保留为提取、维护、召回和 planner 的配置能力；
- UI 只读取 query model、发出 engine command，不直接接触 graph 或存储；
- Recall Card 与 Planner 历史从 Primary 查询，`message.extra` 不再承担存储；
- 可访问性和 reduced-motion 等既有用户体验约束必须保留。

## 12. Authority 边界

Authority 继续负责用户/扩展隔离、权限、SQL 和 Trivium 执行；BME 负责所有记忆与规划语义。

Authority Primary 使用与 IndexedDB 相同的提交契约和行为测试。优先使用 Authority 通用 SQL transaction；只有它无法表达 revision CAS 与原子批量变更时，才增加一个窄的 BME 服务端提交操作。Authority 不生成 embedding，也不理解 BME prompt、楼层或 ENA 语义。

## 13. 黑盒验收契约

以下场景必须同时覆盖纯内核、IndexedDB，并在 Authority 完成后复用同一套断言。

### A. 原子性与恢复

1. 在提交的任意持久写步骤注入失败，重载后只能看到完整旧 revision 或完整新 revision。
2. graph record 与 TurnTransaction 不得出现单边提交。
3. VectorJob 失败不回滚 canonical graph；重启后可继续处理。
4. revision 冲突不得覆盖胜出事务。

### B. 历史变化

1. 删除已处理尾层，graph 恢复到删除前一楼层的逐记录状态。
2. 删除或编辑中间楼层，撤销该楼层影响及所有后继事务，只重做后缀。
3. 编辑仅 UI metadata 不触发语义回滚。
4. 未处理尾层被删除时，不改变 graph revision。
5. 维护事务曾修改旧节点时，删除其历史基线仍能完整恢复旧值。

### C. reroll

1. swipe/regenerate/continue 不运行 ENA。
2. 父 user 未变时，selectedNodeIds 与 injectionText 和首次生成完全一致。
3. reroll 前先撤销旧 assistant 的提取和维护事务。
4. RecallRecord 缺失时允许 fresh fallback，并将新记录绑定到父 user。
5. 父 user 被编辑后禁止使用旧 RecallRecord。

### D. ENA

1. `enabled=false` 时发送点击和 Enter 都不运行 planner。
2. `enabled=true` 时只拦截新的非 trivial user 输入。
3. planner recall 使用 rawUserInput；主生成复用非空结果。
4. 空或失败的 planner recall 不阻止主生成 fresh recall。
5. planner recall 失败而 planner 成功时仍写 PlannerRecord。
6. PlannerRecord 只出现在实际运行过 ENA 的 user turn。
7. reroll 不创建、更新或读取 PlannerRecord 作为注入决策。

### E. 聊天隔离

1. A 聊天的任务在切到 B 后完成，永远不能写入 B。
2. A 的 prompt/UI 任务在 session 失效后不能产生副作用。
3. A 的后台领域结果只有在 A 的 revision 和 history basis 仍匹配时才能提交到 A。
4. 同一聊天两个并发写入只有一个 CAS 成功。

### F. 派生索引

1. rollback 完成、向量 delete 尚未处理时，recall 仍过滤失效节点。
2. 重放同一 VectorJob 不产生重复记录。
3. embedding space 改变后旧空间候选不得参与当前 recall。
4. 从 Primary 清空并重建索引后，候选集合与提交前一致。

### G. 隔离宿主验证

真实宿主测试只允许启动仓库内的 `C:\project\SillyTavern\SillyTavern`，使用独立端口、临时用户数据目录和测试专用浏览器状态。禁止连接或复用用户个人正在运行的 ST 实例。

## 14. 完成定义

v9 只有在以下条件同时满足时才能切换 manifest 入口：

- 所有保留功能已通过 ConversationEngine 和 StateStore，无直接写 graph/storage 的旁路；
- IndexedDB 与 Authority 通过共享契约测试；
- 本文黑盒场景全部通过；
- 使用隔离 ST 完成新消息、ENA、删除、编辑、swipe、regenerate、切换聊天和重启验收；
- 旧入口、旧存储路径、兼容层、迁移器及其实现耦合测试已删除；
- 新源码中不存在 legacy/fallback/shadow 双主逻辑。
