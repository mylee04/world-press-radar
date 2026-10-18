# Existing Oracle collector release

## Current storage policy, October 17, 2026 (Chicago)

The owner explicitly disabled news data backups and authorized permanent removal of all files under the existing Oracle `backups` directory. On October 18 at 03:15:50 UTC, 76 backup files using 69,377,105,920 allocated bytes were deleted, including prior compressed copies. This was deletion, not compression or relocation; those recovery copies are no longer available. The authoritative ledger, baseline/tracking state, retained article history, registry, current release and timer definitions remained unchanged through cleanup.

Regular activity and health runs now create no full database copy. Under the existing shared lock, the installed operator wrapper requires 52 GiB free before work (the 50 GiB floor plus 2 GiB growth), then checks the 50 GiB floor before copying the secondary metadata snapshot and at final completion. The existing backup directory is empty and mode `0500`, so ordinary writes by the runner account are refused. `state/storage-policy.json` records `owner_requested_data_backups: false` and `recurring_full_db_backups: false`. Do not change directory permissions, create an alternative backup destination or add API-triggered backup creation to bypass this policy. A future backup policy change requires the owner's explicit instruction.

The legacy installer activation path below has not gained a no-backup option. Its normal backup creation, or verification of a deleted retained backup, will fail closed under this policy. Staging remains available; do not run legacy activation or change permissions to make it succeed. A future code-only rollout must first have its no-copy activation procedure independently reviewed while preserving the live ledger, full retained history, baselines, registry, private repair records and timers. No new CLI flag is implemented or implied here.

The daily service resumed once at October 18 03:16:26 UTC and exited successfully at 04:18:16 UTC. The published plugin serves its 04:02:37.416 UTC activity snapshot. Saved daily observations contain no repeated endpoints, and all previously initialized binding baselines remain unchanged. Future invocations use an explicit 16 GiB DB-plus-WAL threshold and bounded capacity reports.

