# ST-BME Memory Graph

**中文** · [English](README.en.md)

ST-BME 是 SillyTavern 的长期记忆图谱扩展。它从已提交的聊天历史提取记忆，在生成前召回相关内容，并把图谱、召回记录、剧情规划记录和向量任务放进同一套可回退事务中。

> 9.0.0 是 clean break。它不会读取、迁移或回写任何旧版图谱、设置、消息 metadata、OPFS、Luker、shadow snapshot 或旧向量集合。

## v9 的边界

- 每次页面启动只选一个 Primary：`indexeddb` 或 `authority`。
- Primary 不热切换、不双写，失败时不会自动回落到另一份数据。
- 每个已接受的历史变化都以 `TurnTransaction + ChangeSet` 原子提交。
- 编辑、删除或切换 swipe 造成历史分叉时，只回退分叉点之后的事务后缀。
- RecallRecord 保存最终注入文本；不新增 user 的生成会精确重放它。
- ENA 是 BME 内部的剧情规划功能，默认关闭，只能在显式开启后的新 user 发送中运行。
- PlannerRecord 与 RecallRecord 分开持久化；reroll 不运行也不读取 ENA。
- 向量索引是可重建派生数据，由耐久 VectorJob 驱动，不是第二事实源。

## 新发送、reroll 与历史回退

| 场景 | 召回 | ENA | 持久结果 |
| --- | --- | --- | --- |
| 新 user 发送 | 生成并提交新的 RecallRecord | 仅显式启用时运行 | RecallRecord；运行过 ENA 才有 PlannerRecord |
| `swipe` / `regenerate` / `continue` | 精确重放父 user 对应 RecallRecord；记录缺失或无效时才重新召回 | 永不运行、永不读取 | 不借用临时 handoff 状态 |
| 编辑、删除、切换已有 swipe | 先按新历史前缀对账 | 分叉后的规划一并撤销 | 逆序回退分叉点后的事务 |

## 安装

在 SillyTavern 的“扩展程序 → 安装扩展”中填写：

```text
https://github.com/Youzini-afk/ST-Bionic-Memory-Ecology
```

安装后刷新页面。默认配置为：BME 开启、IndexedDB Primary、自动提取开启、普通 user 召回开启、ENA 关闭。

### Authority Primary

Authority 模式还需要安装 [ST-Delegation-of-authority](https://github.com/Youzini-afk/ST-Delegation-of-authority)。Authority 按所有者 ID 发现服务端模块，因此 BME 必须是物理目录：

```text
SillyTavern/public/scripts/extensions/third-party/st-bme
```

不要对该目录、`.authority`、`module.json` 或 `server.cjs` 使用符号链接或 junction。切换 Primary 后保存设置并刷新页面；两种 Primary 的数据不会互相迁移。Authority 不可用时，面板会把当前 Primary 标为 blocked，而不是偷偷改用 IndexedDB。

## 使用

进入一个聊天后，点击页面右下角的 BME 按钮。面板包含：

- 总览：当前聊天、修订号、图谱版本和记录数量。
- 图谱：浏览和编辑当前节点；编辑会形成可回退事务。
- 事务记录：检查 RecallRecord、PlannerRecord 和 VectorJob。
- 设置：Primary、ENA、自动提取、普通召回、Embedding、Task Profiles 与正则。

“导入图谱”和“清空图谱”同样是随聊天历史回退的事务。Primary 或启用状态变化需要刷新页面；其余面板设置保存后立即生效。

## 存储

- IndexedDB Primary 使用全新的 `STBME_v9` 数据库。
- Authority Primary 通过 BME 的 `.authority` 模块提交 SQL 状态事务，并用独立 `bme-v9:` namespace 管理 Trivium 派生向量。
- 设置保存在 SillyTavern 的 `extension_settings.st_bme_v9`。
- RecallRecord 和 PlannerRecord 属于 Primary，不写入聊天消息的 `message.extra`。

完整的不变量、数据模型、事务协议和验收矩阵见 [v9 架构基线](docs/vnext/architecture.md)。

## 开发与验证

```bash
npm ci
npm run check
npm test
```

真实宿主测试必须使用独立的 SillyTavern 数据目录、端口和测试聊天，不能复用个人实例。

## License

[GNU AGPL-3.0](LICENSE)
