# Lossless activity URL storage

Format 2 keeps each exact canonical URL in `urls`, with an integer primary key. `scope_urls`, `endpoint_urls` and `binding_urls` refer to that integer instead of repeating the URL string. Their composite primary keys use `WITHOUT ROWID`, avoiding a second copy of each relationship key. URL normalization, collection IDs, first/last discovery dates, scope baselines and source/country NEW rules are unchanged.

New ledgers use format 2. Existing format 1 ledgers remain readable and writable by the new collector until explicitly migrated. Opening a ledger does not silently convert it. Public snapshots and retained monthly history keep their existing format.

## Offline conversion

Activate a collector that supports both formats before conversion. Require the existing activity and health services to be idle, hold their shared `state/run.lock`, and require no writer lease or pending JSON spool. The CLI refuses a missing, empty, linked, unknown or mixed-format ledger. It reserves no disk space, but requires the 50 GiB floor plus a conservative temporary-space allowance before conversion and compaction. Other filesystem writers can still consume space.

Preview is read-only:

```sh
node scripts/migrate-activity-url-storage.mjs --db /absolute/path/activity.sqlite
```

Under the operator's existing exclusive lock and idle-service checks, convert and reclaim freed pages:

```sh
node scripts/migrate-activity-url-storage.mjs --db /absolute/path/activity.sqlite --apply --vacuum
```

The conversion copies all four URL tables inside one SQLite transaction. It maps exact stored strings without normalizing them again, verifies row counts and every mapped field with indexed joins, then replaces the old tables. A conversion failure rolls back the schema and rows. Collections, metadata, bindings, request budgets, cycles, recovery records and cooldowns are not rewritten. The command does not collect, export, deploy, expire history or create a data backup. SQLite's temporary transaction/WAL files remain necessary for atomicity.

Compaction runs after the conversion commits. If that later step fails, format 2 may already be committed: inspect `storage_version` and `conversion_committed` in the error before recovery. Keep compatible collector code active. Reapplying to format 2 does not repeat conversion; explicit compaction can be retried under the same maintenance checks. Do not restore an older collector that only understands format 1.

## Focused verification

The affected activity, storage, migration and reopen/spool tests cover exact historical fields, baseline exclusion, country/source deduplication, replay, rollback, mixed-schema refusal, unchanged snapshots and actual disk reduction on a bounded repeated-URL fixture. The migration command also passed preview, apply, compaction and idempotent-repeat checks. No unrelated full suite is required for this change.

Operational savings must be measured after actual compaction. A smaller fixture does not establish a production saving rate or guarantee future growth. The existing 16 GiB planning threshold, capacity reports and 52/50 GiB disk checks remain applicable.

## Applied on Oracle, October 18, 2026

The existing authoritative ledger was converted in place under the shared runner lock and compacted at `2026-10-18T05:11:26Z` (00:11 CDT). Its size fell from 6,575,132,672 to 2,696,220,672 bytes: 6.12 GiB to 2.51 GiB, a measured 58.99 percent reduction (3.61 GiB reclaimed). All 2,772,499 canonical URLs and all 5,880,921 scope, 3,150,112 endpoint and 3,189,920 binding relationships were mapped and checked before the old layout was removed.

Before/after fingerprints of every non-URL table matched, including all 81,326 collection observations, original metadata, binding baselines, cycles, request budgets and recovery state. The retained public snapshot was byte-identical. The published plugin returned the same United States UTC October 18 activity: 2,781 newly discovered candidate URLs, unchanged tracking start and 81,326 retained observations. There were no publisher requests, new collections, expired records or data backups. The WAL and pending spool were empty at completion, with about 98.4 GiB free. The existing timers, 16 GiB collector threshold and no-backup policy remain in place.

Code-only release `url-storage-v2-20261018` passed typechecking and the 28 affected runtime tests on Oracle. Only affected checks were used locally and on the runner; no full suite or public-site deployment was added for this storage change. Future daily growth must be measured from real post-conversion cycles; the one-time reduction does not establish a new daily growth rate.

## First scheduled-cycle notification

Oracle runs `world-news-first-v2-monitor.timer` independently of Codex or the owner's computer. It checks every ten minutes for the existing activity timer's October 19, 2026 03:00 UTC run (October 18 at 22:00 Chicago). User lingering is enabled. The original collection service, timer and wrapper are unchanged. Before that run, the monitor only reads service state. It does not trigger collection, tests, deployment, compaction, backups or source changes.

After the service finishes, `first-v2-collection-monitor.py` opens SQLite in read-only mode and checks the saved binding baseline fingerprint, tracking start, previous observation boundary, format 2 schema, writer/spool state and the runner's existing completion receipt. It reads at most 10,000 observations through the date index, matches the target cycle's distinct attempts and successes, and verifies baseline source/country exclusion. A covering country discovery index independently checks US NEW. The public MCP query then checks the previous and new US UTC days against the saved observations. Partial cycles, index-only results, explicit zero and untracked/null retain their existing meaning. This is a bounded operational check, not a fresh full-history integrity audit or a publisher crawl.

Growth uses matching before/after samples for this activity run, including DB and WAL. Missing or mismatched samples fall back to a clearly labeled cumulative difference from the saved post-migration baseline. Filesystem free space is reported separately. A single cycle does not establish a monthly growth rate.

The owner connected the existing Telegram bot's private conversation. Its token and destination are held in `/home/ubuntu/.config/world-news-audit/telegram-notify.json` with mode 0600 and loaded through systemd credentials. No channel destination is accepted. Oracle sent a setup notification successfully and receipt was verified in Telegram. Four targeted tests cover service timing, observation/baseline checks, public freshness and zero/null semantics, and storage sample matching. The first future scheduled run itself remains pending.

The baseline and bounded result/delivery receipts live under `operations/url-storage-v2-20261018`. Successful Telegram delivery creates `telegram-delivery.json`, prevents another send and disables this one-time timer. While a collection is running, no progress messages are sent. A failed or missing run, verification discrepancy, or public snapshot still stale after ten hours produces an attention notification instead of a completion claim. Temporary public request failures are retried without rerunning collection; delivery errors leave the result available for a later timer attempt. The former app-dependent Codex heartbeat `url` is paused to avoid overlapping follow-ups. General storage-budget warnings are still JSON/log reports; this monitor only follows the first format 2 scheduled cycle.
