# 历史安全：恢复、渲染保护、Restore Lock

ST-BME 的记忆图谱依赖"楼层 → 已提取"的映射。但宿主聊天历史会被各种操作扰动：编辑、删除、swipe、reroll、只渲染最近 N 条、切换聊天。本文档说明保护机制，确保这些扰动不会误清空或错误覆盖记忆。

实现散布在 `maintenance/chat-history.js`、`maintenance/reroll-recovery-controller.js`、`index.js` 的历史检测路径，以及 [`../architecture/control-plane.md`](../architecture/control-plane.md) 描述的身份/持久化控制平面。

## 楼层指针与图谱一起提交

自动或手动提取先在当前图谱的 detached 副本上完成节点、边和同步维护。processed floor、消息 hash、`extractionCount` 与 batch journal 也只写入待提交快照；主存储返回 `accepted` 后，整张快照才一次性发布到当前聊天。

因此，持久化失败或进入 pending 时，当前会话中的节点、processed floor/hash、journal 和计数都保持在上一个已确认版本。待提交快照按聊天身份保存在恢复材料中；重试只使用该聊天的快照，切换到别的聊天后不会借用新聊天的运行图谱，也不会把晚到结果发布过去。

## 历史变动恢复

已处理前缀为每个消息记录提取相关投影：user/system/assistant 角色、正文、说话者与当前 swipe。BME 自己管理的隐藏标记不会把同一条 assistant 误判成 system；真实角色、正文、说话者或 swipe 改变则会标脏。

宿主的删除、编辑和 swipe 事件到达时，聊天数组已经变化。编辑/swipe 的消息 id 和明确的删除序号元数据可直接定位；`MESSAGE_DELETED` 的普通 payload 只是删除后的新 `chat.length`，不能冒充中段删除起点，此时必须由逐消息 hash 找到第一处差异。事件路径会立即写入 durable dirty checkpoint，再等待宿主状态稳定后执行恢复；旧 hash 版本恰逢事件时不会把已经变化的聊天登记成新基线，而是从完整前缀保守恢复。

恢复顺序为：

```
检测历史变动
  → 优先反向应用受影响 batch journal
  → 从稳定聊天快照重放受影响后缀
  → journal 不足或恢复失败则从完整聊天全量重建
```

全量重建优先正确性，但较慢（消耗 LLM 调用）。`recoverHistoryIfNeeded` 是这条路径的核心编排（被抽到 `maintenance/reroll-recovery-controller.js`，是过去最难、最 bug 多的函数之一）。

## 渲染切片保护

SillyTavern 可能只在 DOM 里渲染最近 N 条消息（性能优化）。如果 ST-BME 把这个"渲染切片"误当成"完整聊天历史变短了"，就会错误地清空运行时图谱。

> 当 ST-BME 检测到当前 `context.chat` 很可能只是最近 N 条渲染切片时，暂停破坏性历史恢复，避免误清空。`inspectHistoryMutation()` 会跳过这类渲染切片误判。

详见 [`hide-and-render.md`](hide-and-render.md)。

## Restore Lock

恢复过程是异步的。如果恢复进行到一半，用户切了聊天或触发了图谱变更，就可能写坏数据。

> Restore Lock 在历史恢复期间阻断图谱变更操作。变更门禁（`ensureGraphMutationReady` / `getGraphMutationBlockReason`）会返回"已暂停：正在恢复"类的原因，而不是让变更穿透。

恢复开始时会冻结聊天快照与内容 fingerprint。每个异步向量、重放和持久化边界都同时校验聊天身份与 fingerprint：切到别的聊天，或仍在同一聊天但内容再次变化，都会 abort，恢复开始前的图谱并保留最早 dirty checkpoint，而不是发布基于移动历史的结果。

普通 swipe 会立即回滚旧 assistant 的图谱效果并重提。overswipe 产生的空 assistant 只是宿主等待新回复的占位：它先持久化 `awaiting-replacement` dirty checkpoint，不对空文本提取；新回复到达后再走同一套 journal 回滚与重放。父 user 楼层的 `bme_recall` 在该过程中保留，reroll 不重新运行 ENA。

## 与控制平面的关系

历史安全本质上是控制平面身份/持久化不变量的应用：

- 身份四通道分离确保恢复时不会把别的聊天身份当成当前聊天。
- 持久化 reducer 确保恢复期间的 pending/accepted 状态正确流转。
- recovery-only tier（shadow/metadata）不能推进确认状态，所以恢复用的临时数据不会被误当成"已安全落地"。

详见 [`../architecture/control-plane.md`](../architecture/control-plane.md)。

## 手动提取时的提示

手动触发提取时若恰逢历史恢复未完成，会提示"历史恢复暂停"——这是 Restore Lock 在起作用，等恢复完成即可。过去这里出现过"陈旧 pending 卡住"的 bug，已由持久化 reducer 的自动清除不变量修复。
