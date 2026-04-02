# ST-BME Reroll / History Recovery Review Notes

## 1. Background and user pain points

This note summarizes the issues found during a real debugging session, the user expectations behind the fixes, and the exact code changes that were made.

Primary user pain points:

- A new chat sometimes showed recall activity, but extraction state stayed at `processed floor = -1`, which made it look like nothing was recorded.
- Manual extraction worked, but automatic behavior felt inconsistent.
- The worst issue: after each new floor, ST-BME could enter history recovery, roll back, and replay extraction again, making every turn slow.
- The user explicitly does not want reroll/swipe to degrade into rebuilding everything before the changed floor.

The user's strongest expectations:

- Normal extraction should stay incremental.
- Hidden old floors do not need to be re-read just for extraction context.
- If floor 16 is rerolled/swiped, only memories related to the affected suffix should be updated.
- Floors before that prefix should not be replayed again.
- `swipe/reroll` should not silently fall back to generic full history recovery.

## 2. Important product/logic expectations from the user

These were treated as design constraints during the fix:

- Do not change the "hide old floors" strategy just to feed more extraction context.
- Do not make reroll depend on re-reading all previous floors.
- Do not allow reroll/swipe to degrade into full rebuild.
- If targeted reroll rollback cannot be done safely, fail closed and report failure instead of rebuilding the whole prefix.

## 3. What the code already intended to do

The repo already had two different recovery concepts.

### A. Generic history mutation recovery

Used for broad history mutations such as edit, delete, or hash mismatch.

Relevant code:

- `inspectHistoryMutation(...)` in `index.js`
- `recoverHistoryIfNeeded(...)` in `index.js`
- `detectHistoryMutation(...)` in `runtime-state.js`

This path can do larger recovery or replay work because it is trying to revalidate processed history integrity.

### B. Dedicated reroll rollback

Used for targeted suffix rollback around a reroll/swipe boundary.

Relevant code:

- `rollbackGraphForReroll(...)` in `index.js`
- `onRerollController(...)` in `extraction-controller.js`

This path is closer to the desired product behavior:

- find a recovery point near the target floor
- rollback only affected journals and suffix state
- prune processed hashes from the affected floor onward
- re-extract only the affected suffix

## 4. Issue 1 that was fixed: recovery loop caused by lost processed hashes

### Symptom

The panel showed a pattern like:

- history recovery starts
- replay completes
- next turn immediately triggers another recovery
- reason mentions missing `processedMessageHashes`

### Root cause

After successful history recovery, dirty state was cleared, but processed message hashes were not restored. On the next integrity recheck, the system saw:

- there is already processed progress
- but `processedMessageHashes` is empty or missing

That was interpreted as another dirty history condition, so recovery started again.

### Fix

After a successful recovery replay, restore processed hashes from current chat state before saving the graph.

Relevant change:

- `index.js`, `recoverHistoryIfNeeded(...)`
- added call: `updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor)`

Why this matters:

- recovery replay now leaves history state internally consistent
- the next hash recheck does not immediately trigger another replay loop

### Regression test added

- `tests/p0-regressions.mjs`
- `testHistoryRecoverySuccessRestoresProcessedHashesAfterReplay()`

## 5. Issue 2 that was fixed: host swipe event was routed into generic history recovery

### Symptom

Even though the repo already had dedicated reroll rollback code, the actual host `MESSAGE_SWIPED` event still went through generic history mutation recheck first.

That meant a user swipe could enter the broader history recovery pipeline instead of the suffix-only reroll path.

### Why this was wrong

This conflicts with the desired behavior:

- `swipe/reroll` is a targeted suffix change
- it should not be treated like a generic broad history mutation
- it should not have a path that silently escalates into full replay of earlier floors

### Fix

Changed event routing so that `MESSAGE_SWIPED` directly calls `onReroll(...)` instead of scheduling generic history mutation recheck.

Relevant changes:

- `event-binding.js`
  - `onMessageSwipedController(...)` is now async
  - it calls `runtime.onReroll({ fromFloor, meta })`
  - it no longer schedules `scheduleHistoryMutationRecheck("message-swiped", ...)`
- `index.js`
  - `onMessageSwiped(...)` is now async
  - runtime wiring now passes `onReroll`

### Resulting behavior

For swipe/reroll:

- route to dedicated suffix rollback
- if rollback succeeds, only affected suffix is re-extracted
- if rollback cannot be done safely, fail as reroll rollback failure
- do not silently drop into generic history recovery fallback

### Regression test added

- `tests/p0-regressions.mjs`
- `testSwipeRoutesToRerollWithoutHistoryRecoveryFallback()`

This test specifically asserts:

- `onReroll` is called
- `scheduleHistoryMutationRecheck` is not called

## 6. Things intentionally not changed

These were discussed and intentionally left alone:

- The "hide old floors" behavior was not redesigned.
- No attempt was made to force extraction to re-read very old floors.
- No attempt was made to make reroll reconstruct the entire prior conversation.

This matches the user's explicit preference:

- previous floors should already be recorded
- reroll should only repair the affected suffix
- old hidden floors should not become the reason for broader replay behavior

## 7. Current intended invariants after the fixes

These are the important invariants another reviewer should validate:

1. Normal extraction remains incremental.
2. Generic edit/delete/hash corruption can still use broader recovery if needed.
3. `swipe/reroll` must use dedicated suffix rollback logic.
4. `swipe/reroll` must not silently degrade into generic full history recovery.
5. Successful recovery replay must leave `processedMessageHashes` populated consistently with processed floor state.

## 8. Files directly involved

- `index.js`
- `event-binding.js`
- `extraction-controller.js`
- `runtime-state.js`
- `chat-history.js`
- `tests/p0-regressions.mjs`

## 9. Concrete code locations worth reviewing

Suggested review targets:

- `index.js`
  - `recoverHistoryIfNeeded(...)`
  - `rollbackGraphForReroll(...)`
  - `onMessageSwiped(...)`
- `event-binding.js`
  - `onMessageSwipedController(...)`
- `extraction-controller.js`
  - `onRerollController(...)`
- `runtime-state.js`
  - `detectHistoryMutation(...)`
  - `clearHistoryDirty(...)`
- `chat-history.js`
  - processed hash pruning and extraction window helpers

## 10. What was verified locally

Executed successfully:

- `node --check event-binding.js`
- `node --check index.js`
- `node --check tests/p0-regressions.mjs`
- `node tests/p0-regressions.mjs`

## 11. What I want the reviewing AI to focus on

Please review for these questions:

- Is there any remaining code path where `MESSAGE_SWIPED` can still end up in `recoverHistoryIfNeeded(...)` instead of dedicated reroll rollback?
- Is there any remaining reroll path that can still escalate into prefix/full rebuild instead of suffix-only repair?
- After reroll rollback, are `historyState`, `processedMessageHashes`, and vector repair state all kept mutually consistent?
- Are there any race conditions between swipe-triggered reroll, auto extraction, and delayed hide application?
- Does the current failure mode truly fail closed, or is there still an implicit generic fallback somewhere else?

## 12. Short conclusion

The key product decision behind these fixes is:

- generic history corruption and targeted reroll are not the same thing
- reroll/swipe should be handled as suffix repair, not broad recovery

The current changes aim to enforce exactly that distinction.
