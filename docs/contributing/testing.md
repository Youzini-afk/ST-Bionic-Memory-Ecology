# 测试

ST-BME 的测试是 Node 回归测试（`tests/*.mjs`），`npm run test:stable` 自动扫描运行。本文档说明测试分类和两道关键防线。

## 测试分类

| 类别 | 例子 | 测什么 |
| --- | --- | --- |
| 控制平面 | `identity-resolver` / `persistence-reducer` | 身份解析、持久化状态机不变量 |
| 数据格式 | `graph-snapshot-schema` / `graph-snapshot-upgrade` / `snapshot-forward-compat` | 快照契约、宽容解析、向前兼容往返 |
| 持久化 | `graph-persistence` / `indexeddb-*` | 图谱持久化、IndexedDB 快照/增量/hydrate |
| 检索/召回 | `p0-regressions` 内相关、`recall-controller-helpers`、`recall-reroll-reuse`、`trivial-user-input` | 召回来源判定、reroll 复用、注入 |
| 向量 | `vector-gate` / `vector-connection-probe` / `vector-sync-coalescer` | 向量门禁、连接探测、后台同步合并 |
| Native | `native-layout-parity` / `native-rollout-matrix` | native/JS 一致性、灰度门控 |
| 防线 | `index-slicing-ratchet` / `runtime-deps-completeness` / `i18n-user-visible-ratchet` | 见下 |

## 防线一：禁止切片 index.js（ratchet）

历史上部分回归测试用 `readFile(index.js)` + 标记字符串切片 + `vm.runInContext` 来测内部函数。这让 `index.js` 与字节偏移强耦合，反复出现 `X is not defined` 沙箱崩溃，并阻碍任何 `index.js` 重构。

这些逻辑已全部抽成可直接 `import` 的控制器/工厂模块。

> `tests/index-slicing-ratchet.mjs` 守住这条线：任何测试文件若读取 `index.js` 文本，CI 失败。允许名单（ALLOWLIST）现在为空，且只能缩不能增。

**所以：新测试必须直接 import 真实模块并注入依赖，绝不切片 `index.js`。**

## 防线二：依赖注入完整性守卫

抽出的控制器模块通过 `runtime` 对象拿依赖，由 `index.js` 的 `create*Runtime()` builder 提供。如果模块用了 `runtime.someDep` 但 builder 忘了提供，运行时（尤其 fallback 路径）才炸——测试可能还是绿的。这正是历史上出过的真实 bug。

> `tests/runtime-deps-completeness.mjs` 扫描三个 sync 控制平面模块的直接 `runtime.X` 引用，和对应 builder 提供的键对比；漏注入则失败，并报出模块/builder/缺失键。

校验的模块/builder 对：

| 模块 | builder |
| --- | --- |
| `sync/graph-persistence-io.js` | `createGraphPersistenceIoRuntime` |
| `sync/graph-load-persist.js` | `createGraphLoadPersistRuntime` |
| `sync/graph-mutation-gate.js` | `createGraphMutationGateRuntime` |

> 禁止 `runtime[dynamicKey]` 这种计算属性访问——它绕过静态完整性检查，守卫会直接报错。新增 `runtime.X` 依赖时，必须同步更新对应 builder。

详见 [`conventions.md`](conventions.md)。

## 防线三：前端 i18n 用户可见文案 ratchet

前端中英 i18n 只翻译 UI，不翻译 prompt、记忆节点、聊天内容或持久化数据。为了避免已迁移 UI 文件重新出现硬编码中文按钮/Toast/confirm，新增：

> `tests/i18n-user-visible-ratchet.mjs` 只扫描已迁移的 UI 文件，拦截明显用户可见模式：`toastr.*("中文")`、`confirm("中文")`、`textContent = "中文"`、`innerHTML` 中的中文按钮、`title/placeholder/aria-label` 中文等。

这不是全仓库中文禁令：中文文档、注释、测试 fixture、prompt/model/data 模块和 `i18n/zh-CN.js` 都不在这条规则里。新增用户可见文案时，应新增 catalog key，并通过 `t("...")` / `data-i18n` / keyed status 渲染。

## 重要测试文件

- **`tests/p0-regressions.mjs`** — 主回归集合，覆盖提取、召回、恢复、UI 关键路径。
- **`tests/recall-controller-helpers.mjs`** — 召回控制器的纯来源/类型/持久复用输入 helper。
- **`tests/runtime-history.mjs`** — 消息 hash、历史 dirty、恢复状态。
- **`tests/message-render-limit.mjs`** — 聊天区渲染限制和渲染切片历史保护。
- **`tests/graph-persistence.mjs`** — 图谱持久化基础行为。
- **`tests/identity-resolver.mjs` / `tests/persistence-reducer.mjs`** — 身份解析核心、持久化 accepted/queued/pending 状态机。
- **`tests/runtime-deps-completeness.mjs`** — 检查注入式控制器模块的 `runtime.X` 依赖均由对应 builder 提供。
- **`tests/i18n-user-visible-ratchet.mjs`** — 检查已迁移 UI 文件不新增硬编码中文用户可见文案。
- **`tests/graph-snapshot-schema.mjs` / `tests/snapshot-forward-compat.mjs`** — 耐久快照契约、宽容解析和真实存储向前兼容往返。
- **`tests/indexeddb-persistence.mjs`** — IndexedDB 快照、增量提交、hydrate。
- **`tests/indexeddb-sync.mjs`** — 云端同步与冲突合并。
- **`tests/native-rollout-matrix.mjs`** — Native 灰度开关和阈值迁移。
- **`tests/task-profile-migration.mjs`** — 任务预设迁移。

## 已知环境限制

- `tests/indexeddb-migration.mjs` 等需要 IndexedDB 测试依赖；某些 Node 环境缺失会失败，非代码问题。
- `typescript-language-server` 未安装，用 `npm run check` 替代 LSP 诊断。
