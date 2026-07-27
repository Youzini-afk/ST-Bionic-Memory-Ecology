# Storage & sync

[中文](storage-and-sync.md) · **English**

This page is split out from the [README](../../README.en.md) with ST-BME data storage, cloud mirroring, and persistent recall card notes; durable snapshot contract and forward-compat details are in the [storage and formats architecture doc](../architecture/storage-and-formats.md).

### Local primary storage

- Primary storage uses IndexedDB.
- Databases are isolated per chat and named like `STBME_{chatId}`.
- The hot path uses incremental commits to avoid replacing the whole graph.
- On load, the graph is restored from the local database first.

### Cloud mirroring

Cloud Sync is the multi-device replication layer for browser-local storage, not another primary storage mode. Local commits remain valid offline; after reconnecting, each chat resumes upload, download, or merge under its own stable chat identity. It uses SillyTavern's existing file API and requires no custom backend route.

- Automatic mode:
  - A successful local write schedules the remote mirror; chat changes and returning to a visible page also check the remote copy.
  - Each chat has one stable head. The head is published only after every new chunk exists; an observed concurrent replacement aborts the publication and keeps the local copy dirty. It does not risk deleting chunks that the winning publication may reuse.
  - Chunks abandoned by an old head first enter a default 24-hour grace ledger. A later automatic sync check retires them even without another graph change. Failed deletes remain for retry; successfully deleted or already-missing entries leave the ledger after the next head is published successfully.

- Manual mode:
  - Local writes still work normally.
  - Does not write to the cloud automatically.
  - Requires clicking "backup to cloud" or "fetch backup from cloud".

Manual backup files and the automatic Cloud Sync mirror are separate objects. "Manage server backups" manages only manual backups. "Clear server sync data" makes a best-effort attempt to remove the current chat's discoverable sync head, current chunks, GC-ledger chunks, and both current and legacy naming trees when present; it does not modify local IndexedDB. Cleanup may be partial while another device is syncing or when the network/backend fails.

SillyTavern's user-files API has no directory listing, conditional write, or conditional delete, so the extension neither guess-deletes unknown filename prefixes nor presents cross-device overwrites as a strict transaction. Failure cleanup is best-effort over filenames known to the current publication. Failed cleanup and historical orphans that have lost every head/ledger reference cannot be discovered reliably in the browser and require server-side file management.

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
