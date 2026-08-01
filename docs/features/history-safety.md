# 历史安全：事务回滚、渲染保护、Restore Lock

ST-BME 的记忆图谱依赖"楼层 → 已提取"的映射。但宿主聊天历史会被各种操作扰动：编辑、删除、swipe、reroll、只渲染最近 N 条、切换聊天。本文档说明保护机制，确保这些扰动不会误清空或错误覆盖记忆。

实现散布在 `maintenance/chat-history.js`、`maintenance/reroll-recovery-controller.js`、`index.js` 的历史检测路径，以及 [`../architecture/control-plane.md`](../architecture/control-plane.md) 描述的身份/持久化控制平面。

## 楼层指针与图谱一起提交

自动或手动提取先在当前图谱的 detached 副本上完成节点、边和同步维护。processed floor、消息 hash、`extractionCount` 与 batch journal 也只写入待提交快照；主存储返回 `accepted` 后，整张快照才一次性发布到当前聊天。

因此，持久化失败或进入 pending 时，当前会话中的节点、processed floor/hash、journal 和计数都保持在上一个已确认版本。待提交快照按聊天身份保存在恢复材料中；重试只使用该聊天的快照，切换到别的聊天后不会借用新聊天的运行图谱，也不会把晚到结果发布过去。

## 历史变动回滚

已处理前缀为每个消息记录提取相关投影：user/system/assistant 角色、正文、说话者与当前 swipe。BME 自己管理的隐藏标记不会把同一条 assistant 误判成 system；真实角色、正文、说话者或 swipe 改变则会标脏。

宿主的删除、编辑和 swipe 事件到达时，聊天数组已经变化。编辑/swipe 的消息 id 和明确的删除序号元数据可直接定位；`MESSAGE_DELETED` 的普通 payload 只是删除后的新 `chat.length`，不能冒充中段删除起点，此时必须由逐消息身份记录找到第一处结构差异。事件路径会立即写入 durable dirty checkpoint，再等待宿主状态稳定后执行回滚；纯展示文本、图片和其他插件的后写入不自动触发重提取。

删除/结构变动事务只做回滚：

```
检测历史变动
  → 优先反向应用受影响 batch journal
  → journal 为旧格式时使用对应的 snapshotBefore
  → 持久化并一次性发布回滚后的稳定图谱
```

这条路径不调用 LLM、不重放后缀、不清理整个向量库，也不会在结束后自动唤醒提取。journal 覆盖不足时保留 dirty checkpoint 并停止，绝不因一次删楼自动全量重建。后续主动提取是另一笔独立事务。

连续楼层变动由单飞协调器合并：新变动提升目标 revision 并终止旧代，旧代完成补偿后必须继续处理最新 revision；召回只可等待同一条事务屏障，不能从未提交的图谱继续执行。

## 渲染切片保护

SillyTavern 可能只在 DOM 里渲染最近 N 条消息（性能优化）。如果 ST-BME 把这个"渲染切片"误当成"完整聊天历史变短了"，就会错误地清空运行时图谱。

> 当 ST-BME 检测到当前 `context.chat` 很可能只是最近 N 条渲染切片时，暂停破坏性历史恢复，避免误清空。`inspectHistoryMutation()` 会跳过这类渲染切片误判。

详见 [`hide-and-render.md`](hide-and-render.md)。

## Restore Lock

回滚持久化是异步的。如果进行到一半，用户切了聊天或再次触发楼层变更，就可能写坏数据。

> Restore Lock 在楼层回滚期间阻断图谱变更操作。变更门禁（`ensureGraphMutationReady` / `getGraphMutationBlockReason`）会返回暂停原因，而不是让变更穿透。

回滚开始时会冻结聊天快照与结构 fingerprint（消息 UID、swipe UID、角色和位置，不含正文及插件附件）。持久化前后都同时校验聊天身份、结构 fingerprint 和 AbortSignal：切到别的聊天，或仍在同一聊天但结构再次变化，都会 abort，补偿回滚开始前的图谱并保留最早 dirty checkpoint；图片/展示文本后写入不会反复重启回滚。Restore Lock 使用所有者 token；旧聊天晚到的 `finally` 不能释放新聊天的锁。

普通删除只回滚旧楼层的图谱效果。reroll/swipe 是单独的显式工作流：先提交回滚，再由新回复走其本来的提取流程。overswipe 的空 assistant 只持久化 `awaiting-replacement` checkpoint，不对空文本提取。父 user 楼层的 `bme_recall` 在该过程中保留，reroll 不重新运行 ENA。

## 与控制平面的关系

历史安全本质上是控制平面身份/持久化不变量的应用：

- 身份四通道分离确保恢复时不会把别的聊天身份当成当前聊天。
- 持久化 reducer 确保恢复期间的 pending/accepted 状态正确流转。
- recovery-only tier（shadow/metadata）不能推进确认状态，所以恢复用的临时数据不会被误当成"已安全落地"。

详见 [`../architecture/control-plane.md`](../architecture/control-plane.md)。

## 手动提取时的提示

手动触发提取时若恰逢楼层回滚未完成，会被 Restore Lock 暂停；回滚完成后再作为独立事务执行。召回同样遵守稳定读屏障，不会为了召回另起一轮回滚，也不会越过失败/待持久化的回滚状态。
