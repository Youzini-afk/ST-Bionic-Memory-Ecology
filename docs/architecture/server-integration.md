# 服务器集成（Authority / st-doa）

ST-BME 可以独立运行（纯前端），也可以在检测到 st-doa/Authority 服务器时自动升级到更稳定的数据平面操作。本文档说明这套自动集成。

## 核心原则

1. **BME 独立运行是第一公民。** 没有 st-doa 时，BME 必须完整可用，优雅降级，不报错。纯前端模式显示"纯前端模式"，不是错误状态。
2. **第三方自定义 URL embedding 是主流路径。** OpenAI 兼容 `/v1/embeddings`、one-api、new-api、litellm、vLLM、llama.cpp、Ollama 桥接等，都是一等公民。embedding 默认在客户端执行（`embeddingTransportMode` 默认 `"direct"`，直连第三方 URL）。
3. **集成是自动的，不需要用户配置。** 能力探测驱动的升级/降级，没有面向用户的"服务器模式"开关。既要优雅降级（无 st-doa），也要优雅升级（有 st-doa），全程零用户干预。

> Authority 是**增强层**，不是硬依赖。它不生成 embedding——只通过 Trivium 存储/搜索向量，并要求调用方提供向量。

## 三档集成模式

| 模式 | 含义 | embedding | 存储 |
| --- | --- | --- | --- |
| **Mode A** | 纯前端（基线） | 前端生成 | 浏览器本地（IndexedDB/OPFS） |
| **Mode B** | Authority 存储增强 | 前端仍生成 | Authority 负责可靠 SQL/Trivium 持久化与诊断 |
| **Mode C** | 可选服务器端 embedding | 服务器端（**仅 opt-in**） | Authority |

Mode A 必须完全稳定（它是基线）。Mode C 是可选的、必须显式开启。

## 自动升级状态机

ST-BME 维护一个派生的 `authorityUpgradeState`，由能力探测驱动：

```
standalone → probing → shadow → candidate → enhanced → degraded
```

- **standalone**：没有 Authority，纯前端模式。
- **probing**：检测到可能的 Authority，正在探测能力。
- **shadow / candidate**：逐步确认 Authority 各项能力。
- **enhanced**：Authority 各项能力就绪，使用增强数据平面。
- **degraded**：Authority 部分能力不可用，自动回退到仍可用的层。

面板显示当前自动模式，但不提供手动切换开关。

## 能力探测

ST-BME 从 Authority 的 `/probe` 和 session 响应里读取 BME 专属能力标志：

- `bmeVectorManifestReady`
- `bmeVectorApplyReady`
- `bmeVectorApplyJobsReady`
- `bmeServerEmbeddingProbeReady`
- `bmeCandidateSearchReady`
- `bme.protocolVersion`

旧版/无 Authority 时这些默认全 false，自动走 fallback。这保证了对老 Authority 探针的向后兼容。

## 任务类型协商

Authority 的后台 job 系统只支持特定 job 类型。ST-BME 不能盲目提交。

> `shouldUseAuthorityJobs` 校验具体 job 类型是否在服务器声明的 registry 中（从 `jobs.builtinTypes` / `jobs.registry.jobTypes` / `core.health.jobRegistrySummary.jobTypes` 读取）。服务器没声明支持的 job 类型不提交，直接走直连同步。

> 空的 `supportedJobTypes: []` 表示"服务器明确不支持任何 job"；缺失/默认则表示"未知"，保持对旧探针的向后兼容。

## 向量应用端点

`POST /bme/vector-apply`：客户端生成向量后，由 Authority 执行 Trivium 批量 upsert + link。

> Authority 不碰 embedding API key。它只接收客户端生成好的向量。

> 该端点按批校验 `vectorSpaceId` / `observedDim` 一致性，拒绝混合维度，返回带类型的校验错误。

BME → Authority 的向量协议约定：

- 节点身份使用 `externalId` / `nodeId`；顶层 `id` 是 Trivium 内部 numeric id，BME 不发送字符串 node id 到该字段。
- link 使用 `{ src: { externalId, namespace }, dst: { externalId, namespace }, label, weight }`，由 Authority 在服务端解析成 Trivium 内部 id。
- search 请求携带 `namespace` / `collectionId` / `chatId`；返回结果若带 namespace，BME 会过滤掉非当前 namespace 的命中，避免多聊天/多集合污染。

向量空间身份和维度门禁的算法见 [`../algorithms/vector-and-embedding.md`](../algorithms/vector-and-embedding.md)。

## Authority SQL 图谱存储选择

> Authority SQL 图谱持久化由 `storagePrimaryReady`（SQL + session + permission）门控，**不是** `serverPrimaryReady`（SQL + Trivium + Jobs + Blob）。

这意味着 Blob/Jobs/Trivium 降级不会禁用 SQL 持久化——SQL 图谱持久化只需要 SQL + 会话 + 权限。这条避免了"某个增强能力不可用就连主存储都不写"的过度联动。
