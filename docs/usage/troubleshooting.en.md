# Troubleshooting

[中文](troubleshooting.md) · **English**

This page is split out from the [README](../../README.en.md) with common ST-BME user issues and fixes, so you can locate problems by symptom.

### Panel won't open

- Refresh the SillyTavern page.
- Confirm the extension directory contains `manifest.json`, `index.js`, and `style.css`.
- Open the browser console and search for `[ST-BME]`.
- Check whether another extension has overridden the top-left menu structure.

### Background work produces no new memory

- Confirm the plugin is enabled.
- Confirm the current chat already has assistant replies.
- Check "Overview → Memory Steward" and "Tasks → Persistence".
- Confirm BME's dedicated model is configured and passes its connection test. It never falls back to the current chat model or DOA's model.
- On a first turn or when there is no new fact, a deliberate `no-change` result is not a failure.
- If the ledger is loading/migrating or work is `deferred`, fix the displayed model/storage error and refresh the chat to wake the durable Inbox.

### Poor recall quality

- Configure or repair Embedding.
- Run "rebuild vectors".
- Check whether recall Top-K, the final memory limit, and Recall Agent are enabled.
- Submit a background consolidate/evolve request so the Steward can inspect duplicates or conflicts in full context.
- Check the per-message recall card to confirm the actual injection content.

### The model still sees too much content after old turns are hidden

- "Limit rendered chat turns" only reduces frontend loading; it does not save tokens.
- To actually control context, enable "hide old turns".
- After changing the setting, click "re-apply current hiding".

### A manual memory request says history is incomplete

This is usually because "limit rendered chat turns" is enabled, so the frontend currently loads only the latest N turns.

How to handle it:

1. Temporarily disable "limit rendered chat turns", or increase N enough to cover the range you need to process.
2. Refresh the current chat.
3. Then submit the re-extract/review-range request again.

This is a protection mechanism; it does not mean the graph was lost.

### Nodes suddenly look cleared

- Refresh the page first.
- If it recovers after refresh, it is usually a temporary runtime state inconsistency; the persisted graph was not lost.
- Check "Overview → Recent recovery" and "Tasks → Persistence".
- Do not immediately run "rebuild graph" unless you confirm you want to regenerate all memories from the chat history.

### Recall cards are not displayed

- Confirm the target turn is a user message.
- Empty recall should still have a card. Check that the target message contains `message.extra.bme_recall` with a `ready` or `empty` state.
- Third-party themes must keep `#chat .mes` message nodes and stable turn-index attributes, such as `mesid`, `data-mesid`, or `data-message-id`.
- After enabling debug logs, search for `[ST-BME] Recall Card UI`.

### Reroll reports unavailable durable artifacts

- BME never reruns recall or ENA during reroll, and it does not inject an old message cache by itself.
- The parent user turn is missing a Recall/Planner Artifact, or its turn, evidence history, or chat identity has changed.
- Send the retained input as a new user turn to create a new durable pair. For old data, finish the one-time ledger migration first.

### Direct Embedding fails

- Check the API URL and model name.
- Check the key.
- Check browser CORS.
- Direct external Embedding is the default. Use a supported host backend model only when the service cannot allow browser CORS.
