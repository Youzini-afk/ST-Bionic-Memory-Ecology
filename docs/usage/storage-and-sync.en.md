# Storage & sync

[中文](storage-and-sync.md) · **English**

This page is split out from the [README](../../README.en.md) with ST-BME data storage, cloud mirroring, and persistent recall card notes; durable snapshot contract and forward-compat details are in the [storage and formats architecture doc](../architecture/storage-and-formats.md).

### Local primary storage

- Browser-local primary storage uses OPFS or IndexedDB according to capability and settings.
- Data is isolated per chat; IndexedDB names look like `STBME_{chatId}`, while OPFS uses per-chat directories.
- The hot path incrementally commits an append-only memory ledger; graph, timeline, and vector state are rebuildable projections.
- Loading restores that chat's ledger first. An old graph is imported once, atomically, only after its source load is confirmed complete.
- Luker uses a dedicated `st_bme_memory_ledger_v1` chat-state namespace and never silently falls back to a browser-local store.

### Cloud mirroring

Cloud Sync is the multi-device replication layer for browser-local IndexedDB / OPFS storage, not another primary storage mode. Authority SQL is already a shared primary and does not get a second Cloud Sync replica. Local commits remain valid offline; after reconnecting, each chat resumes upload, download, or merge under its own stable chat identity. It uses SillyTavern's existing file API and requires no custom backend route.

Ledger metadata is not merged with ordinary last-writer overlay. An ancestor/descendant pair selects the descendant; compatible forks replay transactions deterministically into one legal chain; Agent event conflicts that cannot be proven safe stop the merge. A remote snapshot declaring another chatId is rejected before import.

- Automatic mode:
  - A successful local write schedules the remote mirror; chat changes and returning to a visible page also check the remote copy.
  - Each chat has one stable head. Every publication owns a unique chunk namespace, so later publications cannot reuse filenames that GC may retire. The head is published only after every new chunk exists; an observed concurrent replacement aborts the publication and keeps the local copy dirty while recording known leftovers for later recovery.
  - Chunks abandoned by an old head first enter a default 24-hour grace ledger. A later automatic sync check retires them even without another graph change. Failed deletes remain for retry; successfully deleted or already-missing entries leave the ledger after the next head is published successfully.
  - Upload acknowledgement and dirty clearing happen under the local store's revision guard. A newer local commit remains dirty. Download and merge replacement use the same transaction/serialized-write guard and cannot overwrite a revision that advanced while the network request was running.

- Manual mode:
  - Local writes still work normally.
  - Does not write to the cloud automatically.
  - Requires clicking "backup to cloud" or "fetch backup from cloud".

Manual backup files and the automatic Cloud Sync mirror are separate objects. "Manage server backups" manages only manual backups. "Clear server sync data" makes a best-effort attempt to remove the current chat's discoverable sync head, current chunks, GC-ledger chunks, and both current and legacy naming trees when present; it does not modify local IndexedDB. Cleanup may be partial while another device is syncing or when the network/backend fails.

SillyTavern's user-files API has no directory listing, conditional write, or conditional delete, so the extension neither guess-deletes unknown filename prefixes nor presents cross-device head overwrites as a strict transaction. Publication isolation makes current known leftovers safe to retire after the grace period; legacy chunks without that evidence are not auto-deleted. Failed cleanup is persisted locally and adopted by a later head. Historical orphans that have lost every head/ledger reference still cannot be discovered reliably in the browser and require server-side file management.

### Compatibility and fallback

- Old `chat_metadata.st_bme_graph` is only a one-time migration source; BME does not write a completed marker until the source load is confirmed.
- shadow snapshot and metadata-full are recoverable anchors, not the preferred primary storage.
- tombstone is used to sync deletion state and prevent old data from coming back.
- Plugin settings are stored in SillyTavern's `extension_settings.st_bme`.
- The corresponding user message's `message.extra.bme_recall` stores the visible, editable floor snapshot; durable Recall/Planner Artifacts live in that chat's memory ledger.

### Persistent recall cards

User messages with valid `message.extra.bme_recall` display recall cards:

- Expand to view the recall text.
- View the recall subgraph.
- Click nodes to view details.
- Edit the injection text.
- Delete persistent recall.
- Re-run recall and overwrite the record.

Runtime rules:

1. A new user turn or an explicit manual re-recall runs the Recall Agent and writes both a ledger Artifact and the target user-turn cache.
2. Reroll, swipe, and regenerate first validate the parent turn's durable Recall/Planner Artifacts, then reapply that turn's persisted injection text. A manual text edit is reusable only while those Artifacts remain valid.
3. Missing or invalid Artifacts, or a chat switch during validation, fail closed: the current injection is cleared, recall is not rerun, and the message cache is never promoted into a durable result.