A separately reviewed narrow code-only procedure activated `storage-cooldown-safe-20261018` at 04:20:54 UTC without a database copy, export or public deployment. It preserved complete metadata/history, audit journals, baseline/tracking state, private quality state and existing timers. The change makes weekly checks respect existing durable production host cooldowns, including redirects. Completed local full-suite checks were reused; runner staging performed typechecking and the 10 affected runtime tests, while the original weekly pipeline retains its required full suite. The weekly service resumed once at 04:20:57 UTC with `2026-10-18-oracle` and exited successfully at 04:49:47 UTC. Its audit attempted 5,856 of 5,869 endpoints with 13 preserved skips; it must not be labeled a fully attempted audit. This narrow procedure does not add a no-backup flag to the general installer. See [the recovery record](QUALITY-OPERATIONS.md#owner-authorized-backup-removal-and-no-backup-policy-october-17-2026-chicago).

## Release preparation and historical activation contract

`prepare-collector-release.mjs` creates a hashed code-only package. It excludes the registry, audits, activity ledger, operator state, credentials and deployment credentials. A fixed set of recorded public expansion fixtures is included for offline tests.

`install-collector-release.py` stages a release beside the existing one and copies current public metadata exclusively from that Oracle release. It verifies complete manifest-listed history shards, installs the locked dependencies with lifecycle scripts disabled, and runs typechecking and tests. Validation subprocesses cannot inherit provider keys, provider approvals, application state or a Vercel token.

Staging takes the existing activity/health `state/run.lock` and requires idle services. It does not open the authoritative ledger for writing, replace `current`, collect from publishers or deploy anything.

The legacy activation implementation is a separate `--activate` operation, after the staged code and rollout have been approved. It requires the exact expected previous release, unchanged public metadata and unchanged timer files. It takes a consistent retained SQLite backup and validates it with `quick_check`, or verifies a previously created rollout backup against its receipt, both SHA256 hashes, an empty source WAL, counts, first/last checks, original tracking start and every binding baseline. This historical backup requirement conflicts with the current owner-disabled backup policy, so that activation path must not be used unchanged. The installer does not rotate or delete backups itself.

Only then does activation run `collect-activity.mjs --export-only` against the existing authoritative ledger. Its schema additions are compatible with the prior collector. Counts, discovery boundaries and baseline timestamps must remain unchanged, the complete archive must contain every stored check, and current metadata hashes are rechecked immediately before an atomic `current` symlink replacement. No publisher or paid model request occurs.

The existing runner resolves `current` **after** taking the shared lock. Thus a scheduled job waiting for activation uses the new release. Release staging and activation leave the existing timer files and operator-owned `run-compatible.sh` unchanged: daily collection at 03:00 UTC, weekly health audit at Saturday 23:00 UTC. Cloud application data paths must follow this same stable `current` symlink. Persistent Vercel project environment settings supply the quality gateway; the new preparation and deployment scripts retain the dashboard and gateway on subsequent daily deployments.

The October 15 operator update originally added a 50 GiB disk floor to that existing wrapper without changing timers, collection identity or locking. Its old pre-backup reservation has been superseded by the current 52 GiB no-copy preflight described above; pre-copy and postflight still retain the 50 GiB floor. See the historical [completed recovery record](QUALITY-OPERATIONS.md#disk-recovery-and-completed-daily-collection--october-15-2026) and the updated [standalone read-only guard](runner-disk-floor.py). Release staging/activation does not install or modify this operator-owned wrapper or guard.

## Commands

Prepare the code-only package after a successful build:

```sh
node scripts/prepare-collector-release.mjs --output /private/new-code-bundle --revision daily-quality-YYYYMMDD-REVISION
```

Transfer only that bundle to the existing runner's `prepared` directory. On Oracle, stage with the exact existing release path:

```sh
python3 BUNDLE/packages/world-news-sources-mcp/scripts/install-collector-release.py \
  --bundle BUNDLE --expected-current PREVIOUS_RELEASE
```

Historical activation syntax, currently blocked by the no-backup policy:

```sh
python3 BUNDLE/packages/world-news-sources-mcp/scripts/install-collector-release.py \
  --bundle BUNDLE --expected-current PREVIOUS_RELEASE --activate \
  --backup-receipt RETAINED_ROLLOUT_BACKUP_RECEIPT.json
```

Do not omit `--backup-receipt` to work around a missing deleted backup: that would attempt a new full database backup and conflicts with the current policy. Do not restore directory write permissions to enable it. A changed source fingerprint, active collector, pending spool, incomplete history, changed metadata or changed timer also stops activation without moving `current`.

## Rollback

Historical activation receipts record the previous release, then-retained backup, registry digest, unchanged ledger evidence and timer digests. Their backup references no longer prove that a recovery copy exists after the owner-authorized deletion. To restore code, acquire the same `state/run.lock`, require both collector services to be idle, verify the activation receipt and compatibility with the current ledger, verify that `current` still names its new release, then atomically replace it with a symlink to the recorded previous release. Do not change timers or roll the ledger back after new collections have occurred: that would discard real subsequent observations. Keep the new release and its receipt for diagnosis. Data recovery from the deleted backup files is unavailable.

A successful pointer change does not establish whole-cycle speed or coverage. Inspect the next real scheduled cycle and functional MCP history after deployment; server deferrals and failures remain explicit partial coverage.

## URL storage format 2 activation

On October 18, code-only release `url-storage-v2-20261018` reused the no-copy staging and activation checks, with typechecking and only the 28 affected activity/storage tests. It retained complete metadata/history and audit journals and did not run another collection or public deployment. Once compatible code was active, an explicit maintenance operation under the existing shared lock converted and compacted the authoritative ledger. All canonical URL/relationship fields were checked before replacement; every non-URL table fingerprint and the public snapshot matched afterward. See [the format contract, maintenance command and measured result](URL-STORAGE.md). Older format-1-only collectors must not be restored over the converted ledger. The general installer still has no no-backup activation flag.
