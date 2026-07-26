# ST-BME 文档

这里是 ST-Bionic-Memory-Ecology（ST-BME）的完整文档。仓库根目录的 [`README.md`](../README.md) 是精简入口（介绍、安装、快速上手、导航），细节都在这里。

- 想**用好插件**（配置、面板、排障、存储）→ 看 [`usage/`](#usage--使用手册)
- 想**理解内部原理**（架构、算法、功能机制）或**参与维护** → 看后面几节

## 文档地图

### usage/ — 使用手册
面向用户："怎么配、怎么用、出问题怎么查"。从精简后的 README 下沉的详细内容。中英双语（`.md` 中文 / `.en.md` English）。

- [`configuration.md`](usage/configuration.md) · [EN](usage/configuration.en.md) — 完整配置参考：记忆 LLM、Embedding、提取/召回/认知/维护设置、任务预设、ENA、隐藏/渲染、Native
- [`panel.md`](usage/panel.md) · [EN](usage/panel.en.md) — 面板导览：总览、任务、操作、配置、图谱区域
- [`troubleshooting.md`](usage/troubleshooting.md) · [EN](usage/troubleshooting.en.md) — 排障指南
- [`storage-and-sync.md`](usage/storage-and-sync.md) · [EN](usage/storage-and-sync.en.md) — 数据存储、云端镜像、兼容兜底、持久召回卡片

### architecture/ — 架构与控制平面
跨文件的结构、数据路径、不变量。这些内容变化慢，是理解"为什么这样组织"的入口。

- [`overview.md`](architecture/overview.md) — 子系统地图 + 写入/读取/安全三条数据路径 + 完整目录结构 + 事件挂载
- [`control-plane.md`](architecture/control-plane.md) — 身份解析、持久化状态机、必须维持的不变量
- [`storage-and-formats.md`](architecture/storage-and-formats.md) — 存储分层、快照契约、向前兼容纪律
- [`server-integration.md`](architecture/server-integration.md) — 三档 Authority 集成、自动降级/升级、能力探测

### algorithms/ — 算法原理
核心算法"怎么算的"：参数、公式、阈值。基于真实代码编写，并标注关键文件位置。

- [`retrieval.md`](algorithms/retrieval.md) — 三层混合检索：向量预筛 + 图扩散 + LLM 精排 + 多意图/DPP/残差
- [`extraction.md`](algorithms/extraction.md) — LLM 提取管线：消息 → 结构化 → 图谱写入 → 时序边
- [`diffusion-and-dynamics.md`](algorithms/diffusion-and-dynamics.md) — 图扩散（PEDSA）+ 混合评分 + 访问强化/衰减
- [`consolidation-and-compression.md`](algorithms/consolidation-and-compression.md) — 记忆整合/去重 + 压缩遗忘 + 分层总结
- [`vector-and-embedding.md`](algorithms/vector-and-embedding.md) — 向量空间身份 + 批量 embedding + 维度门禁

### features/ — 功能解析
每个面向用户的功能"做什么、怎么用、边界在哪"。

- [`memory-model.md`](features/memory-model.md) — 节点类型、关系类型、主客观分层、故事时间线
- [`recall-cards.md`](features/recall-cards.md) — 持久召回卡片
- [`history-safety.md`](features/history-safety.md) — 历史变动恢复、渲染限制保护、Restore Lock
- [`hide-and-render.md`](features/hide-and-render.md) — 隐藏旧楼层与渲染限制
- [`ena-planner.md`](features/ena-planner.md) — ENA Planner
- [`native-acceleration.md`](features/native-acceleration.md) — Native/WASM 灰度加速

### contributing/ — 参与维护
怎么开发、怎么测、必须遵守的约定。

- [`development.md`](contributing/development.md) — 构建、测试、检查命令；分支工作流
- [`testing.md`](contributing/testing.md) — 测试分类、ratchet 防线、依赖注入守卫
- [`conventions.md`](contributing/conventions.md) — 注入式控制器模式、必须保持的不变量

## 维护原则（重要）

文档最大的敌人是腐烂。本目录遵守三条防腐铁律：

1. **离代码越近，腐烂越慢。** 单个函数的 API 细节留在模块头注释里（改代码自然会改它），不抄进这里。本目录只写"跨文件的算法原理、不变量、功能行为"。
2. **不写一改就过期的内容。** 避免"某函数第几行做什么"这种描述；算法文档引用文件位置时，描述的是"哪个算法在哪个文件"，而非逐行。
3. **改了行为就更新对应文档。** 算法参数、不变量、功能边界发生变化时，更新这里；纯重构（不改行为）通常不需要动文档。

## 双语约定

- **中文为源，英文跟随。** `.md` 是中文权威版，`.en.md` 是英文翻译。改文档先改中文 `.md`，再同步对应 `.en.md`。
- 目前英文覆盖范围：根 `README`、`docs/usage/` 用户手册。`architecture/` / `algorithms/` / `features/` / `contributing/` 暂为中文，按需再加英文。
- 英文文件里指向其它有 `.en.md` 的文档时，链到英文兄弟文件；指向暂无英文版的开发者文档时，链到中文版即可。
