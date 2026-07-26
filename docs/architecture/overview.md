# 架构总览

ST-BME 是一个 SillyTavern 第三方前端扩展：在聊天进行时，把对话提炼成一张**记忆图谱**（节点 + 关系），并在生成前把相关记忆召回、注入回提示词。

`manifest.json` 指向 `index.js`（主入口/编排层）和 `style.css`。

## 子系统地图

```
index.js              主入口：事件钩子、设置管理、流程调度、依赖注入组合根
│
├── graph/            记忆图谱数据结构、节点/关系 schema、快照、认知/区域/时间线状态
├── maintenance/      写入链路：提取、整合、压缩、分层总结、智能触发
├── retrieval/        读取链路：混合检索、图扩散、评分、增强、注入格式化
├── vector/           向量索引、直连 embedding、向量空间身份、维度门禁
├── sync/             持久化与同步：IndexedDB/OPFS 存储、快照契约、控制平面模块
├── prompting/        提示词构建、任务预设、正则/世界书/EJS 任务模式
├── llm/              LLM 请求封装
├── runtime/          运行时状态、设置默认值、身份解析、注入式控制器/工厂
├── host/             SillyTavern 宿主适配（事件绑定、上下文、原生渲染）
├── ui/               面板、自定义 Canvas 图谱渲染、消息级 UI、召回卡片
├── ena-planner/      ENA Planner（独立规划子系统）
└── native/           Native/WASM 加速（灰度，fail-open 回退 JS）
```

`index.js` 在这次重构后正在收敛成**组合根（composition root）**：它持有少数模块级运行时状态，并通过 `create*Runtime()` 把依赖显式注入给抽出的控制器模块。详见 [`control-plane.md`](control-plane.md) 和 [`../contributing/conventions.md`](../contributing/conventions.md)。

## 三条数据路径

ST-BME 的运行可以归纳为三条相对独立的链路。

### 写入链路（对话 → 记忆图谱）

助手回复落地后触发，把新对话提炼进图谱。

```
助手消息落层
  → 自动提取计划（够不够触发？智能触发？）
  → 构建结构化提取输入（过滤 think/analysis 等）
  → LLM 客观提取 + 主观/POV 提取 → 规范化操作（create/update/delete/link）
  → 写入图谱节点与关系（含时序边）
  → 后处理：整合去重 → 分层总结 → 反思 → 睡眠遗忘 → 压缩
  → 向量同步（为新节点生成 embedding）
  → 持久化到耐久存储层
```

算法细节见 [`../algorithms/extraction.md`](../algorithms/extraction.md) 和 [`../algorithms/consolidation-and-compression.md`](../algorithms/consolidation-and-compression.md)。

### 读取链路（用户输入 → 注入提示词）

生成前触发，把相关记忆召回并注入。

```
解析召回输入（override / 发送意图 / 聊天尾部用户楼层）
  → 可复用的持久召回记录？命中则跳过新检索
  → 向量预筛（多意图拆分 + 多查询）
  → 图扩散（PEDSA 扩散激活）
  → 混合评分（图 + 向量 + 词法 + 重要度 × 时间衰减）
  → 认知边界过滤 + 可选 DPP 多样性 + 可选残差召回
  → 可选 LLM 精排
  → 访问强化 + 可选概率召回
  → 注入格式化（按 POV/区域分桶成表格）
```

算法细节见 [`../algorithms/retrieval.md`](../algorithms/retrieval.md) 和 [`../algorithms/diffusion-and-dynamics.md`](../algorithms/diffusion-and-dynamics.md)。

### 安全链路（保护已有记忆不被误删/误覆盖）

横跨写入和读取，确保宿主的各种异常状态（只渲染最近 N 条、reroll、切换聊天、历史被编辑）不会误清空或覆盖记忆图谱。

```
历史变动检测 → 必要时历史恢复（replay 或全量重建）
渲染切片识别 → 暂停破坏性恢复
Restore Lock → 恢复期间阻断图谱变更
持久化身份校验 → 防止把别的聊天身份当成当前聊天
```

