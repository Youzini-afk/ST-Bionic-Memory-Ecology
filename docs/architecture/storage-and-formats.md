# 存储分层与数据格式

ST-BME 的图谱数据可能存在多种位置，取决于宿主环境和服务器能力。本文档说明分层策略、快照契约，以及保证"以后改格式不用大迁移"的向前兼容纪律。

## 存储分层

领域主源不是图谱快照，而是每张聊天记录自己的 append-only memory ledger。下表描述 ledger 与其可重建图谱投影所在的物理层：

| 层 | 用途 | 说明 |
| --- | --- | --- |
| **Authority SQL** | 规范主源 | 有 st-doa/Authority 时的权威存储；唯一有可靠图谱版本 |
| **Luker chat-state** | 宿主当前聊天主存储 | Luker 宿主下作为当前聊天状态的主写入目标 |
| **IndexedDB** | 浏览器本地主存储 | 普通 SillyTavern 下的默认本地存储 |
| **OPFS** | 浏览器本地存储（替代） | Origin Private File System sidecar |
| **Blob checkpoint** | 备份副本 | Authority 场景的备份，非主源 |
| **Trivium** | 搜索副本 | 向量搜索存储，非主源 |
| **metadata-full / shadow / runtime-recovery** | 仅恢复用 | 灾难兜底，**永远不能**推进持久化确认状态 |

存储层的选择是能力探测驱动的，不需要用户手动配置。Authority 是增强层，缺席时优雅降级。详见 [`server-integration.md`](server-integration.md)。

**关键设计：** Luker 宿主下，浏览器全图镜像默认关闭（`cacheStorageTier = none`），避免把大图谱重复写进 IndexedDB/OPFS。只有用户显式"重建本地缓存"才写浏览器缓存。

### 单一耐久主源与账本提交

每次写入只选择一个耐久主源：Authority SQL、Luker chat-state、OPFS 或 IndexedDB。选定后，另一个存储层不能在主写失败时偷偷变成“已接受”的兜底；例如 Luker 主写失败时，本地缓存不能冒充成功，Authority 已接管后也不能回退到浏览器或 Luker。`metadata-full` 和 shadow 只能保存恢复材料。

一次领域提交把 evidence、disposition、memory/relation revision、Inbox/Agent event、Recall/Planner Artifact 与 commit 组成合法账本前缀。每条不可变 record 存在快照 `meta` 的独立嵌套键中，小型 head 指向最新 commit；物理 store CAS 与 ledger parent commit 都必须匹配。只有提交成功后才重建并发布图谱投影，失败时不会前移任一语义指针。

chat metadata 中的 commit marker 是主写成功后的恢复锚点，不属于底层事务本身，也不能代替主源的成功结果。异步 marker、pending retry 和副本任务都绑定发起时的聊天目标；切换聊天后可以继续完成原目标的耐久写，但不能把结果发布到新聊天。

Luker 使用独立的 `st_bme_memory_ledger_v1` chat-state namespace 与 revision updater。目标在任务开始时冻结；缺少 target、adapter 或 CAS 时直接失败，绝不把浏览器缓存冒充成功。

### Cloud Sync 副本协议

Cloud Sync 不参与上述主提交确认，只复制 IndexedDB / OPFS 本地主存储；Authority SQL 已是共享主源，不再套第二层 Cloud Sync。每次发布生成独立 publication id，并按稳定聊天身份维护一个远端 head 和该 publication 专属的不可变 chunk：先写完整 chunk，再覆盖稳定 head；发布前后都重新读取 head，能观察到的并发替换会使本次发布失败，本地 dirty 状态留待后续同步。一次发布只使用 Authority Blob 或 SillyTavern user-files 中的一个后端；从哪个后端读到 head，也只从该后端读取其 chunk，不能组合跨后端 manifest/chunk。

旧 head 不再引用的 publication 专属 chunk 会进入 head 内的 GC 账本，默认保留 24 小时。新 publication 永不复用旧 publication 的文件名，因此“复核 head 后、实际 delete 前”的竞争发布也不会重新引用被删文件。账本不截断；到期条目在后续上传或无变化的自动同步检查中删除，失败条目继续保留，成功/404 条目随下一次 head 成功发布退休。旧版没有 publication 隔离证据的 chunk 条目只保留、不由浏览器自动删除。chunk 已写而 head 发布失败时，失败路径会按已知文件名和实际写入后端尽力补偿；未能补偿的已知 chunk 会按聊天、head 文件名、publication 和后端记入浏览器本地主存储，后续成功发布先把它们并入远端 GC 账本，再按同一宽限和复核规则回收；这份本地恢复账本不会复制进图谱快照。

