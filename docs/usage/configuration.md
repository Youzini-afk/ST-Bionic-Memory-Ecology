# 主要配置

**中文** · [English](configuration.en.md)

本文从 [README](../../README.md) 拆出 ST-BME 的主要用户配置说明，保留设置名称、默认值和表格，便于按功能查阅。

### 界面语言

`界面语言` 只影响 ST-BME 前端 UI：面板、菜单入口、悬浮按钮、状态、Toast、召回卡片和图谱系统标签。

可选值：

- `自动`：优先跟随 SillyTavern / 浏览器语言，识别不到时使用中文。
- `简体中文`：固定中文界面。
- `English`：固定英文界面。

这个设置**不会**翻译聊天内容、用户输入、AI 回复、记忆节点、召回注入文本或提示词构建。切换语言不会改变记忆图谱和模型行为。

### 记忆 LLM

记忆 LLM 是 BME Agent 的专用模型，用于 Memory Steward 的提取、整合与进化，也用于 Recall Agent 和 ENA Planner。

配置方式：

- **留空**
  - Agent 任务不会回退到当前 SillyTavern 聊天模型或 DOA 模型；后台任务会延后，前台会显示明确的配置错误。

- **填写兼容配置**
  - 使用独立模型处理全部 BME Agent 任务。
  - 可配置上下文窗口；达到窗口前会按 token 总结并压缩上下文。
  - 后台任务默认最多 500 次工具调用、运行 8 分钟，这两个防失控边界可在面板中调整。

安全建议：

- 不要把包含 API Key 的 `extension_settings` 或浏览器存储导出后公开。
- 调试日志默认关闭，需要排障时再临时开启。

### Embedding

Embedding 是智能召回的核心。

#### 直连 Embedding API（默认）

直连模式由浏览器直接请求独立的 embedding 服务：

- 需要填写 API 地址、Key 和模型。
- 可能遇到 CORS 限制。
- 适合自建网关或独立 embedding 服务。

#### SillyTavern 后端索引

后端索引模式复用 SillyTavern 后端的 embedding provider：

- 通常不需要浏览器直接持有 embedding API Key。
- 仅能使用 SillyTavern 已支持的 OpenAI、Cohere、Mistral、Ollama、LlamaCpp、vLLM 等来源。

> 切换 embedding 模式或模型后，建议执行“重建向量”。

### Agent 记忆写入

助手回复进入聊天后，BME 会先把楼层保存为不可变证据并写入耐久待办，随后在后台唤醒 Memory Steward。Steward 会根据这批证据、已有记忆和关系，自主决定提取、修订、整合、总结、归档或明确不修改；这些能力不再按固定次数和阈值串行执行。

- `think`、`analysis`、`reasoning` 等排除标签仍在进入 Agent 前清理。
- 生成和召回不会等待后台任务；任务完成前读取当前已提交账本，完成后自然读取新版本。
- “重新提取”“压缩”“进化”等手动动作现在是提交给 Steward 的后台意图，不会开启另一条旧写入管线。
- 账本提交按聊天记录隔离，并在一次事务中同时验证证据、读取依赖和记忆修订。

### 召回设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用召回 | `true` | 生成前自动检索记忆 |
| 向量预筛 | `true` | 先用 embedding 找候选 |
| 图扩散 | `true` | 沿图关系扩散相关节点 |
| Recall Agent | `true` | 让 Agent 从快速候选开始，并在需要时继续查询后发布结果 |
| 召回 Top-K | `20` | 向量预筛数量 |
| 最终节点上限 | `12` | 注入前最多保留节点数 |
| 图扩散 Top-K | `100` | 图扩散候选数量 |
| LLM 候选池 | `30` | 进入精排的候选池大小 |
| 多意图拆分 | `true` | 一条输入拆成多个检索意图 |
| 上下文混合查询 | `true` | 融合当前输入、上一轮助手、前一条用户消息 |
| 词法增强 | `true` | 关键词精确匹配加权 |
| 时序链接 | `true` | 临近时间节点互相增强 |
| 多样性采样 | `true` | 避免召回结果过于同质 |

### 认知与空间设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| Scoped Memory | `true` | 启用作用域记忆 |
| POV Memory | `true` | 启用角色/用户视角记忆 |
| 区域目标 | `true` | 区分当前区域、邻接区域、全局 |
| 认知记忆 | `true` | 启用主客观认知归属 |
| 空间邻接 | `true` | 地区之间可建立邻接关系 |
| 故事时间线 | `true` | 启用故事时间标签 |
| 注入故事时间标签 | `true` | 在注入中提示当前故事时间 |
| 软时间引导 | `true` | 以提示方式引导，不强制改写 |

