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

记忆 LLM 用于：

- 提取记忆。
- 召回精排。
- 整合。
- 压缩。
- 小总结。
- 总结折叠。
- 反思。
- ENA Planner 规划。

配置方式：

- **留空**
  - 复用当前 SillyTavern 聊天模型。

- **填写 OpenAI-compatible 配置**
  - 使用独立模型处理记忆任务。
  - 适合把主聊天模型和后台维护模型分开。

安全建议：

- 不要把包含 API Key 的 `extension_settings` 或浏览器存储导出后公开。
- 调试日志默认关闭，需要排障时再临时开启。

### Embedding

Embedding 是智能召回的核心。

#### 后端模式

推荐优先使用后端模式：

- 复用 SillyTavern 后端的 embedding provider。
- 通常不需要浏览器直接持有 embedding API Key。
- 可使用 SillyTavern 已支持的 OpenAI、Cohere、Mistral、Ollama、LlamaCpp、vLLM 等来源。

#### 直连模式

直连模式由浏览器直接请求 embedding 服务：

- 需要填写 API 地址、Key 和模型。
- 可能遇到 CORS 限制。
- 适合自建网关或独立 embedding 服务。

> 切换 embedding 模式或模型后，建议执行“重建向量”。

### 提取设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 每 N 条回复提取 | `1` | 每几条助手回复触发一次提取 |
| 提取上下文轮数 | `2` | 提取时向前看的对话轮数 |
| 自动延后最新助手 | `false` | 可让最新回复稳定后再提取 |
| 提取管线版本 | `split-v1` | 默认分成客观事实阶段 + 主观/POV 阶段；旧自定义提取 Prompt 会自动回退单请求 legacy |
| Assistant 排除标签 | `think,analysis,reasoning` | 默认排除推理标签 |
| 提取消息上限 | `0` | `0` 表示不限 |
| 提取 Prompt 结构模式 | `both` | 同时提供 transcript 和 structured messages |
| 提取世界书模式 | `active` | 复用当前激活世界书上下文 |
| 包含故事时间 | `true` | 提取时提供故事时间线 |
| 包含总结快照 | `true` | 提取时提供活跃总结 |
| 手动提取模式 | `pending` | 面板中的提取模式默认值 |

### 召回设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用召回 | `true` | 生成前自动检索记忆 |
| 向量预筛 | `true` | 先用 embedding 找候选 |
| 图扩散 | `true` | 沿图关系扩散相关节点 |
| LLM 精排 | `true` | 让 LLM 从候选中筛最终结果 |
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

### 维护设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用整合 | `true` | 相似/冲突记忆分析与合并 |
| 整合阈值 | `0.85` | 相似度触发阈值 |
| 启用小总结 | `true` | 兼容旧 `synopsis` 名称 |
| 启用层级总结 | `true` | 使用小总结 + 折叠的总结体系 |
| 小总结频率 | `3` | 每几次提取生成小总结 |
| 总结折叠扇入 | `3` | 同层总结达到几条后折叠 |
| 启用智能触发 | `false` | 只在高信息量场景增强提取 |
| 启用主动遗忘 | `false` | 周期性降低低价值节点 |
| 启用概率召回 | `false` | 少量弱相关记忆按概率入围 |
| 启用反思 | `true` | 周期性总结长期趋势 |
| 启用自动压缩 | `true` | 按提取周期压缩同类记忆 |

### 任务预设与正则清理

任务预设类型：

- **`extract`**
  - 记忆提取。

- **`extract_objective` / `extract_subjective`**
  - 默认 `split-v1` 提取管线的客观阶段与主观/POV 阶段。当前版本只做 task type 与提交边界拆分，不在这里改写 Prompt 文案；旧自定义 `extract` Prompt/Profile 会自动回退到 legacy 单请求路径。

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
- 历史 `<plot>` 块。
- 当前玩家输入块。

建议：

- 在“配置 → ENA 规划器”中配置基础 API 和启用状态。
- 在“配置 → 任务预设 → planner”中调整规划 prompt 结构和生成参数。

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