复制任务不能反向破坏本地主源。上传完成后的 revision 确认与 dirty 更新必须在本地主存储的同一事务/串行写锁内完成：若上传期间本地已前进，只确认实际上传的旧 revision，并继续保持 `syncDirty`。自动下载与 merge 在替换本地快照时使用同一事务/写锁内的 expected-revision 门禁；门禁失配说明本地刚有新提交，本次远端应用必须放弃。远端声明的 chatId 必须与当前聊天一致，不能先覆写身份再合并。

账本 metadata 不走普通“新字段覆盖旧字段”逻辑。若一端是另一端祖先，直接选择后代；真正分叉时按确定顺序重放兼容事务并重建一条合法 commit 链；同 ID 不同内容、同一 Agent run 的互斥事件链等无法证明安全的分歧会 fail closed。merge 从落本地的一刻起到远端发布成功前始终保持 dirty；发布失败或发布期间出现新本地提交，都不能把合并结果误标成已同步。

SillyTavern user-files 没有 list、条件写入或条件删除，因此未知历史孤儿不可安全枚举，跨设备竞争只能通过宽限期和操作前后的 head 校验收窄；远端语义是乐观的 last-writer-wins，不是线性事务。本设备能恢复的是自己持久登记的已知失败文件，不是任意远端孤儿。浏览器端删除只使用当前/旧稳定 head、其显式 chunk/GC 引用及本地已知失败账本作为证据，绝不按前缀推测删除。

## 图谱容器契约

为兼容现有 IndexedDB/OPFS/Cloud 协议，承载账本与图谱投影的物理快照顶层仍**冻结**为六个键（实现见 `sync/graph-snapshot-schema.js`）。ledger record/head 位于 `meta` 内，不新增第七个顶层键：

```
{
  schemaVersion,   // 顶层快照布局版本
  meta,            // 图谱元信息（含 meta.schemaVersion 等）
  nodes,
  edges,
  tombstones,
  state            // lastProcessedFloor / extractionCount 等运行状态
}
```

> **不变量：顶层这六个键永不增减。** 所有未来演进都放进 `meta` / `state` / 各记录字段里——这些层级已经容错（保留未知字段）。

## 向前兼容纪律

这是保证"ST-BME 以后不需要再做 v4/v5 大迁移"的核心机制。它**不是**一个信封框架或预留字段，而是一条解析纪律：

### 1. 宽容解析（保留未知嵌套字段）

> 读取方遇到不认识的**嵌套**字段（在 meta / state / 各记录里），必须保留、不报错、不丢弃。

具体现状：
- 节点 / 边 / tombstone 记录：整对象克隆，未知字段天然保留。
- `meta`：展开保留，已有 `meta.schemaVersion`。
- **顶层：冻结为六键，未知顶层键会被丢弃**——顶层是契约层，新增顶层键是契约违规（`normalizeGraphSnapshotShape` 只返回这六个键）。

> **所以演进规则是：永远不要新增顶层键；新字段一律放进 `meta` / `state` / 记录对象里，那里才保证 round-trip。**

原理：如果读取代码遇到不认识的嵌套字段就崩或就丢，那么**任何**字段改动都会逼出一次迁移；如果遇到不认识的嵌套字段就忽略并原样保留，那么以后所有改动都是**加法**，老版本读新数据照样不崩，永远不需要换命名空间、不需要大搬家。这是 protobuf 这类协议几十年验证过的做法。冻结顶层 + 演进只走嵌套，是这套纪律的边界。

### 2. 只加不减

> 新字段一律可选，永不删字段、永不改已有字段的含义。

这样新版写的数据老版仍能读，反之亦然。

### 3. 就地升级（upgrade-on-read）

实现见 `sync/graph-snapshot-upgrade.js`，接入真实加载路径 `buildGraphFromSnapshot`。

> 读到旧 `schemaVersion` 时，在内存里逐级升级一格再用，下次保存时顺手写成新版。单调、幂等、读到比当前更新的数据绝不向下改写。

当前快照布局版本是第一版，升级链为空，但框架和铁律已立住——以后改格式只是"加一个升级步骤"，不是搬家。

### 关于 Luker chat-state

Luker 的 ledger namespace 保存与其它 store 同构的不可变账本；兼容图谱仍可作为可重建视图保存在既有 checkpoint。节点/边未知字段会保留，sidecar 上可重算的统计/信封字段仍可用白名单规范化。

## 图谱内容版本 vs 快照布局版本

注意区分两个版本号：

- **`GRAPH_VERSION`**（`graph/` 内）：图谱**内容结构**的版本，有自己的 v2→v9 迁移链，管节点/关系语义的演进。
- **`schemaVersion`**（快照顶层）：耐久快照**布局**的版本，管"存进磁盘的信封形状"的演进。

两者独立。本文档的向前兼容纪律针对的是后者（快照布局）。