### Agent 运行设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 上下文窗口 | `128000` tokens | BME Agent 可用的模型上下文；达到窗口前自动总结和压缩 |
| 后台工具调用上限 | `500` | 单个 Memory Steward 任务的防失控边界 |
| 后台运行上限 | `8` 分钟 | 单个后台 Agent 任务的防失控边界 |
| 概率召回 | `false` | 是否允许少量弱相关记忆进入程序化候选 |

提取、整合、总结、关系修复和遗忘都由 Memory Steward 按当前证据与记忆状态决定，不再提供固定频率和相似度阈值开关。生成与召回不会等待后台整理完成：已完成时使用新账本，仍在运行时直接读取当前已提交版本。

### 任务预设与正则清理

实时记忆写入和召回现在由 Agent 工具循环拥有。任务预设仍用于调整模型生成参数、正则、世界书和 EJS 上下文，也保留专用任务供 ENA 与显式工具能力调用；它们不再组成每层必跑的固定流水线。

任务预设类型：

- **`extract`**
  - 记忆提取。

- **`extract_objective` / `extract_subjective`**
  - 供显式提取工具使用的客观与主观/POV 模板；不是每层固定执行的双阶段管线。

- **`recall`**
  - 召回精排。

- **`compress`**
  - 记忆压缩。

- **`synopsis`**
  - 小总结生成。

- **`summary_rollup`**
  - 总结折叠。

- **`reflection`**
  - 长期反思。

- **`consolidation`**
  - 记忆整合。

- **`planner`**
  - ENA Planner 规划。

正则清理用于减少污染标签进入提取、召回和注入：

- `thinking` / `think` / `analysis` / `reasoning`
- `choice`
- `UpdateVariable`
- `status_current_variable`
- `StatusPlaceHolderImpl`

用户可以在“任务预设”中调整全局正则和任务局部规则。显式保存为空规则时，插件不会自动把默认规则加回去。

### ENA Planner

ENA Planner 现在通过 `planner` 任务预设接入。更深入的实现与流程说明见 [ENA Planner 功能文档](../features/ena-planner.md)。它可以使用：

- 角色卡块。
- 世界书块。
- 最近聊天块。
- BME 召回记忆块。
- 已结构化持久化的历史 `<plot>` 块。
- 当前玩家输入块。

建议：

- 在“配置 → ENA 规划器”中显式启用功能并选择 BME LLM 预设；留空时跟随当前 BME 全局 LLM。
- 在“配置 → 任务预设 → planner”中调整唯一生效的规划 prompt 结构和生成参数。
- reroll 不会重新运行召回或 ENA；它复用父 user 楼层持久化的 Recall / Planner Artifact。

### 隐藏旧楼层与渲染限制

这是两个不同功能；更深入的实现与边界说明见 [隐藏旧楼层与渲染限制功能文档](../features/hide-and-render.md)：

- **隐藏旧楼层**
  - 用于控制上下文 token。
  - 不删除聊天内容。
  - 通过酒馆隐藏机制让较早楼层不再参与主回复和 ST-BME 读取。

- **限制聊天区渲染楼层**
  - 用于减少超长聊天界面卡顿。
  - 同步到 SillyTavern 的 `chat_truncation`。
  - 只控制前端最多加载最近多少条。
  - 不等于上下文隐藏，也不等于删除消息。

重要提示：

- 如果你要对很早的楼层做“重新提取范围”或完整历史恢复，建议临时关闭渲染限制或调大数量并刷新。
- 当 ST-BME 检测到当前 `context.chat` 很可能只是最近 N 条渲染切片时，会暂停破坏性历史恢复，避免误清空运行时图谱。

### Native 性能加速

Native 加速目前是灰度能力，更深入的实现与回退策略见 [Native 性能加速功能文档](../features/native-acceleration.md)，覆盖：

- 图布局。
- Persist Delta。
- 快照 Hydrate。

默认策略：

- 按节点、边、记录数、结构变化和序列化体积阈值自动命中。
- `Fail-open` 默认开启，Native 不可用或失败时回退 JS。
- 可以通过“全局强制关闭 Native”统一回退 JS。
