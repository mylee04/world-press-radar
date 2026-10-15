# Existing Oracle collector release

`prepare-collector-release.mjs` creates a hashed code-only package. It excludes the registry, audits, activity ledger, operator state, credentials and deployment credentials. A fixed set of recorded public expansion fixtures is included for offline tests.

`install-collector-release.py` stages a release beside the existing one and copies current public metadata exclusively from that Oracle release. It verifies complete manifest-listed history shards, installs the locked dependencies with lifecycle scripts disabled, and runs typechecking and tests. Validation subprocesses cannot inherit provider keys, provider approvals, application state or a Vercel token.

Staging takes the existing activity/health `state/run.lock` and requires idle services. It does not open the authoritative ledger for writing, replace `current`, collect from publishers or deploy anything.

Activation is a separate `--activate` operation, after the staged code and rollout have been approved. It requires the exact expected previous release, unchanged public metadata and unchanged timer files. It takes a consistent retained SQLite backup and validates it with `quick_check`, or verifies a previously created rollout backup against its receipt, both SHA256 hashes, an empty source WAL, counts, first/last checks, original tracking start and every binding baseline. Existing backups are never rotated or deleted by this installer.

Only then does activation run `collect-activity.mjs --export-only` against the existing authoritative ledger. Its schema additions are compatible with the prior collector. Counts, discovery boundaries and baseline timestamps must remain unchanged, the complete archive must contain every stored check, and current metadata hashes are rechecked immediately before an atomic `current` symlink replacement. No publisher or paid model request occurs.

The existing runner resolves `current` **after** taking the shared lock. Thus a scheduled job waiting for activation uses the new release. Release staging and activation leave the existing timer files and operator-owned `run-compatible.sh` unchanged: daily collection at 03:00 UTC, weekly health audit at Saturday 23:00 UTC. Cloud application data paths must follow this same stable `current` symlink. Persistent Vercel project environment settings supply the quality gateway; the new preparation and deployment scripts retain the dashboard and gateway on subsequent daily deployments.

The October 15 operator update adds a 50 GiB disk floor to that existing wrapper without changing timers, collection identity or locking. Before backup it also reserves the logical SQLite backup size and 2 GiB growth; post-backup and post-pipeline checks retain the floor. See [the completed recovery record](QUALITY-OPERATIONS.md#disk-recovery-and-completed-daily-collection--october-15-2026) and [the standalone read-only guard](runner-disk-floor.py). Release staging/activation does not install or modify this operator-owned wrapper or guard.

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

After final release verification:

```sh
python3 BUNDLE/packages/world-news-sources-mcp/scripts/install-collector-release.py \
  --bundle BUNDLE --expected-current PREVIOUS_RELEASE --activate \
  --backup-receipt RETAINED_ROLLOUT_BACKUP_RECEIPT.json
```

Omit `--backup-receipt` to create a fresh retained backup during activation. A changed source fingerprint, active collector, pending spool, incomplete history, changed metadata or changed timer stops activation without moving `current`.

## Rollback

The activation receipt records the previous release, retained backup, registry digest, unchanged ledger evidence and timer digests. To restore code, acquire the same `state/run.lock`, require both collector services to be idle, verify the activation receipt and that `current` still names its new release, then atomically replace it with a symlink to the recorded previous release. Do not change timers or restore the old SQLite backup after new collections have occurred: that would discard real subsequent observations. The ledger's additional tables/indexes are compatible with the previous collector. Keep the new release and its receipt for diagnosis.

A successful pointer change does not establish whole-cycle speed or coverage. Inspect the next real scheduled cycle and functional MCP history after deployment; server deferrals and failures remain explicit partial coverage.
