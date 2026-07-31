# Product contract for the core refactor

This contract protects the complete ST-BME product while its internals are replaced. It describes externally observable behavior, not the current module layout. A phase is not complete when code merely builds; every applicable contract below must still pass.

## Product surfaces

| Area | Contract |
| --- | --- |
| Entrances | The SillyTavern options entry, extensions-menu entry, and floating action button all open the same full panel. |
| Panel | Dashboard, Tasks, Actions, Config, Graph, Cognition, and Summary remain available on desktop and mobile. Existing element IDs and action semantics stay stable until a separately approved UI redesign. |
| Recall card | A user message can display its recalled memory and ENA plot, edit or delete the record, rerun recall, and open referenced graph content. |
| Settings | Memory, retrieval, extraction, maintenance, prompt profiles, ENA, Cloud Sync, diagnostics, native acceleration, Luker, and Authority controls remain accessible. |

## Conversation and generation

- Memory belongs to a chat record, never to the whole character card.
- A generation captures its chat and user floor. A late result cannot mutate the active state, prompt, or UI of another chat.
- `GENERATION_AFTER_COMMANDS` and `GENERATE_BEFORE_COMBINE_PROMPTS` keep their first-listener behavior on vanilla SillyTavern. `MESSAGE_SENT` may bind a recall produced before the new user message entered the host chat.
- `MESSAGE_UPDATED` remains a lightweight UI refresh. Edit, delete, swipe, branch, and reroll use their dedicated history semantics.
- MVU analysis guards, TavernHelper Prompt Viewer bypass, Regex integration, Worldbook capability fallback, group-chat targets, and Luker-specific hooks remain product behavior.

## Recall, history, and ENA

- The user turn owns the editable UI snapshots in `message.extra.bme_recall` and `message.extra.st_bme_plot`; the per-chat memory ledger owns the durable Recall/Planner Artifacts that authorize reuse.
- A valid reroll verifies the exact parent turn/input/history Artifact pair before reapplying its floor snapshot. Missing or invalid Artifacts fail closed; reroll runs neither Recall nor ENA again.
- Replacing or deleting an assistant turn reverses that turn's graph effects before the replacement is committed. Failure leaves a durable dirty checkpoint and must not acknowledge success.
- Extraction and recovery operate on a frozen chat snapshot. Switching chats or changing the same chat across an async boundary aborts the stale transaction.
- An overswipe placeholder is persisted as awaiting replacement; it is never extracted as an empty assistant turn.
- ENA is explicitly enabled. It plans only fresh user sends from the raw user input, augments rather than replaces that input, and cannot suppress normal recall when planner recall is empty.
- ENA planning is leased to one conversation and one unchanged input. Chat switches cancel it; ordinary planner failures fail open by sending the original text. Reroll never reads or consumes a pending planner turn.
- One planner turn handoff carries optional recall and plot data. The normal generation validates it before reuse, and `MESSAGE_SENT` persists both records to the new user floor even when ST Regex or macro expansion transformed the stored message text. Planner history admits only structured plot records whose exact Recall/Planner Artifact binding is still durable in that chat ledger.

## Persistence and replication

- A chat has one durable graph authority at a time. An unavailable Authority-owned graph fails closed instead of silently writing another primary.
- A successful save means the selected durable authority accepted the revision. Caches, metadata, diagnostics, backups, and Cloud Sync do not turn a failed primary commit into success.
- Cloud Sync is the multi-device replication layer for browser-local IndexedDB / OPFS persistence, not a separate storage mode and not a second replica over Authority SQL. Local commits remain valid while offline; remote upload, download, and merge converge per chat. A replica task may clear dirty only for the exact local revision it published, under the local store's transaction/serialized-write guard, and remote apply must fail rather than replace a locally advanced revision.
- The remote sync head is stable per chat, published only after all referenced chunks exist, and a head is read with chunks from the same backend. Every current publication owns a unique chunk namespace, so a later publication cannot reuse a filename that GC is retiring. Superseded isolated chunks stay in an untruncated durable GC ledger until deletion succeeds or absence is confirmed, and idle automatic checks retire due garbage without requiring another graph mutation. Interrupted publications receive best-effort cleanup by known filename; known cleanup failures persist locally until a later head adopts them into the remote ledger. Legacy chunks without publication-isolation evidence are not auto-deleted. The browser must not claim head CAS, linearizability, or discovery of unreferenced historical orphans when the backend API provides none.

## Authority boundary

- Delegation of Authority remains a generic capability and transaction platform. BME-specific graph, vector, extraction, and recall semantics stay in the BME companion module.
- Module identity, transaction names, session headers, CAS conflict responses, owner isolation, and sanitized recall-candidate results are external contracts.

## Verification gates

Run `npm run test:product-contract` for the focused contract suite and `npm run test:stable` for the full stable suite. Browser verification uses the sibling SillyTavern source with a dedicated config path, data root, and port; it must never use a personal SillyTavern instance or data directory.
