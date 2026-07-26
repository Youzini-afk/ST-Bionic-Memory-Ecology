# 持久召回卡片

召回卡片是挂在聊天消息上的 UI 元素，显示"这条消息生成时召回了哪些记忆"。它既是用户可见的透明度功能，也是 reroll 复用的存储载体。

实现：`ui/recall-message-ui.js`、`ui/recall-message-ui-controller.js`、`retrieval/recall-persistence.js`。

## 做什么

每次生成前召回发生时，召回结果（选中的节点、注入文本、输入指纹）被持久化并绑定到对应的用户楼层，存放在该消息的 `message.extra.bme_recall`。卡片把这个记录渲染在消息旁，用户可以看到、展开、编辑。

## 为什么持久化

两个目的：

1. **透明度**：用户能看到记忆系统在每轮"想起了什么"。
2. **reroll 复用**：reroll 助手楼层时，如果上方用户楼层没变，before-combine 会把父 user 楼层 `message.extra.bme_recall` 中的召回块确定性重放，跳过新检索。详见 [`../architecture/control-plane.md`](../architecture/control-plane.md) 的 reroll 不变量和 [`../algorithms/retrieval.md`](../algorithms/retrieval.md) 的持久复用。

## 存储边界

召回卡片是**每个用户楼层可编辑的召回存储**，不是永久世界书条目。reroll 复用读取的是 `message.extra.bme_recall` 里的独立召回块，不会把内容写成长期 worldbook，也不会破坏性覆盖用户原文。

用户输入文本和召回注入块始终是两件事：用户楼层 `mes` 保留原始输入；召回内容作为单独 block 注入提示词。用户编辑召回卡片只改变该楼层的召回 artifact，不等同于改写用户说过的话。

如果面板图谱当前可见，召回记录还会驱动一次短暂的节点高亮，让用户看到本轮召回关联了哪些记忆节点。这个高亮只存在于渲染层；持久存储边界仍然是消息上的 `message.extra.bme_recall`。

## 控制器封装

`ui/recall-message-ui-controller.js` 是一个工厂，封装了卡片挂载/刷新所需的全部状态（定时器、MutationObserver、session、诊断 Map）。这是 VM 测试税重构的产物——这些有状态的 UI 逻辑从 `index.js` 抽出，状态不再泄漏到模块级全局。

## 边界

> 如果第三方主题移除了标准消息 DOM 或楼层索引属性，卡片可能跳过挂载。这是已知限制——卡片依赖宿主的消息 DOM 结构和楼层索引。

MutationObserver 用于在消息 DOM 变动时重新挂载卡片，节流处理避免频繁触发。
