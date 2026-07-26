# 历史安全：恢复、渲染保护、Restore Lock

ST-BME 的记忆图谱依赖"楼层 → 已提取"的映射。但宿主聊天历史会被各种操作扰动：编辑、删除、swipe、reroll、只渲染最近 N 条、切换聊天。本文档说明保护机制，确保这些扰动不会误清空或错误覆盖记忆。

实现散布在 `maintenance/chat-history.js`、`maintenance/reroll-recovery-controller.js`、`index.js` 的历史检测路径，以及 [`../architecture/control-plane.md`](../architecture/control-plane.md) 描述的身份/持久化控制平面。

## 历史变动恢复

当检测到聊天历史与图谱记录不一致（楼层被编辑/删除/重排），ST-BME 尝试恢复：

```
检测历史变动
  → 优先 replay（按日志重放增量变化）
  → replay 失败则全量重建（从聊天历史重新提取）
```

全量重建优先正确性，但较慢（消耗 LLM 调用）。`recoverHistoryIfNeeded` 是这条路径的核心编排（被抽到 `maintenance/reroll-recovery-controller.js`，是过去最难、最 bug 多的函数之一）。

## 渲染切片保护

SillyTavern 可能只在 DOM 里渲染最近 N 条消息（性能优化）。如果 ST-BME 把这个"渲染切片"误当成"完整聊天历史变短了"，就会错误地清空运行时图谱。

> 当 ST-BME 检测到当前 `context.chat` 很可能只是最近 N 条渲染切片时，暂停破坏性历史恢复，避免误清空。`inspectHistoryMutation()` 会跳过这类渲染切片误判。

详见 [`hide-and-render.md`](hide-and-render.md)。

## Restore Lock

恢复过程是异步的。如果恢复进行到一半，用户切了聊天或触发了图谱变更，就可能写坏数据。

> Restore Lock 在历史恢复期间阻断图谱变更操作。变更门禁（`ensureGraphMutationReady` / `getGraphMutationBlockReason`）会返回"已暂停：正在恢复"类的原因，而不是让变更穿透。

恢复过程中还会用 `assertRecoveryChatStillActive` 校验聊天没被切走——切走则抛 abort，安全中止，而不是把恢复结果写到错误的聊天上。

## 与控制平面的关系

历史安全本质上是控制平面身份/持久化不变量的应用：

- 身份四通道分离确保恢复时不会把别的聊天身份当成当前聊天。
- 持久化 reducer 确保恢复期间的 pending/accepted 状态正确流转。
- recovery-only tier（shadow/metadata）不能推进确认状态，所以恢复用的临时数据不会被误当成"已安全落地"。

详见 [`../architecture/control-plane.md`](../architecture/control-plane.md)。

## 手动提取时的提示

手动触发提取时若恰逢历史恢复未完成，会提示"历史恢复暂停"——这是 Restore Lock 在起作用，等恢复完成即可。过去这里出现过"陈旧 pending 卡住"的 bug，已由持久化 reducer 的自动清除不变量修复。
