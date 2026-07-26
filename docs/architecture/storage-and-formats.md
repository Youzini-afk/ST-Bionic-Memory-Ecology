# 存储分层与数据格式

ST-BME 的图谱数据可能存在多种位置，取决于宿主环境和服务器能力。本文档说明分层策略、快照契约，以及保证"以后改格式不用大迁移"的向前兼容纪律。

## 存储分层

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

### 单一耐久主源与回合提交

每次写入只选择一个耐久主源：Authority SQL、Luker chat-state、OPFS 或 IndexedDB。选定后，另一个存储层不能在主写失败时偷偷变成“已接受”的兜底；例如 Luker 主写失败时，本地缓存不能冒充成功，Authority 已接管后也不能回退到浏览器或 Luker。`metadata-full` 和 shadow 只能保存恢复材料。

一次提取回合把图谱增量、`extractionCount`、processed floor/hash、batch journal 和向量 dirty 状态放进同一份待提交快照。底层的原子边界分别由 Authority SQL transaction、IndexedDB transaction、OPFS WAL→manifest 提交或 Luker sidecar journal→manifest 提供。只有主源返回 `accepted` 后，这份完整快照才会替换当前会话中的运行图谱；失败或排队时，运行图谱和楼层指针都不前移。

chat metadata 中的 commit marker 是主写成功后的恢复锚点，不属于底层事务本身，也不能代替主源的成功结果。异步 marker、pending retry 和副本任务都绑定发起时的聊天目标；切换聊天后可以继续完成原目标的耐久写，但不能把结果发布到新聊天。

### Cloud Sync 副本协议

Cloud Sync 不参与上述主提交确认。它按稳定聊天身份维护一个远端 head 和内容寻址 chunk：先写完整 chunk，再覆盖稳定 head；发布前后都重新读取 head，能观察到的并发替换会使本次发布失败，本地 dirty 状态留待后续同步。一次发布只使用 Authority Blob 或 SillyTavern user-files 中的一个后端；从哪个后端读到 head，也只从该后端读取其 chunk，不能组合跨后端 manifest/chunk。

旧 head 不再引用的 chunk 会进入 head 内的 GC 账本，默认保留 24 小时。账本不截断；到期条目在后续上传或无变化的自动同步检查中删除，失败条目继续保留，成功/404 条目随下一次 head 成功发布退休。chunk 已写而 head 发布失败时，失败路径会按已知文件名和实际写入后端尽力补偿；一旦观察到竞争发布或本次 head 写入已经成功，就跳过可能伤害胜者的即时补偿。补偿失败或被安全策略跳过都可能留下浏览器之后无法枚举的孤儿。

SillyTavern user-files 没有 list、条件写入或条件删除，因此未知历史孤儿不可安全枚举，跨设备竞争只能通过宽限期和操作前后的 head 校验收窄；远端语义是乐观的 last-writer-wins，不是线性事务。浏览器端删除只使用当前/旧稳定 head 及其显式 chunk/GC 引用作为证据，绝不按前缀推测删除。

## 快照契约

耐久快照的顶层结构被**冻结**为固定的六个键（实现见 `sync/graph-snapshot-schema.js`）：

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

### 关于 Luker sidecar

Luker checkpoint 存的是完整序列化图谱（`serializeGraph`），节点/边的未知字段被保留——所以图谱正文通过 Luker 是容错的。sidecar 上的信封元数据（manifest 统计、checkpoint 元信息）用白名单规范化是**有意为之**：那些是可重算的运行指标，不是图谱本身，丢了能重建。

## 图谱内容版本 vs 快照布局版本

注意区分两个版本号：

- **`GRAPH_VERSION`**（`graph/` 内）：图谱**内容结构**的版本，有自己的 v2→v9 迁移链，管节点/关系语义的演进。
- **`schemaVersion`**（快照顶层）：耐久快照**布局**的版本，管"存进磁盘的信封形状"的演进。

两者独立。本文档的向前兼容纪律针对的是后者（快照布局）。
