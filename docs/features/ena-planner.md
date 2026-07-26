# ENA Planner

ENA Planner 是一个**可选的、发送前剧情规划**子系统。它独立于核心记忆系统，默认关闭。

实现：`ena-planner/`（独立模块）、`ui/panel-ena-sections.js`、`runtime/planner-recall-controller.js`。

## 做什么

在用户消息真正发给模型**之前**，先用一个单独的"规划师"LLM 生成幕后指引，附加到用户输入里。规划师不直接扮演角色、不写正文，只规划下一轮 AI 回复的走向。

产出带标签的规划文本：

- `<plot>` — 剧情走向指引（导演式的下一步规划）
- `<note>` — 写作笔记（风格/连贯性指示）

过滤后的规划输出会附加到真实用户输入后面再发送：`原始输入 + \n\n + 规划输出`。

## 管线

```
拦截发送（点击发送/回车）
  → 构建规划消息（buildPlannerMessages）
  → 收集上下文：角色卡 + BME 记忆召回 + 近期 AI 对话 + 结构化/旧式 plot 历史 + 世界书 + 用户输入
  → 渲染模板/宏（EJS、ST 宏）
  → 组装提示词块（优先用 planner 任务预设，回退遗留块）
  → 调用规划师 LLM（callPlanner，可流式）
  → 过滤响应（去 think，保留配置的标签）
  → 注入 textarea 并发送
```

启动入口 `initEnaPlanner(bmeRuntime)`：迁移旧存储、加载配置/日志、安装发送拦截器、暴露 `window.stBmeEnaPlanner`。

发送拦截条件：planner 启用、未在规划中、textarea 非空、输入非 trivial、未 bypass、（若 `skipIfPlotPresent`）输入未含 `<plot>`。

## 与 ST-BME 的集成

ENA Planner 集成的是**召回**和**剧情历史记录**，不是提取：

- 它调用 BME 召回获取记忆块作为规划上下文（`runPlannerRecallForEna`）。
- 规划输出注入用户文本后，主生成会把规划标签当作用户消息的一部分看到。
- 规划输出会以结构化记录写入用户楼层 `message.extra.st_bme_plot`；后续规划优先读取这个记录，读不到时再回退扫描历史文本中的 `<plot>`。
- 它**不**直接运行提取，也**不**把规划结果写进记忆图谱。后续提取走正常聊天/提取路径。

### 召回交接（handoff）

规划输出附加到 textarea 后，正常生成本会对"增强后的输入"（原文 + `<plot>`/`<note>`）做召回——但那会用改变后的文本检索，结果偏差。

为避免这点，ENA 注册一个**一次性召回交接**：含原始用户输入、增强消息、召回结果、注入文本，source 标记 `planner-handoff`。正常生成召回会读取这个交接，把召回输入覆盖回原始用户文本，并复用已算好的召回结果（`cachedRecallPayload`）。

这套机制的实现见 `runtime/planner-recall-controller.js`、`runtime/reroll-recall-input.js`、`runtime/generation-recall-transactions.js`。

### 结构化剧情历史

历史 plot 不再只依赖“从聊天文本里扫描 `<plot>`”。Planner 发送时会准备一条独立的 plot record handoff；`MESSAGE_SENT` 绑定到新 user 楼层后写入：

```js
message.extra.st_bme_plot = {
  version: 1,
  rawUserInput,
  plannerAugmentedMessage,
  plotText,
  plotBlocks,
  inputHash,
  createdAt,
  recallHandoffId,
  taskResults: []
}
```

读取顺序：

1. 优先读取 `message.extra.st_bme_plot` 中的结构化 `<plot>` 块。
2. 若结构化记录不足 `plotCount`，用历史消息文本里的旧式 `<plot>` 补足。
3. 只把 `<plot>` 内容喂回 planner；`<note>` / `<state>` 等标签不会因为结构化记录而混入历史 plot 区。

plot record handoff 和 recall handoff 是两条独立通道：即使 planner 召回失败或被禁用，只要 planner 产出了 `<plot>`，剧情历史仍可持久化。这避免了“剧情推进记录依赖召回成功”的隐式耦合。

## 规划召回 vs 正常召回

| 维度 | 规划召回 | 正常召回 |
| --- | --- | --- |
| 时机 | 规划师 LLM 调用前 | 主生成前 |
| 查询源 | 原始用户输入 | 用户输入（或交接复用） |
| 上下文 | `recallLlmContextMessages`（夹 0..20） | 标准召回上下文 |
| 门禁 | 跳过 trivial、需图谱可读、历史恢复、向量就绪 | 同左 |

## 配置（独立存储）

ENA 配置存在 `STBME_EnaPlanner.json`，不在主设置里。关键默认：

| 设置 | 默认 |
| --- | --- |
| `enabled` | false |
| `skipIfPlotPresent` | true |
| `plotCount` | 2 |
| `responseKeepTags` | plot, note, plot-log, state |
| `includeGlobalWorldbooks` | false |
| API stream | true |
| `logsPersist` / `logsMax` | true / 20 |

面板的"ENA 规划器"区（`data-config-section="planner"`）提供启用、跳过已有 plot、测试输入、API 预设、世界书选项、保留/排除标签、plot 数量、日志等控件。

> 关于命名：代码里 "ENA" 作为模块/产品名使用（Ena Planner / ENA 规划器），未找到明确的缩写展开；实际提示词角色是"剧情规划师 / Story Planner"。
