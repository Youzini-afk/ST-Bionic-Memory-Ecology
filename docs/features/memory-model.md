# 记忆模型

ST-BME 的记忆是一张图谱：**节点**是记忆单元，**关系**（边）连接它们。本文档说明节点类型、关系类型，以及主客观分层和故事时间线这两套横切机制。

节点/关系 schema 定义在 `graph/` 下，可被任务预设扩展。

## 节点类型

常见类型（具体以 schema 定义为准）：

| 类型 | 含义 |
| --- | --- |
| `event` | 事件：某个时间点发生的事 |
| `pov_memory` | 视角记忆：某个角色视角下的认知/记忆 |
| `thread` | 线索：跨多个事件的剧情线 |
| `synopsis` | 概要：全局或区段的总结 |
| `reflection` | 反思：从事件中提炼的洞察 |
| `rule` | 规则：设定/约束类记忆 |
| 实体类 | 角色、地点、物品等命名实体 |

每个节点带 `importance`（重要度 0-10）、`accessCount`（被召回次数）、`createdTime`、`scope`（归属范围）、可选 `storyTime`/`storyTimeSpan` 等。

节点不被物理删除，而是**归档**（`archived = true`）——这保护了历史恢复和审计。

## 关系类型

边带 `relation`（关系名）、`strength`（强度 0-1）、`edgeType`。关键的几种：

| 关系 | 说明 |
| --- | --- |
| `related` | 一般关联（提取时在同批节点间默认建立，强度 0.25） |
| `temporal_update` | 时序更新（节点状态随时间变化，强度默认 0.95） |
| `updates` | 状态更新事件指向被更新节点（强度 0.9） |
| `contradicts` | 矛盾/抑制（edgeType 255）——在图扩散里作为**抑制边**，反向传播负能量 |

抑制边是 ST-BME 处理"矛盾记忆"的机制：见 [`../algorithms/diffusion-and-dynamics.md`](../algorithms/diffusion-and-dynamics.md)。

## 主客观分层

记忆按"谁的视角"分层，这是召回时认知边界过滤的基础：

- **角色 POV**：某角色主观认知的记忆。注入时按 owner 分组（`[Memory - Character POV: <owner>]`）。
- **用户 POV**：用户视角记忆。注入时带"非角色事实"警告（避免模型把用户知道的当成角色知道的）。
- **客观**：不绑定视角的事实，又分"当前区域"和"全局"。

召回时通过认知门（`computeKnowledgeGateForNode`）决定某节点对当前视角是否可见，不可见则跳过。详见 [`../algorithms/retrieval.md`](../algorithms/retrieval.md) 的"认知边界过滤"。

## 故事时间线

记忆带"故事内时间"（不是真实时间），用于按剧情时间线组织：

- `event` / `pov_memory`：时间点 `storyTime`
- `thread` / `synopsis` / `reflection`：时间跨度 `storyTimeSpan`

提取时可由 LLM 给出 `batchStoryTime` 或操作级 `storyTime`，解析后更新时间线段。时序合成边（`temporalLinkStrength=0.2`）让时间相邻的记忆在图扩散里有弱连接。

故事时间线状态见 `graph/story-timeline.js`，认知/区域状态见 `graph/knowledge-state.js`。
