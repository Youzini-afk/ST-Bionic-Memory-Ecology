# Planner-First Recall Reuse for ST-BME

## Summary
This change is for the specific workflow where `Ena Planner` is enabled and always used before send. The product intent is:

- Planner-generated `<plot>/<note>/<plot-log>/<state>` tags are generation control signals for the main reply model, so the main AI must still see them.
- Those tags are not memory facts and should not become the query anchor for recall, nor be treated as long-term memory content during extraction/storage.
- When planner is enabled, the system should do one full recall on the raw user input, use that recall for planner generation, then reuse that same recall result for the subsequent main-chat generation instead of running a second recall.
- When planner is disabled, current behavior stays unchanged.

Important clarification for the implementing AI: the goal is not to hide planner tags from the main model. The goal is to separate concerns:

- `raw user input` drives recall and planning
- `raw input + planner tags` is what the main reply model receives
- sanitized user text continues to drive memory extraction/storage

## Non-Goals
- Do not hide `<plot>/<note>/<plot-log>/<state>` from the main reply model. Those tags are meant to influence the actual reply.
- Do not let planner tags become the recall query anchor for the main generation path.
- Do not store planner tags as long-term memory facts or let them contaminate extraction/storage semantics.
- Do not redesign the author's existing retrieval strategy, blending logic, or transaction bridge. This change is about input anchoring and result reuse, not a retrieval rewrite.

## Implementation Changes
### 1. Upgrade planner recall to full recall
In `ena-planner/ena-planner.js`:

- Change planner-side BME recall from the current planner-safe/lightweight mode to a full recall call.
- Do not change the retrieval algorithm itself. Keep the existing hybrid/vector/diffusion/LLM logic that ST-BME already uses.
- The planner should still call the same BME entrypoint (`runPlannerRecallForEna`), but it must no longer suppress LLM recall by default.
- Preserve the current planner prompt assembly behavior: planner prompt still includes char/worldbook/recent chat/BME memory/previous plots/raw user input.

### 2. Add a transient planner-to-chat recall handoff
In `index.js`:

- Add a new one-shot, in-memory planner recall handoff state for the active chat only.
- This handoff stores:
  - `chatId`
  - `rawUserInput`
  - `plannerAugmentedMessage` (the final sent text after appending planner tags; retained primarily for diagnostics and optional sanity assertions, not as a new matching key)
  - the full retrieval result returned from planner recall
  - preformatted `injectionText`
  - source metadata such as `source = "planner-handoff"` and a human-readable label
  - creation timestamp
- This handoff is not persisted to graph/chat metadata and must expire quickly using the same style of short-lived runtime state already used for `generationRecallTransactions` and other pre-generation recall coordination state.
- Clear this handoff on chat change, history mutation invalidation, explicit consumption, or TTL expiry.

### 3. Let planner register the handoff before the real send
In `ena-planner/ena-planner.js` and `index.js`:

- Expose a new BME runtime function to `Ena Planner`, for example `preparePlannerRecallHandoff(...)`.
- In the planner intercept flow, after planner output is filtered and merged into the outgoing message but before `btn.click()` triggers the real send, call this new runtime API with:
  - the original raw user input
  - the final merged outgoing text
  - the planner recall result
- Do not add new heuristic matching logic. Treat this as a direct one-shot handoff from planner to the immediately following real send in the same chat.
- The handoff write must happen synchronously before `btn.click()`, with no `await`, timer hop, or queued async boundary between the handoff registration and the actual click. Add an implementation comment documenting this ordering requirement.

### 4. Reuse planner recall during main generation instead of rerunning recall
In `index.js`:

- In the normal-generation recall path, before launching `runRecall()` and before deriving a normal-generation recall transaction from the planner-augmented message, check for a fresh planner handoff.
- The handoff lookup key should be the active `chatId` plus one-shot freshness/consumption semantics, not a new transaction-id-style key derived from the planner-augmented text.
- If a fresh planner handoff exists:
  - bind this generation's effective recall input to the raw user input from the planner handoff, not the planner-augmented message
  - seed the generation recall transaction with the cached planner recall result
  - mark the transaction so the current generation hook does not run a second `retrieve()`
  - reuse the standard `applyFinalRecallInjectionForGeneration(...)` path so prompt delivery, persisted recall records, recall card rendering, selected node tracking, and status UI still behave like a normal recall completion
- Consume the handoff immediately on first successful use so regenerate/continue/swipe cannot accidentally reuse the original planner handoff.
- Keep the existing hook bridge behavior between `GENERATION_AFTER_COMMANDS` and `GENERATE_BEFORE_COMBINE_PROMPTS`. The planner handoff should feed into the existing transaction/result pipeline, not bypass it with a separate injection-only shortcut.
- If planner handoff is missing, stale, invalid, or already consumed, fall back to the current behavior with no planner-specific changes.

### 5. Preserve current extraction/storage semantics
Do not change the extraction-side rule that planner tags should be stripped from user messages before memory extraction/storage.

- Keep using planner tag sanitization when building extraction messages and recall context display lines.
- The main AI still sees planner tags because they remain in the actual sent user message.
- Memory extraction should continue to treat those tags as non-factual control markup.

