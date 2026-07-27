# ENA Planner

ENA Planner 是 ST-BME 内置的可选剧情规划能力，默认关闭，只有用户显式启用后才介入新消息发送。它不是另一套记忆系统：规划会读取 BME 召回结果，正常生成仍由 BME 的召回与持久化管线负责。

实现入口：`ena-planner/`、`runtime/planner-recall-controller.js`、`runtime/reroll-recall-input.js`、`runtime/generation-recall-transactions.js`、`ui/panel-ena-sections.js`。

## 行为边界

- 新 user 消息通过 ST 的发送按钮或标准 Enter 发送，且 ENA 已启用时，先规划再发送。
- ENA 关闭时不拦截发送，BME 正常召回照常运行。
- `swipe`、`regenerate`、`continue` 等没有新 user 楼层的生成不运行 ENA；reroll 复用父 user 楼层已经持久化的召回。
- trivial 输入和已经带 `<plot>` 的输入按配置跳过规划。
- Enter 判定复用 ST 的 `shouldSendOnEnter()`，不会吞掉移动端换行、IME 组合输入、Shift/Ctrl/Alt 组合键。
- 直接绕开 ST 发送按钮/键盘入口调用 `Generate()` 的第三方代码不会触发 ENA；它仍会进入 BME 的正常生成召回钩子。

## 新消息管线

```text
拦截一次发送
  → 捕获当前聊天 lease 与原始 textarea
  → 用原始 user 输入执行一次 BME 规划召回
  → 读取角色卡、世界书、近期回复、历史 plot 与任务预设
  → 调用 planner LLM，过滤 think 并保留配置标签
  → 建立单个 planner turn handoff
  → 同步写回“原始输入 + 规划输出”并复用 ST 发送按钮
  → GENERATION_AFTER_COMMANDS 校验 handoff 与本次 generation
  → 正常召回复用规划召回；若规划召回为空则执行 fresh recall
  → MESSAGE_SENT 把 recall 与 plot 一次绑定到新 user 楼层
```

规划任务跨越任何 `await` 都受聊天 lease 和 AbortSignal 约束。切换/加载另一聊天或输入被外部代码改写时，旧任务会取消且不会发送；同一聊天中的 planner 请求失败则恢复原文并继续正常发送，避免一次规划故障吞掉用户消息。

提示词块与 generation 参数只有一个事实源：BME 的 `planner` task profile。ENA 配置不保存旧 prompt 副本，也不从旧配置或 LittleWhiteBox 文件迁移、回退。LLM 连接选择使用 ENA 面板中的 BME LLM preset；未指定时跟随 BME 当前全局 LLM 配置。

## 单回合交接

规划完成后只建立一条按 chatId 隔离的短期记录：

```js
{
  chatId,
  rawUserInput,
  plannerAugmentedMessage,
  result,                 // 可选：非空规划召回结果
  injectionText,          // 可选：非空记忆注入块
  plannerPlotRecord,      // 可选：结构化剧情规划
  matchedGenerationId
}
```

`GENERATION_AFTER_COMMANDS` 只在 fresh normal generation 中读取它，并先确认宿主冻结输入就是 `plannerAugmentedMessage`。确认后，召回查询恢复成 `rawUserInput`：

- 有非空 `result + injectionText`：通过 `cachedRecallPayload` 复用规划阶段已经完成的召回，不二次检索。
- 规划召回为空：不创建空缓存，正常召回继续计算；只要有 plot，turn handoff 仍保留原始输入映射与剧情记录。
- reroll/history generation：完全不读取、标记或消费 planner turn handoff。

ST 会在用户楼层入库前执行用户输入 Regex 和宏替换，因此最终 `message.mes` 不一定逐字等于 textarea。handoff 先且只能绑定一个 `matchedGenerationId`，`MESSAGE_SENT` 再以同一 generation 已验证为必要证据原子消费并持久化，既兼容 ST 的消息改写，也不会认领下一次发送。

## 每聊天持久化

本轮召回写在 user 楼层：

```text
message.extra.bme_recall
```

规划记录写在同一 user 楼层：

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

两者由同一次 `MESSAGE_SENT` 交接写入并触发一次聊天保存。后续规划优先读取结构化 `st_bme_plot`；数量不足时仍可从聊天正文中的 `<plot>` 补足，但不会把 `<note>` / `<state>` 混入历史 plot。

## 配置作用域

ENA 用户级偏好与日志保存在 `STBME_EnaPlanner.json`；它们不承载聊天记忆。跟随聊天的 recall/plot 数据只存在对应聊天记录的 `message.extra` 中。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 必须显式启用 |
| `skipIfPlotPresent` | `true` | 已有 plot 时不重复规划 |
| `plotCount` | `2` | 读取的历史规划数量 |
| `responseKeepTags` | plot, note, plot-log, state | 规划输出保留标签 |
| `includeGlobalWorldbooks` | `false` | 是否额外读取全局世界书 |
| `logsPersist` / `logsMax` | `true` / `20` | 规划日志策略 |

流式、temperature、top-p、top-k、penalty 与 max tokens 均来自当前 `planner` task profile。
