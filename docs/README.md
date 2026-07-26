# ST-BME v9 文档

当前文档只描述 9.0.0 clean-break 运行时：

- [中文说明](../README.md)
- [English README](../README.en.md)
- [v9 架构基线](vnext/architecture.md)：状态模型、Primary、事务、回退、召回重放、ENA、向量 outbox、并发租约与验收矩阵。

## 当前源码地图

| 路径 | 职责 |
| --- | --- |
| `index.js` | SillyTavern 扩展入口与生命周期 |
| `src/core/` | 状态模型、ChangeSet、事务与历史对账 |
| `src/storage/` | IndexedDB / Authority 两种独立 Primary |
| `src/generation/` | 新发送、reroll、RecallRecord 注入 |
| `src/planner/` | BME 内部 ENA 剧情规划与 PlannerRecord |
| `src/domain/` | 提取、维护和召回领域管线 |
| `src/vector/` | VectorJob outbox 与派生索引 |
| `src/host/` | 当前 SillyTavern 事件适配 |
| `src/ui/` | v9 面板 |
| `.authority/` | Authority 服务端模块与事务声明 |
| `tests/vnext/` | v9 契约和回归测试 |

旧运行时文档已删除，避免把已移除的兼容、迁移、shadow/fallback 或旧面板路径重新带回实现。
