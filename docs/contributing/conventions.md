# 代码约定

本文档记录这次重构确立的核心模式和必须维持的约定。违反它们会重新引入已经被消灭的 bug 类。

## 注入式控制器模式

核心 bug 簇（身份、持久化、加载、向量、reroll）过去都从多个异步路径读写同一份模块级可变全局。修复方式是把"做决定"（控制平面）和"执行副作用"（数据平面）分开。

抽出的控制器/工厂模块遵循：

- **纯逻辑或注入式**：依赖通过 `runtime` 对象传入，不闭包 `index.js` 的模块级状态。
- **`index.js` 保留薄委托壳**：旧函数名保留为转发到 `*Impl(runtime, ...)` 的薄壳。这些壳是真实运行时调用点，**不是死代码，不要删**。
- **状态留在 index.js**：`currentGraph` / `graphPersistenceState` / `extractionCount` 等模块级状态留在 `index.js`，通过 accessor 注入。

## 关键陷阱：状态重新赋值

这是 Phase 5d 出过真实 bug 的地方，务必遵守。

`index.js` 的 `updateGraphPersistenceState()` 会**整个重新赋值** `graphPersistenceState` 对象（不是原地改属性）。所以：

> 控制器模块**不能**在函数入口 `const state = runtime.getGraphPersistenceState()` 捕获一次后反复读——任何 helper 调用（`updateGraphPersistenceState` / `queueGraphPersist` / `applyGraphLoadState`）之后，捕获的引用就陈旧了。

正确做法是用 live Proxy，每次属性访问都读活值：

```js
const graphPersistenceState = new Proxy({}, {
  get(_t, k) { return (runtime.getGraphPersistenceState?.() || {})[k]; },
  set(_t, k, v) { const s = runtime.getGraphPersistenceState?.() || {}; s[k] = v; return true; },
});
```

同理：`currentGraph` 在任何 `ensureCurrentGraphRuntimeState()` 调用后必须 `runtime.getCurrentGraph()` 重取，因为该调用可能替换图谱。

`index.js` 的 accessor 必须是 live 闭包：`getGraphPersistenceState: () => graphPersistenceState`，不能是快照。

## 依赖注入完整性

模块引用的每个 `runtime.X` 必须由对应 `create*Runtime()` builder 提供。`tests/runtime-deps-completeness.mjs` 自动校验。

- 新增 `runtime.X` 依赖 → 同步更新 builder。
- 禁止 `runtime[dynamicKey]` 计算属性访问（绕过静态检查，守卫会报错）。

详见 [`testing.md`](testing.md)。

## 不要切片 index.js

测试直接 `import` 真实模块，绝不 `readFile(index.js)` + 切片 + `vm.runInContext`。`tests/index-slicing-ratchet.mjs` 守这条线。详见 [`testing.md`](testing.md)。

## 必须维持的核心不变量

这些在 [`../architecture/control-plane.md`](../architecture/control-plane.md) 有完整说明，这里列出最易被无意破坏的：

1. **active identity 只来自宿主上下文**；graph-owner/queued/marker 身份只用于校验/恢复，绝不变成当前聊天。
2. **`已确认版本 >= 排队版本 && 同身份 && 规范 tier ⟹ pendingPersist === false`**——由纯规划器（`planAcceptedPendingClear` / `buildAcceptedPersistenceStatePatch`）加调用方身份门禁合成，不要在外面另起一套绕过它。
3. **recovery-only tier（shadow/metadata）永远不能推进确认状态。**
4. **reroll 复用召回时，被 reroll 助手楼层的图谱回滚必须保留**——召回复用和图谱回滚是两件事。
5. **向量空间不兼容时返回空向量结果回退图/词法召回**，绝不静默复用旧向量。
6. **快照顶层六键永不增减**；演进进 meta/state/记录字段；读取保留未知字段。

## 行为保留 vs 重构

纯重构（不改行为）不需要更新算法/功能文档。改了算法参数、不变量、功能边界时，更新 `docs/` 对应文档。

## 高风险改动

涉及 `loadGraphFromChat`、`recoverHistoryIfNeeded`、持久化路由这类高风险函数时，测试绿不等于行为保真——fallback/错误路径常常没被测试覆盖。这类改动应额外做控制流复核（历史上靠 @oracle 逐行复核抓到过测试漏掉的 blocker）。
