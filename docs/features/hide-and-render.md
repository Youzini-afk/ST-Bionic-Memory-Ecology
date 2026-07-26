# 隐藏旧楼层与渲染限制

为了控制超长聊天的提示词成本，ST-BME 可以隐藏旧楼层、限制聊天区渲染。本文档说明这两个机制，以及它们与历史安全的关键交互。

实现：`ui/hide-engine.js`、`ui/message-render-limit.js`。

## 隐藏旧楼层

把久远的楼层对模型隐藏（不进提示词），靠记忆图谱替代它们提供长期上下文。这是 ST-BME 的核心价值之一：用结构化记忆替代原始历史。

隐藏由 `ui/hide-engine.js` 处理。被隐藏的楼层仍在聊天里，只是不发给模型。

## 渲染限制

`ui/message-render-limit.js` 限制聊天区实际渲染的消息数（`getMessageRenderLimitSettings` / `applyMessageRenderLimit`）。这是性能优化——DOM 里只保留最近 N 条。

## 关键交互：渲染切片 ≠ 历史删除

这是最重要的一点。渲染限制会让 `context.chat` 看起来"变短"，但这只是渲染切片，不是历史真的被删。

> ST-BME 必须区分"渲染切片"和"历史删除"。把渲染切片误当成历史变短，会触发破坏性历史恢复、误清空运行时图谱。

`getRenderLimitedHistoryRecoveryGuard`（在 `ui/message-render-limit.js`）提供这个保护：当检测到当前聊天可能只是渲染切片时，暂停破坏性恢复。详见 [`history-safety.md`](history-safety.md)。

## 边界

- 隐藏旧楼层、渲染限制、总结折叠能降低成本，但不能消除所有开销——超长聊天仍有成本。
- 旧楼层隐藏后若模型仍看到太多内容，检查隐藏设置和渲染限制是否生效。
