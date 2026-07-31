# 记忆写入：证据、Steward 与原子修订

生产写入不再是“每层固定调用客观提取，再调用主观提取，然后串行整合/总结”。助手回复先成为耐久证据与 Inbox 工作，后台 Memory Steward 根据语境自主决定需要哪些记忆操作。图谱是账本投影，不是 Agent 直接修改的事实源。

实现入口：`application/memory-lifecycle-runtime.js`、`application/memory-steward-service.js`、`agent/memory-steward-tools.js`、`domain/memory-changeset.js`、`domain/history-reconciliation.js`。

## 1. 证据接纳

`buildConversationEvidenceSnapshot()` 从完整聊天构造规范化回合：

- 过滤 `think` / `analysis` / `reasoning` 等不应成为剧情事实的内容；
- 记录 user / assistant 正文、楼层 locator、说话者和宿主可用的稳定消息提示；
- 为尚未产生 assistant 回复的 user turn 和最终完整回合生成一致的稳定 turn identity；
- 生成 history fingerprint，防止同一聊天在异步边界内变化而仍被当作旧输入。

`HistoryTransactionService` 将快照与当前 ledger 对齐，在一次事务中追加新 evidence、失效已经删除/替换的 evidence，并重新激活重新选中的 swipe evidence。已有 record 从不改写。

## 2. 耐久 Inbox 与后台执行

新增或变化的 evidence 会形成按聊天隔离的 Inbox revision。Inbox 先提交，随后才唤醒 Steward，因此刷新页面、模型失败或聊天切换不会把工作丢掉。

同一聊天当前可运行的 Inbox 项会被原子 claim 成一次 assignment。Steward 在等待模型或工具时不持有写锁；不同聊天可以并行。用户发起的“重新提取”“压缩”“进化”“总结”等动作同样只追加一条带 intent/payload 的 Inbox 请求，不启动第二个旧写入器。

## 3. Steward 可见上下文

Agent 从 `memory_task_context` 开始，得到本次 evidence、Inbox 意图、当前目录摘要与状态 fingerprint。需要更多信息时可自主调用：

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 按文本、类型、层级、owner 等检索完整活动记忆目录 |
| `memory_get` | 查看稳定 memoryId 对应的当前/历史 revision 与证据 |
| `memory_neighbors` | 沿耐久 relation 查询相邻记忆 |
| `memory_evidence` | 分页读取本任务及相关原始回合证据 |
| `memory_stage_changes` | 替换当前暂存的原子 Change Set |
| `memory_validate_changes` | 用最新账本校验暂存修订 |
| `memory_commit_changes` | 一次发布整个 Change Set |
| `memory_complete_without_changes` | 明确记录本批无需改动 |

程序没有用关键词或阈值预先限定“这一层只能去重”或“这次必须总结”。Agent 可以在同一语境中查看旧事实、POV、关系与原文后，决定创建、修订、整合、归档或 no-change。

## 4. Change Set

Steward 不直接 CRUD 图节点。`memory_stage_changes` 接收 `memory_revision` / `relation_revision` 操作，每项必须引用活动 evidence 或合法 dependency revision。Change Set 记录：

- `chatId`、task/idempotency key 与 base ledger revision；
- 本次读取过的 record IDs 和状态 fingerprint；
- source evidence IDs；
- 完整 operations 与原因。

校验会拒绝跨聊天引用、不存在/失效的 evidence、错误父 revision、关系端点缺失、非法状态以及重复/冲突 identity。

## 5. 提交、冲突与重规划

提交时重新加载最新 ledger：

- 只有 Inbox/Agent journal 之类不改变语义视图的无关提交可以 rebase；
- 读取过的记忆或源 evidence 已变化时，暂存 Change Set 被丢弃，Agent 必须 refresh、重新搜索并规划；
- 所有 records 与 commit 要么一次追加成功，要么一个都不生效；
- provider/tool 边界开始前先写 Agent event，中断的非幂等边界不会被自动重放。

默认防失控边界是单个后台任务 500 次工具调用、8 分钟，均可配置。没有 maxSteps、字符上限或强制阶段数；上下文按用户设置的模型 token 窗口总结压缩，完整 journal 仍保存在账本中。

## 6. 投影与向量

提交成功后，`projectMemoryLedgerToGraph()` 物化当前有效 memory/relation revision，并重建兼容节点、边、时间线、总结 frontier、认知归属与区域状态。未改变的 revision 保留访问统计和 embedding；修订或失效会标记对应向量 mapping dirty，由后台同步修复。

生成与召回不等待 Steward。任务未完成时读取上一个已提交 ledger；完成后下一次读取自然看到新 revision。后台状态有自己的 UI 通道，不延长前台召回/提取通知。

## 7. 旧图一次迁移

旧 graph 节点/边在确认其物理来源加载完成后，被转换为 evidence、memory revision、relation revision 和 migration marker，并在同一事务提交。来源尚在 loading 时不写 marker；转换成功后也不再运行第二套兼容写入器。无法匹配现存楼层的旧节点使用 `historyManaged:false` 合成证据，避免下一次协调误删。

`maintenance/extractor.js` 及旧后处理算法仍保留为迁移期代码和显式能力参考，但 SillyTavern 的生产消息事件不再把它们组成每层必跑的 live pipeline。