## Logic and Data Flow
With planner enabled, the intended final flow is:

1. User types raw input.
2. Planner intercepts send.
3. Planner asks BME for a full recall using the raw input.
4. Planner uses that recall to generate `<plot>/<note>/...`.
5. Planner appends those tags to the outgoing message.
6. Planner registers a transient handoff with BME.
7. Planner triggers the real send.
8. Main-chat generation sees the planner-augmented user message.
9. BME generation hooks detect the planner handoff and reuse the cached recall result instead of calling `retrieve()` again.
10. Prompt injection, persisted recall record creation, UI state, and selected-node bookkeeping still go through the normal ST-BME generation-resolution path.
11. AI replies.
12. Normal extraction/post-processing runs unchanged, with planner tags still stripped before memory extraction.

With planner disabled, the flow remains exactly as it is today.

## Compatibility Notes
- The current planner-side BME memory insertion shape is already compatible with full recall. Planner does not consume a special planner-only recall schema; it already receives a normal ST-BME retrieval result converted through `formatInjection(...)`, then wrapped as `<bme_memory>...</bme_memory>` inside the planner prompt.
- Because of that, enabling full recall for planner should not require redesigning planner prompt assembly or changing the planner message contract.
- The practical difference between current planner recall and proposed planner recall is mainly that current planner recall disables LLM rerank by default, while the proposed version allows the same full recall stack used by normal generation. This means the likely behavior change is:
  - potentially better node selection / ordering
  - potentially higher latency
  - no expected response-shape incompatibility for planner prompt construction
- The current planner-side BME recall has a dedicated timeout budget (`VECTOR_RECALL_TIMEOUT_MS = 15000`). Since enabling planner-side full recall also enables LLM rerank, the implementation must explicitly review whether this timeout remains acceptable. The plan does not require a final policy choice yet, but the implementing AI must treat timeout budget as an explicit review item rather than an implicit side effect.
- Timeout policy is intentionally still an implementation review item. Acceptable outcomes include keeping the current budget if profiling shows it is sufficient, increasing the budget for planner full recall, or making planner-side full-rerank behavior/settings configurable. The implementing AI should not silently ignore this decision.
- LLM rerank failure already falls back to score-based selection inside the existing retrieval pipeline, so planner integration should remain structurally safe even when LLM recall is unavailable or unstable.
- Review focus for another AI should be on runtime behavior and latency impact, not on prompt-format incompatibility.

## Test Plan
### Core behavior
- Planner enabled: one send should trigger exactly one retrieval for planner recall and zero additional retrievals during the immediate main-chat generation for that same send.
- Planner enabled: the main model still receives the planner-augmented user message containing `<plot>/<note>/...`.
- Planner enabled: the injected memory block used for main-chat generation must come from the cached planner recall result, not a new retrieval run.
- Planner enabled: persisted recall record and recall card still appear for the sent user message via the normal ST-BME path.

### Input semantics
- Planner enabled: recall query anchor for the main generation is the raw user input, not the merged planner-tagged text.
- Extraction after assistant reply still strips planner tags from user messages before memory extraction.
- Planner tags remain visible to the main AI but do not become stored memory facts via extraction.

### Fallback and safety
- Planner disabled: current recall/generation behavior is unchanged.
- If planner handoff is absent, stale, invalid, or consumed already, ST-BME falls back to current normal recall behavior.
- Chat change or history mutation clears any pending planner handoff so stale planner recall cannot leak across chats or replay situations.
- Planner full recall remains prompt-compatible: `planner` should continue receiving a `<bme_memory>` block with the same text-oriented structure as before, rather than a new raw object payload or incompatible schema.
- If LLM rerank is unavailable or fails during planner recall, planner flow should still remain usable through the existing retrieval fallback behavior.
- Regenerate/continue/swipe after the original planner-assisted send must not reuse the already-consumed planner handoff; those paths should naturally fall back to current recall behavior.
- Rapid consecutive sends must not cause an earlier planner handoff to leak into a later generation or vice versa; latest-send overwrite/consumption behavior should be verified explicitly.
- Handoff registration and send ordering should be validated: registering the handoff synchronously before `btn.click()` must make the handoff visible to the immediately triggered generation path.
- Optional cleanup improvement: if SillyTavern exposes a reliable abort/cancel path after planner recall completes but before generation begins, handoff cleanup may also hook into that path. This is a cleanliness improvement, not a blocker, because TTL plus one-shot consumption already provide a safety net.

## Assumptions and Defaults
- Do not redesign or replace the author's existing recall matching/blending strategy. This plan only changes which input anchors the recall and whether the already-computed result is reused.
- The planner handoff is a short-lived, one-shot runtime object, not a persisted feature.
- `plannerAugmentedMessage` is kept mainly for observability/debugging and optional runtime sanity checks, not as a new generalized matching mechanism.
- Reuse should happen through the existing generation recall transaction/result pipeline, because that path already owns injection delivery, recall persistence, UI updates, and hook bridging.
- Recall itself does not create durable temporary vector entries that later need per-recall purge; the optimization is for consistency and cost/latency reduction, not vector cleanup.
