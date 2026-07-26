# 向量与 Embedding

向量是召回质量的下限。本文档说明 embedding 路径、向量空间身份、维度门禁——尤其是"换 embedding 模型导致维度变化"时如何保证不崩、不误用旧向量。

实现：`vector/embedding.js`、`vector/vector-index.js`、`vector/vector-space.js`、`vector/vector-gate.js`。

## Embedding 执行位置

> embedding 默认在客户端（浏览器）执行：`embeddingTransportMode` 默认 `"direct"`（直连第三方 embedding URL）。另一个值是 `"backend"`（走宿主后端代理）。

第三方自定义 URL 是一等公民：OpenAI 兼容 `/v1/embeddings`、one-api、new-api、litellm、vLLM、llama.cpp、Ollama 桥接等。Authority 不生成 embedding，只存/搜向量。

## 批量 Embedding

`embedBatch()`（`vector/embedding.js`）：

- 默认按 `embeddingBatchSize=10` 分块（可配，上限 100）
- 直连模式发送分块 OpenAI 兼容 `/embeddings` 请求，`input: string[]`，含 `encoding_format: "float"`
- 后端模式发送分块 `/api/vector/embed`，`texts: string[]`
- **分块失败回退**：整块失败时降级到逐条 `embedText`
- **部分结果回退**：返回的向量里有 null/缺失项时，只重试缺失项，不重试整块
- `AbortError` 继续向上传播（不吞）

HTTP 错误（400/401/403/429/502 等）会带状态码和响应体抛出，而不是吞成"返回空结果"的泛化错误——这样用户能看到真实的 provider 错误（比如余额不足 403）。

## 向量空间身份（vectorSpaceId）

换 embedding 模型会改变向量维度和语义空间。如果静默把新模型的查询向量拿去和旧模型的存储向量比，结果是垃圾。

> `vectorSpaceId` 由 provider 类型、embedding 模式、规范化 API URL、模型名、观测维度共同计算得出——**不是只看模型名**。API key 不参与计算。

实现见 `vector/vector-space.js` 的 `deriveVectorSpace(config, observedDim)`。

## 本地向量清单（manifest）

直连/自定义 URL 路径维护一个本地向量清单，记录 `vectorSpaceId`、`observedDim`、模型、状态。

> 向量搜索按 manifest 兼容性门控：维度或向量空间不匹配时，标记 stale/dirty 并返回空向量结果，让召回回退到图/词法召回——**绝不静默复用不兼容的旧向量**。

这条保证了用户换模型时看到的是"记忆没丢，搜索索引在重建"，而不是错误的召回结果或"数据丢失"的错觉。

## 维度门禁

`vector/vector-gate.js` 决定向量准备/修复前的动作：skip / repair / blocked / sync。

直连模型/源/集合变更时，不再把旧 `node.embedding` 当作干净可用。Authority 搜索在 BME apply/manifest 能力启用时也按 manifest 兼容性门控。

## 服务器端向量应用

启用 Authority `/bme/vector-apply` 时：

> BME 在 payload 里发送 `vectorSpaceId` 和 `observedDim`（顶层 + 每项元数据）。DOA 按批校验 vectorSpaceId/observedDim 一致性，拒绝混合维度，返回带类型的校验错误。失败/404/旧 DOA 时回退到旧 Authority Trivium 路径或本地。

协议身份字段有严格分工：BME 节点 id 只作为 `externalId` / `nodeId` / `payload.nodeId` 发送；`id` 保留给 Trivium 内部 numeric id，BME 不会把字符串 node id 塞进顶层 `id`。边关系使用 Trivium public reference 形状：`src/dst = { externalId, namespace }`，由 Authority 解析到内部 id。

搜索请求也必须携带 `namespace` / `collectionId` / `chatId`。如果 Authority 返回带 namespace 的命中，BME 会保守过滤掉不属于当前 namespace 的结果；老后端不返回 namespace 时结果仍保留，以避免过度破坏兼容性。

## 连接测试

`testVectorConnection()` 测的是**真实批量 embedding 路径**（走 `embedBatch`），而不是单条短文本——因为"测试通过但实际 embedding 失败"的根因就是测试只测了单条短文本而运行时用的是批量长文本。

- 测试按表单选择的传输模式（direct/backend）测试，不被 Authority 自动主路径劫持
- 后端模式同时探测 `/api/vector/embed`（批量 embedding）和 `/api/vector/query`（向量存储健康）
- Authority 模式先用 embedding provider 生成批量向量，再检查 Trivium stat（避免暗示 Authority 生成 embedding）

## 后台向量同步合并

后台向量同步任务通过 `runtime/vector-sync-coalescer.js` 合并：

- 同 chat + 模型 scope 合并范围
- 活跃同步期间最多保留一个待处理任务
- 切换聊天时跳过陈旧任务
- 队列拒绝时回滚待处理状态

这避免了"每次编辑/reroll 都产生独立任务、串行 FIFO 队列堆积"的放大问题。

## 关键默认参数

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `embeddingTransportMode` | direct | embedding 传输模式（direct 直连 / backend 后端代理） |
| `embeddingBatchSize` | 10（上限 100） | 批量分块大小 |
| `encoding_format` | float | 直连 OpenAI 兼容请求 |
