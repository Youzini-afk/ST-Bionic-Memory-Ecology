# Troubleshooting

[中文](troubleshooting.md) · **English**

This page is split out from the [README](../../README.en.md) with common ST-BME user issues and fixes, so you can locate problems by symptom.

### Panel won't open

- Refresh the SillyTavern page.
- Confirm the extension directory contains `manifest.json`, `index.js`, and `style.css`.
- Open the browser console and search for `[ST-BME]`.
- Check whether another extension has overridden the top-left menu structure.

### No automatic extraction

- Confirm the plugin is enabled.
- Confirm the current chat already has assistant replies.
- Check "Overview → Recent extraction" and "Tasks → Pipeline overview".
- Check whether the memory LLM is available.
- If smart triggering is enabled, confirm the current content meets the trigger conditions.
- If a restore lock or persistence loading is active, wait for the state to recover.

### Poor recall quality

- Configure or repair Embedding.
- Run "rebuild vectors".
- Check whether recall Top-K, final node limit, and LLM reranking are enabled.
- Check whether nodes are too many or too scattered; you can run consolidation or compression.
- Check the per-message recall card to confirm the actual injection content.

### The model still sees too much content after old turns are hidden

- "Limit rendered chat turns" only reduces frontend loading; it does not save tokens.
- To actually control context, enable "hide old turns".
- After changing the setting, click "re-apply current hiding".

### Manual extraction says history recovery is paused

This is usually because "limit rendered chat turns" is enabled, so the frontend currently loads only the latest N turns.

How to handle it:

1. Temporarily disable "limit rendered chat turns", or increase N enough to cover the range you need to process.
2. Refresh the current chat.
3. Then run "extract unprocessed" or "rerun extraction range".

This is a protection mechanism; it does not mean the graph was lost.

### Nodes suddenly look cleared

- Refresh the page first.
- If it recovers after refresh, it is usually a temporary runtime state inconsistency; the persisted graph was not lost.
- Check "Overview → Recent recovery" and "Tasks → Persistence".
- Do not immediately run "rebuild graph" unless you confirm you want to regenerate all memories from the chat history.

### Recall cards are not displayed

- Confirm the target turn is a user message.
- Confirm `message.extra.bme_recall.injectionText` is not empty.
- Third-party themes must keep `#chat .mes` message nodes and stable turn-index attributes, such as `mesid`, `data-mesid`, or `data-message-id`.
- After enabling debug logs, search for `[ST-BME] Recall Card UI`.

### Direct Embedding fails

- Check the API URL and model name.
- Check the key.
- Check browser CORS.
- Prefer backend mode first.
