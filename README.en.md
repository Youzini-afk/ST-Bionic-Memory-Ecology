# ST-BME Memory Graph

[中文](README.md) · **English**

ST-BME is a long-term memory graph extension for SillyTavern. It extracts memories from committed chat history, recalls relevant content before generation, and keeps graph changes, recall records, plot-planning records, and vector work inside one rollback-capable transaction model.

> 9.0.0 is a clean break. It does not read, migrate, or write back any pre-v9 graph, settings, message metadata, OPFS data, Luker data, shadow snapshot, or vector collection.

## v9 boundaries

- One Primary is selected for each page lifetime: `indexeddb` or `authority`.
- The Primary cannot hot-switch or dual-write, and a failure never silently falls back to the other store.
- Every accepted history change is committed atomically as a `TurnTransaction + ChangeSet`.
- When edit, delete, or swipe selection forks history, only the transaction suffix after the fork point is rolled back.
- RecallRecord stores the final injection text; generations without a new user turn replay it exactly.
- ENA is BME's built-in plot planner. It is off by default and can run only for a fresh user send after explicit enablement.
- PlannerRecord is persisted separately from RecallRecord; reroll never runs or reads ENA.
- The vector index is rebuildable derived data driven by durable VectorJobs, never a second source of truth.

## Fresh sends, rerolls, and rollback

| Scenario | Recall | ENA | Durable result |
| --- | --- | --- | --- |
| Fresh user send | Create and commit a new RecallRecord | Runs only when explicitly enabled | RecallRecord; PlannerRecord only if ENA ran |
| `swipe` / `regenerate` / `continue` | Replay the parent user's RecallRecord exactly; retrieve again only when it is missing or invalid | Never runs or reads ENA | No temporary handoff state is reused |
| Edit, delete, or select an existing swipe | Reconcile against the new history prefix first | Planning after the fork is removed | Roll back post-fork transactions in reverse order |

## Installation

In SillyTavern, open “Extensions → Install Extension” and enter:

```text
https://github.com/Youzini-afk/ST-Bionic-Memory-Ecology
```

Refresh the page after installation. Defaults are: BME enabled, IndexedDB Primary, automatic extraction enabled, normal user recall enabled, and ENA disabled.

### Authority Primary

Authority mode also requires [ST-Delegation-of-authority](https://github.com/Youzini-afk/ST-Delegation-of-authority). Authority discovers the server module by owner ID, so BME must be a physical directory at:

```text
SillyTavern/public/scripts/extensions/third-party/st-bme
```

Do not use a symlink or junction for that directory, `.authority`, `module.json`, or `server.cjs`. After changing Primary, save settings and reload the page; data is not migrated between Primaries. If Authority is unavailable, the panel marks the selected Primary as blocked instead of silently switching to IndexedDB.

## Usage

Open a chat, then click the BME button in the bottom-right corner. The panel contains:

- Overview: current chat, revision, graph version, and record counts.
- Graph: inspect and edit nodes; edits create rollback-capable transactions.
- Transaction records: inspect RecallRecords, PlannerRecords, and VectorJobs.
- Settings: Primary, ENA, automatic extraction, normal recall, embedding, task profiles, and regex.

“Import graph” and “Clear graph” are also transactions tied to chat-history rollback. Primary and enabled-state changes require a page reload; other panel settings apply after saving.

## Storage

- IndexedDB Primary uses the new `STBME_v9` database.
- Authority Primary commits SQL state transactions through BME's `.authority` module and uses a separate `bme-v9:` namespace for derived Trivium vectors.
- Settings live in SillyTavern's `extension_settings.st_bme_v9`.
- RecallRecords and PlannerRecords belong to the Primary and are not written to chat-message `message.extra`.

See the [v9 architecture baseline](docs/vnext/architecture.md) for invariants, data models, transaction protocol, and acceptance matrix.

## Development and verification

```bash
npm ci
npm run check
npm test
```

Real-host tests must use an isolated SillyTavern data directory, port, and test chat. Never reuse a personal instance.

## License

[GNU AGPL-3.0](LICENSE)
