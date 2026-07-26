# 数据存储与同步

**中文** · [English](storage-and-sync.en.md)

本文从 [README](../../README.md) 拆出 ST-BME 的数据存储、云端镜像与持久召回卡片说明；durable snapshot contract 和 forward-compat 细节见 [存储与格式架构文档](../architecture/storage-and-formats.md)。

### 本地主存储

- 主存储使用 IndexedDB。
- 数据库按聊天隔离，命名类似 `STBME_{chatId}`。
- 热路径使用增量提交，避免整图替换。
- 加载时优先从本地数据库恢复图谱。

### 云端镜像

云端同步使用 SillyTavern 已有文件 API，不需要自定义后端路由。

- 自动模式：
  - 本地写入后按当前镜像逻辑同步。

- 手动模式：
  - 本地写入仍正常进行。
  - 不自动写云端。
  - 需要点击“备份到云端”或“从云端获取备份”。

### 兼容与兜底

- 旧版 `chat_metadata.st_bme_graph` 仅作为迁移和兜底来源。
- shadow snapshot 和 metadata-full 是 recoverable 锚点，不是首选主存储。
- tombstone 用于同步删除状态，避免旧数据复活。
- 插件设置存放在 SillyTavern 的 `extension_settings.st_bme`。
- 消息级召回存放在对应用户消息的 `message.extra.bme_recall`。

### 持久召回卡片

带有有效 `message.extra.bme_recall` 的用户消息会显示召回卡片：

- 展开后可查看召回文本。
- 可查看召回子图。
- 可点击节点查看详情。
- 可编辑注入文本。
- 可删除持久召回。
- 可重新召回并覆盖记录。

优先级：

1. 本轮有新召回成功时，使用新召回并写回目标用户楼层。
2. 本轮无新召回时，从当前生成对应用户楼层读取持久召回作为回退。
3. 两者都没有时，清空注入。
