# Storage & sync

[中文](storage-and-sync.md) · **English**

This page is split out from the [README](../../README.en.md) with ST-BME data storage, cloud mirroring, and persistent recall card notes; durable snapshot contract and forward-compat details are in the [storage and formats architecture doc](../architecture/storage-and-formats.md).

### Local primary storage

- Primary storage uses IndexedDB.
- Databases are isolated per chat and named like `STBME_{chatId}`.
- The hot path uses incremental commits to avoid replacing the whole graph.
- On load, the graph is restored from the local database first.

### Cloud mirroring

Cloud sync uses SillyTavern's existing file API and requires no custom backend route.

- Automatic mode:
  - After local writes, sync according to the current mirroring logic.

- Manual mode:
  - Local writes still work normally.
  - Does not write to the cloud automatically.
  - Requires clicking "backup to cloud" or "fetch backup from cloud".

### Compatibility and fallback

- Old `chat_metadata.st_bme_graph` is only used as a migration and fallback source.
- shadow snapshot and metadata-full are recoverable anchors, not the preferred primary storage.
- tombstone is used to sync deletion state and prevent old data from coming back.
- Plugin settings are stored in SillyTavern's `extension_settings.st_bme`.
- Message-level recall is stored in the corresponding user message's `message.extra.bme_recall`.

### Persistent recall cards

User messages with valid `message.extra.bme_recall` display recall cards:

- Expand to view the recall text.
- View the recall subgraph.
- Click nodes to view details.
- Edit the injection text.
- Delete persistent recall.
- Re-run recall and overwrite the record.

Priority:

1. When a new recall succeeds in this round, use the new recall and write it back to the target user turn.
2. When there is no new recall in this round, read persistent recall from the user turn corresponding to the current generation as fallback.
3. When neither exists, clear the injection.
