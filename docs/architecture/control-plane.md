# 控制平面：身份、持久化、不变量

这是 ST-BME 最关键的一块。过去反复出现的 bug——"提取卡住"、"未进入聊天"、"reroll 乱召回"、"一致性审计永远说有漂移"——几乎全部源于这块的状态管理。本文档记录其结构和**必须维持的不变量**。

## 根本问题（历史背景）

早期实现里，**身份、持久化确认、加载状态、图谱可写性、向量脏标记、召回复用，全都从多个异步事件路径读写同一份模块级可变状态**（`currentGraph`、`graphPersistenceState`、pending 标志、commit marker）。

没有单一事实源，也没有把"做决定"和"写入"分开。每个修复都是在这些接缝上打补丁，于是每修一个就冒出下一个。

解决方向：把控制平面抽成**纯逻辑/注入式模块**，让整类 bug 在结构上不可能发生。

## 身份解析

聊天身份是一切持久化的主键。问题从来不是"chatId 这个键选错了"，而是"有好几个来源都自称是当前身份，还互相偷偷顶替"。

身份核心在 `runtime/identity-resolver.js`，把身份明确按**四类语义**区分对待，绝不互相顶替：

| 类别 | 含义 | 来源 |
| --- | --- | --- |
| **active / current identity** | 当前宿主活动聊天 | 只来自宿主上下文（context integrity / hostChatId 的已知别名 / hostChatId） |
| **graph-owner identity** | 图谱自带的所属身份 | 图谱 meta，只用于校验/恢复 |
| **queued identity** | 排队持久化的身份 | 持久化状态，只用于校验/恢复 |
| **marker identity** | commit marker 的身份 | commit marker，只用于校验/恢复 |

实现上：

- **active/current** 由独立入口 `resolveCurrentChatIdentityCore()` 解析，只认宿主上下文来源。
- **graph-owner** 由 `resolveGraphOwnerIdentityCore()` 解析。
- **queued / marker** 没有各自独立的解析入口——它们和 graph-owner 一起，在 `resolveRuntimeGraphFallbackIdentityCore()` / `resolvePersistenceChatIdCore()` 这类**恢复/兜底**聚合里被读取（含 `persistenceState.queuedPersistChatId` 和 `persistenceState.commitMarker.chatId`），并配合调用方的身份等值校验使用。

关键不在于"每类都有独立函数"，而在于**只有 active/current 这条通道能产出"当前聊天"，其余通道一律只进校验/恢复,不能升格为活动身份**。

**核心不变量：**

> active identity 只能来自宿主上下文。graph-owner / queued / marker 身份只能用于校验和恢复，**绝不能"偷偷"变成当前聊天**。

这正是"未进入聊天"那类 bug 的根：旧代码用一个"优先级抽奖"函数接受十几个竞争来源，结果某个非活动身份被当成了活动聊天。现在 active/current 有专门入口，恢复/兜底身份走单独的 fallback 聚合，不给"非活动身份污染活动身份"留口子。

> 身份是每次操作解析一次、显式传递的，不是从全局随用随取。

## 持久化确认状态机

持久化确认逻辑收敛在 `sync/persistence-reducer.js`，是**纯函数**：无 IO、无图谱变更、无 UI 副作用。

它把"这批记忆到底存好了没"变成关于 `(身份, 存储层 tier, 版本 revision, 证据)` 的纯计算。核心不变量：

```
已确认版本 >= 排队版本
  且 同一身份
  且 是规范 tier（canonical：authority-sql / indexeddb / opfs / luker-chat-state）
  ⟹ pendingPersist 必须为 false
```

> 实现说明：这条不变量**不是**某个单一 reducer 事件全包的。`reducePersistenceStatePatch()` 处理通用 `ACCEPTED` / `QUEUED` 事件；`buildAcceptedPersistenceStatePatch()` 在规范 tier 被接受时清 `pendingPersist`（但它本身不查排队版本/身份）；"陈旧 pending 自动清除"的规划逻辑在纯函数 `planAcceptedPendingClear()`（`sync/legacy-persistence-repair.js`，经 reducer re-export）；**身份等值校验在调用方**（`index.js` 接受路径）完成后才调用应用函数。所以这条不变量 = 纯规划器 + 调用方身份门禁的合成，而非单个事件转换。

**派生不变量：**

> recovery-only tier（`shadow` / `metadata-full` / `runtime-recovery` 等）永远不能推进确认状态。它们只用于灾难恢复，不能被当作"数据已安全落地"的证据。

> 当 `lastAcceptedRevision >= max(batchRevision, queuedPersistRevision)` 且排队聊天与当前聊天一致时，陈旧的 `pendingPersist` 标志自动清除。

这条解决了"SQL 已确认 rev=2、但 pendingPersist 赖着不走、把提取一直卡死"的 bug。reducer 让"陈旧 pending 卡住提取"在结构上不可能发生。