细节见 [`control-plane.md`](control-plane.md) 和 [`../features/history-safety.md`](../features/history-safety.md)。

## 控制平面 vs 数据平面

这次重构的核心理念是把**"做决定"（控制平面）和"执行副作用"（数据平面）分开**：

- **控制平面**：身份解析、持久化确认状态机、图谱可写性门禁、向量门禁、生成代际上下文 / reroll 召回复用。这些是纯逻辑/策略，已抽成可独立测试的注入式模块。
- **数据平面**：实际的 IndexedDB/OPFS/Authority/Luker 读写。仍在编排层，由控制平面的决定驱动。

这条分界是过去大量 bug（陈旧 pending、未进入聊天、reroll 乱召回、一致性漂移）的修复基础。详见 [`control-plane.md`](control-plane.md)。

## 完整目录结构

```text
ST-BME/
├── index.js                       # 主入口：事件绑定、流程调度、历史恢复、持久化协调
├── manifest.json                  # SillyTavern 扩展清单
├── style.css                      # 扩展样式
├── package.json                   # 测试与开发脚本
│
├── graph/                         # 图数据模型与领域状态
│   ├── graph.js                   # 节点/边 CRUD、序列化、迁移
│   ├── graph-persistence.js       # 持久化常量、加载状态、身份别名
│   ├── schema.js                  # 节点和关系 Schema
│   ├── memory-scope.js            # 主客观作用域与空间区域
│   ├── knowledge-state.js         # 认知归属、可见性、区域状态
│   ├── story-timeline.js          # 故事时间线
│   ├── summary-state.js           # 活跃总结状态
│   └── node-labels.js             # 节点显示名工具
│
├── maintenance/                   # 写入链路
│   ├── extractor.js               # LLM 提取管线
│   ├── extraction-controller.js   # 自动/手动提取编排
│   ├── extraction-success-controller.js # 提取成功后处理编排（注入式）
│   ├── reroll-recovery-controller.js # reroll 回滚 + 历史恢复编排（注入式）
│   ├── extraction-context.js      # 结构化消息和边界过滤
│   ├── chat-history.js            # 楼层、hash、历史恢复工具
│   ├── consolidator.js            # 记忆整合
│   ├── compressor.js              # 压缩与遗忘
│   ├── hierarchical-summary.js    # 小总结和折叠总结
│   ├── smart-trigger.js           # 智能触发
│   └── task-graph-stats.js        # 任务图谱统计
│
├── retrieval/                     # 读取链路
│   ├── retriever.js               # 召回编排
│   ├── shared-ranking.js          # 共享排序核心
│   ├── recall-controller.js       # 召回输入和注入控制
│   ├── recall-persistence.js      # 消息级召回持久化
│   ├── retrieval-enhancer.js      # 多意图、DPP、残差召回
│   ├── diffusion.js               # 图扩散
│   ├── dynamics.js                # 混合评分与访问强化
│   └── injector.js                # 注入格式化
│
├── prompting/                     # Prompt 与任务预设
│   ├── prompt-builder.js
│   ├── prompt-profiles.js
│   ├── default-task-profile-templates.js
│   ├── prompt-node-references.js
│   ├── task-regex.js
│   ├── task-worldinfo.js
│   ├── task-ejs.js
│   ├── injection-sanitizer.js
│   └── mvu-compat.js
│
├── llm/                           # LLM 请求封装
│   ├── llm.js
│   └── llm-preset-utils.js
│
├── vector/                        # 向量索引与直连 Embedding
│   ├── vector-index.js
│   ├── vector-gate.js             # 向量准备/修复门禁策略
│   ├── vector-sync-controller.js  # 向量同步编排（注入式）
│   └── embedding.js
│
├── runtime/                       # 运行时状态和设置
│   ├── identity-resolver.js        # 身份解析核心
│   ├── runtime-state.js
│   ├── generation-context.js       # 宿主生成 type 跟踪 + 父 user 楼解析
│   ├── recall-input-state.js       # 召回 input/intent/trivial-skip 状态工厂
│   ├── reroll-recall-input.js      # reroll/continue 召回输入 + planner handoff 输入工厂
│   ├── generation-recall-transactions.js # 生成召回事务生命周期工厂
│   ├── final-recall-injection.js   # 最终召回注入解析工厂
│   ├── auto-extraction-defer.js    # 自动提取 defer/resume 工厂
│   ├── planner-recall-controller.js # ENA planner 召回管线（注入式）
│   ├── settings-defaults.js
│   ├── generation-options.js
│   ├── planner-tag-utils.js
│   ├── request-timeout.js
│   ├── runtime-debug.js
│   ├── debug-logging.js
│   └── user-alias-utils.js
│
├── sync/                          # 持久化与同步
│   ├── bme-db.js                  # IndexedDB 数据层
│   ├── bme-opfs-store.js          # OPFS/sidecar 存储
│   ├── bme-sync.js                # 云端镜像与备份恢复
│   ├── bme-chat-manager.js        # chatId → 数据库生命周期
│   ├── persistence-reducer.js      # 持久化 accepted/queued/pending reducer
│   ├── graph-persistence-io.js     # IndexedDB 图谱 save/load/queue/retry（注入式）
│   ├── graph-load-persist.js       # 图谱加载/持久化/authority 编排（注入式）
│   ├── graph-mutation-gate.js      # 图谱变更门禁 + 持久化 live-state 投影（注入式）
│   ├── legacy-persistence-repair.js # 旧状态安全修复策略
│   ├── graph-snapshot-schema.js    # 耐久快照契约：冻结顶层键 + 宽容解析
│   └── graph-snapshot-upgrade.js   # 快照 upgrade-on-read 就地升级链
│
├── host/                          # SillyTavern 宿主适配
│   ├── event-binding.js
│   ├── runtime-host-adapter.js
│   ├── st-context.js
│   ├── st-native-render.js
│   └── adapter/
│
├── ui/                            # 面板、自定义 Canvas 图谱和消息级 UI
│   ├── panel.html
│   ├── panel.js
│   ├── panel-bridge.js
│   ├── panel-ena-sections.js
│   ├── ui-actions-controller.js
│   ├── ui-status.js
│   ├── message-render-limit.js    # 聊天区渲染楼层限制策略
│   ├── history-notice.js          # 历史变更通知文案
│   ├── graph-renderer.js          # Canvas 图谱渲染：诊断/防护、语义样式、瞬时高亮、星系初始布局
│   ├── graph-layout-solver.js     # 布局求解；原生/worker 布局仍通过桥接加速并回退 JS
│   ├── graph-native-bridge.js     # 原生/worker 布局桥接
│   ├── recall-message-ui.js
│   ├── recall-message-ui-controller.js # 召回卡片挂载/刷新工厂（封装定时器/observer 状态）
│   ├── hide-engine.js
│   ├── notice.js
│   └── themes.js
│
├── ena-planner/                   # ENA Planner
├── native/                        # Native/WASM 源码与构建产物相关目录
├── vendor/                        # vendored 依赖
├── lib/                           # 浏览器侧库文件
└── tests/                         # Node 回归测试与性能测试
```

## 事件挂载

| SillyTavern 事件 | ST-BME 行为 |
| --- | --- |
| `CHAT_CHANGED` | 加载当前聊天图谱，恢复持久状态，应用隐藏/渲染限制 |
| `GENERATION_AFTER_COMMANDS` | 助手回复后触发自动提取 |
| `GENERATE_BEFORE_COMBINE_PROMPTS` | 生成前召回并注入 |
| `MESSAGE_SENT` | 捕获发送意图和权威用户输入 |
| `MESSAGE_RECEIVED` | 更新自动提取队列和持久化状态 |
| 编辑 / 删除 / Swipe | 检测历史变化并恢复 |
