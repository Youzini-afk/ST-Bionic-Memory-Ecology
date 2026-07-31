# 历史安全：证据版本、回退与分支

ST-BME 不再用“某个图谱批次大概来自哪些楼层”去逆向猜测回退。每张聊天记录有自己的 append-only 记忆账本；聊天楼层先成为不可变证据，记忆修订明确声明依赖哪些证据。删楼、编辑、swipe、reroll 和分支改变的是证据的有效性，图谱只是账本当前状态的投影。

实现核心位于 `domain/history-reconciliation.js`、`application/history-transaction-service.js`、`domain/memory-branch.js` 与 `application/memory-lifecycle-runtime.js`。完整领域契约见 [`../architecture/agent-memory-vnext.md`](../architecture/agent-memory-vnext.md)。

## 不可变 Turn Evidence

一次完整 user → assistant 回合会生成稳定 `turnId` 和 evidence record，记录：

- 所属 `chatId`；
- user / assistant 文本与版本指纹；
- 当时的宿主楼层 locator 与可用的稳定消息提示；
- 创建时间和来源 metadata。

楼层数组下标只用于定位，不是永久身份。BME 优先使用已绑定 turnId、宿主稳定提示和内容/上下文指纹来把新快照与旧 evidence 对齐。普通生成开始时尚无 assistant 楼层，BME 也能为 pending user turn 计算与回复落层后相同的 turnId，使 Recall Artifact、Planner Artifact 和随后写入的 evidence 落到同一回合。

旧图中无法对应到现存聊天楼层的节点会获得 `historyManaged:false` 的导入证据。这类数据不会因为下一次聊天协调就被误判为“楼层已删除”；用户可以随后让 Steward 修订或归档它。

## 完整快照协调

每次加载或历史变化后，BME 从完整的 `context.chat` 构造期望 evidence 集合，与账本一次协调：

```text
当前完整聊天快照
  → 复用仍匹配的 evidence identity
  → 为新增/改写回合追加新 evidence
  → 为已消失或被替换 evidence 追加 invalidated disposition
  → 为重新选中的旧 swipe evidence 追加 active disposition
  → 一次事务提交并重新物化记忆视图
```

旧 evidence 和旧记忆 revision 永不物理删除。物化器只选择证据仍有效、依赖仍成立的最新 revision，因此回退既可追溯，也不需要 LLM 重新“猜回”此前状态。

## 删除、编辑、swipe 与 reroll

- **删除**：消失回合的 evidence 失效；只依赖它的记忆 revision 自动退出当前视图。
- **编辑**：旧文本 evidence 失效，新文本成为新 evidence；Steward 在后台处理需要怎样修订记忆。
- **swipe**：离开的 assistant 版本失效；若重新选回旧 swipe，原 evidence 被重新激活，而不是重新提取一份副本。
- **reroll / regenerate**：助手 evidence 走同样的版本切换，但父 user 的 Recall / Planner Artifact 按原输入版本精确复用，不重新运行 Recall Agent 或 ENA。
- **overswipe 空占位**：空 assistant 不成为有效 evidence；替换回复真正落层后再协调。

Recall Artifact 的 `empty` 也是成功状态。第一层没有可召回记忆时仍会持久化空 Artifact 并显示召回卡片；ENA 和 reroll 不会因此再触发一次召回。

## 聊天分支

分支拥有新的稳定 `chatId` 和 lineage。分支事务只复制 cutoff 之前仍有效的 evidence、memory/relation revision 与 Artifact，并为目标聊天生成新的 record identity。目标即使没有可复制内容也会写迁移标记，避免稍后把源聊天的兼容图谱当成旧数据重新导入。

Luker 分支会冻结 source / target chat-state target，在源账本完成一次迁移/协调后执行 fork，再把目标账本投影为分支图谱。任一 ledger 写入失败都会显式终止分支继承，不能用本地缓存冒充成功。

## 渲染切片保护

SillyTavern 可只加载/渲染最近 N 条消息。如果 BME 不能确认 `context.chat` 是完整历史，就不会把缺失前缀当成用户删除并执行破坏性 evidence 失效。关闭或调大“限制聊天区渲染楼层”后重新加载，可让很早的历史重新进入完整协调。

## 并发与晚到任务

- 同一聊天的写入由 coordinator 串行，不同聊天可以并行。
- Agent 在等待模型或工具时不持有写锁；提交前复核 ledger head、源 evidence 和所有读取依赖。
- 语义状态改变会要求 Agent 刷新并重规划；只追加 Inbox/Agent journal 的无语义提交可以安全 rebase。
- 任务开始时冻结 origin chat repository。切换聊天后，任务仍可完成原聊天的耐久提交，但不得更新新聊天的图谱、消息数组、提示词或 UI。

## 损坏与歧义策略

账本 head 缺失、commit 链断裂、同 record ID 内容冲突、无法合并的 Agent event fork 都会 fail closed。BME 不会为了“看起来恢复了”而覆盖未知状态。物理图谱缓存损坏时可以从账本重建；账本本身需要使用备份/修复入口处理。

当宿主没有任何稳定消息标识、且多个完整回合文本完全相同时，删除其中哪一份在信息论上不可判定。正常 SillyTavern 消息会提供稳定时间/消息提示；缺失这些提示的第三方宿主应补充稳定 identity，而不是依赖数组下标猜测。