历史上的语义修复（Phase 2 引入不变量、Phase 5 把调用点改为显式事件）都保留在该文件头注释里。

## 图谱可写性门禁

`sync/graph-mutation-gate.js` 决定"现在能不能改图谱"，避免在加载中/恢复中/未进入聊天时误写。

关键判定（注入式 impl）：

- `ensureGraphMutationReady` — 操作前的总门禁
- `getGraphMutationBlockReason` — 给用户的暂停原因文案
- `assertRecoveryChatStillActive` — 异步恢复过程中，校验聊天没被切走（切走则抛 abort）
- `getGraphPersistenceLiveState` — 把内部状态投影成面板/调试可读形态

## 向量门禁与 reroll 代际上下文

- `vector/vector-gate.js` — 向量准备/修复前置门禁，决定 skip / repair / blocked / sync。
- `runtime/generation-context.js` — 记录宿主本轮生成的 `type`（`normal` / `swipe` / `regenerate` / `continue` 等），并解析本轮应绑定的父 user 楼层。
- `runtime/reroll-recall-input.js` — 基于代际上下文构造召回输入，并保存 planner recall handoff / plot record handoff；不再用一次性 marker 猜测 reroll。
- `retrieval/recall-controller.js` — 召回控制器；来源/类型/持久复用输入构造是纯 helper，检索执行和注入副作用仍留在控制器热路径里。

**reroll 不变量：**

> reroll 助手楼层时，若上方用户楼层未变且存在可复用的持久召回记录，则复用父 user 楼层 `message.extra.bme_recall` 中的注入块；但被 reroll 的助手楼层的**图谱回滚必须保留**（走既有 `onReroll` 路径）。

换句话说：召回注入可以复用，但图谱状态该回滚还得回滚。两者不能混为一谈——这是"reroll 乱召回"修复的核心。

设计纪律：**计算与注入解耦，信任宿主生成类型，不用输入源猜 reroll**。`GENERATION_STARTED` / `GENERATION_AFTER_COMMANDS` 传入的 `type` 是权威信号：`swipe`、`regenerate`、`continue` 属于 no-new-user 生成，优先绑定上方可见 user 楼层的持久召回；`normal` 才代表新输入，需要 fresh recall。`MESSAGE_DELETED` 在 regenerate 代际中只作为预期删除处理，不会擦掉本轮召回事务。

no-new-user 的稳定路径分两段：

1. `GENERATION_AFTER_COMMANDS` 不做召回计算，直接跳过并把工作推迟到 before-combine。
2. `GENERATE_BEFORE_COMBINE_PROMPTS` 先调用 `reapplyPersistedRecallBlock`，从父 user 楼层的 `message.extra.bme_recall` 确定性重放召回块；命中后立即返回，不进入 transaction / `runRecall`。若没有记录或记录已陈旧，再落回既有 transaction + compute 兼容路径。

旧的召回事务机制仍保留为 fresh normal 和 fallback compute 的基础设施；它不再是 reroll 已存召回注入的唯一门闸。

ENA Planner 另有一条 plot record handoff：它只负责把 planner 产出的剧情推进记录绑定到新 user 楼层的 `message.extra.st_bme_plot`，不参与召回决策。这样剧情历史持久化不依赖 planner recall 是否成功。

## 副本一致性模型

Authority 场景下有三处存储，它们**不是平级的版本副本**：

| 存储 | 角色 |
| --- | --- |
| Authority SQL | **规范主源**（canonical primary） |
| Blob checkpoint | 备份副本（backup replica） |
| Trivium | 搜索副本（search replica） |

**不变量：**

> 只有 Authority SQL 有可靠的图谱版本。当 SQL rev > Blob/Trivium rev 时，状态是"副本待同步"，**不是**"数据漂移"。SQL 领先时不建议从 checkpoint 恢复（那会用旧数据覆盖新数据）。

> checkpoint 生成时，若 SQL 是主存储层，必须以 Authority SQL 快照为源；SQL 导出失败/为空时，checkpoint 生成失败（`authority-sql-checkpoint-source-empty`），绝不回退到可能陈旧的运行时图谱。

> 副本同步动作（checkpoint 写入、Trivium/向量同步）相互独立执行，一个失败不阻塞其余。

## 依赖注入接缝

控制平面模块通过一个 `runtime` 对象拿到所有依赖，由 `index.js` 的 `create*Runtime()` builder 提供。这有个隐患：模块"期望"的 `runtime.X` 必须全部被 builder 提供，否则运行时（尤其 fallback 路径）才炸。

`tests/runtime-deps-completeness.mjs` 守住这条线。详见 [`../contributing/conventions.md`](../contributing/conventions.md) 和 [`../contributing/testing.md`](../contributing/testing.md)。
