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

- The user turn owns `message.extra.bme_recall`; ENA planning output uses `message.extra.st_bme_plot`.
- A valid reroll reuses the parent user turn's recall after validating its bound input and history fingerprint. Reroll does not execute ENA again.
- Replacing or deleting an assistant turn reverses that turn's graph effects before the replacement is committed. Failure leaves a durable dirty checkpoint and must not acknowledge success.
- ENA is explicitly enabled. It plans fresh user sends from the raw user input, augments rather than replaces that input, and cannot suppress normal recall when planner recall is empty.

## Persistence and replication

- A chat has one durable graph authority at a time. An unavailable Authority-owned graph fails closed instead of silently writing another primary.
- A successful save means the selected durable authority accepted the revision. Caches, metadata, diagnostics, backups, and Cloud Sync do not turn a failed primary commit into success.
- Cloud Sync is the multi-device replication layer for browser-local persistence, not a separate storage mode. Local commits remain valid while offline; remote upload, download, and merge converge per chat.
- The remote sync head is stable per chat, published only after all referenced chunks exist. Unreferenced remote chunks must be recoverable after interrupted uploads and garbage collection must keep remote file growth bounded on every supported backend.

## Authority boundary

- Delegation of Authority remains a generic capability and transaction platform. BME-specific graph, vector, extraction, and recall semantics stay in the BME companion module.
- Module identity, transaction names, session headers, CAS conflict responses, owner isolation, and sanitized recall-candidate results are external contracts.

## Verification gates

Run `npm run test:product-contract` for the focused contract suite and `npm run test:stable` for the full stable suite. Browser verification uses the sibling SillyTavern source with a dedicated config path, data root, and port; it must never use a personal SillyTavern instance or data directory.
