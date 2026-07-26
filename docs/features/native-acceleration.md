# Native / WASM 加速

ST-BME 对几个计算密集操作提供 Rust/WASM 加速，灰度发布，默认 fail-open（失败自动回退 JS）。本文档说明加速了什么、怎么门控、怎么回退。

实现：`native/stbme-core/`（Rust 源）、`vendor/wasm/stbme_core.js`（JS 包装）、`ui/graph-native-bridge.js`、`sync/bme-db.js` 的 native gate。

## 加速了什么

| 操作 | native 钩子 | 阈值（达到才用 native） |
| --- | --- | --- |
| **图谱布局** | `solve_layout` | 节点 ≥ 280 或 边 ≥ 1600 |
| **持久化增量构建** | `build_persist_delta*` | 记录 ≥ 20000 且 结构增量 ≥ 600 且 序列化字符 ≥ 4000000 |
| **快照 hydrate/加载** | `build_hydrate_records` | 记录 ≥ 30000 |

> 没有加速：embedding 和召回图扩散。embedding 走 `vector/` 的 API/直连路径；扩散是纯 JS（`retrieval/diffusion.js`）。注意 `host/st-native-render.js` 不是 WASM 加速器，是 ST 原生模板/宏渲染助手。

## Fail-open 回退

核心标志：

- `nativeEngineFailOpen: true`（默认）— native 失败时回退 JS，不报错
- `graphNativeForceDisable: false`（默认）— 全局禁用 native

回退逻辑：

- **图谱布局**：worker 不可用时，fail-open 返回 skipped 让渲染器跑 JS 布局；strict 模式（fail-open false）才抛 `native-failed-hard`。
- **持久化增量**：native 预加载/构建失败且 fail-open 时，记警告、用 JS 增量。
- **hydrate**：同理，native 不可用且 fail-open 时用 JS hydrate。

`graphNativeForceDisable` 为真时，布局、hydrate、持久化增量全部跳过 native 尝试。

## 灰度发布

设置文件明确把这块标为"灰度"。通过 `nativeRolloutVersion` 做迁移：

- 当前 `NATIVE_ROLLOUT_VERSION = 2`
- 持久版本 < 1：迁移开启 native 布局/增量/hydrate 默认
- 持久版本 < 2 且 hydrate 阈值是旧值 12000：更新到 30000
- 然后设 `nativeRolloutVersion = 2`

这套迁移让老用户平滑升级到新默认，同时保留用户手动 opt-out（手动关掉的不被迁移覆盖）。

## WASM 核心模块

JS 包装 `vendor/wasm/stbme_core.js`：

- 先尝试 wasm-pack 产物（`./pkg/stbme_core_pkg.js` + `.wasm`）
- 失败则用全局 fallback loader `globalThis.__stBmeLoadRustWasmLayout`
- 通过 `getNativeModuleStatus()` 暴露状态

暴露的函数：`solveLayout()`、`installNativePersistDeltaHook()`（装 `__stBmeNativeBuildPersistDelta`）、`installNativeHydrateHook()`（装 `__stBmeNativeHydrateSnapshotRecords`）、`getNativeModuleStatus()` / `resetNativeModuleStatus()`。

Rust 导出：`solve_layout`、`build_persist_delta` / `_compact` / `_compact_hash`、`build_hydrate_records`。

桥接模式 `persistNativeDeltaBridgeMode`（默认 `json`）控制增量传输格式；`hash` 模式走 compact hash 路径。

## 测试

- `tests/native-layout-parity.mjs` — native 布局结果与 JS 布局的平均绝对差在阈值内（保证 native 和 JS 算出来一致）。
- `tests/native-rollout-matrix.mjs` — 迁移、选项归一化、各操作的阈值门控（边界值如 279/280、29999/30000）。

## 面板控件

面板显示 native 状态（全局禁用 / 按阈值自动尝试，fail-open / strict），并绑定 `graphNativeForceDisable`、`nativeEngineFailOpen`、`graphUseNativeLayout`、`persistUseNativeDelta`、`loadUseNativeHydrate` 等开关和阈值输入。遇到异常可在面板强制关闭 native。
