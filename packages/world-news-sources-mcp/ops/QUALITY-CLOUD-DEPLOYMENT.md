# Always-on quality application

The application uses the existing Oracle VM and the existing `news.bymyleslee.com` product. A dedicated Node service binds only to `127.0.0.1:3401`. The public HTTPS gateway serves read-only data; investigation and source changes require the separate manager authorization. Neither model keys nor the raw article ledger are available through static files.

## Code and persistent data

`scripts/prepare-quality-cloud.mjs` prepares an exact code whitelist: compiled JavaScript, three dashboard assets, package manifests and three operational scripts. It excludes every registry, audit, activity snapshot, SQLite database, history shard, `.env`, `.vercel`, SSH file and local operator record. SHA-256 and byte counts cover every bundled file. The destination must be new.

```sh
npm run build
node scripts/prepare-quality-cloud.mjs --revision quality-20261013 --output /private/staging/quality-20261013
```

Transfer that directory only. Its `quality-cloud-manifest.json` is the upload inventory. Do not upload the repository root or the previous local October 1 snapshot.

On Oracle, code releases belong in `~/.local/share/world-press-radar-quality-app/releases`, with a managed `current` link. Durable application state belongs in `~/.local/share/world-press-radar-quality/state`; each code update retains `history.sqlite`, `runtime.sqlite`, `daily/` and any repair evidence. The application reads the current collector package's registry, health audit, activity manifest and complete manifest-listed monthly history in place. Its authoritative ledger is the existing collector state's `activity.sqlite`; no copy or new ledger is initialized.

The actual absolute collector package, registry and database paths must be taken from the current installed runner. Its package activity manifest is authoritative if a post-collection smoke failure left a secondary state copy older. Check `generated_at` and every referenced history checksum before activation.

## Environment and installation

`~/.config/world-press-radar-quality/runtime.env` is an owner-only file containing approved flags and absolute file paths. Use [the example](quality-cloud-runtime.env.example) as a template; inspect its verified Oracle paths against the current runner. Secret values go in separately approved owner-only files, never in this environment file or a code bundle. Gateway and manager tokens have their own files. Missing manager credentials leave the public dashboard usable and prevent mutation/model execution.

The installer defaults to a read-only dry-run. All modes reject an unowned current link, unowned systemd unit, symlink bundle, unexpected bundle file, changed checksum, foreign data path, incomplete archive or environment secret. It reports timestamps and verification counts; it never prints environment contents or reads model key values.

```sh
node scripts/install-quality-cloud.mjs \
  --bundle /private/staging/quality-20261013 \
  --collector-package /home/ubuntu/.local/share/world-news-audit/current/packages/world-news-sources-mcp \
  --registry /home/ubuntu/.local/share/world-news-audit/current/data/rss-atlas.json \
  --activity-db /home/ubuntu/.local/share/world-news-audit/state/activity.sqlite \
  --state /home/ubuntu/.local/share/world-press-radar-quality/state \
  --env-file /home/ubuntu/.config/world-press-radar-quality/runtime.env
```

Add `--stage` to install an immutable app release with production dependencies using `npm ci --omit=dev --ignore-scripts`. JavaScript syntax checks run before a release marker is written. Staging starts no process and changes no scheduler. Repeat the same arguments with `--activate` only after inspecting that release. The installer validates the exact staged code and unit definitions before switching its link. It starts only these new app units:

- `world-press-radar-quality-web.service`: automatic failure restart and a 160-second graceful shutdown allowance for accepted investigations to settle.
- `world-press-radar-quality-daily.service`: `quality-daily --local --scheduled`, rules only, using the shared persistent history store.
- `world-press-radar-quality-daily.timer`: hourly dispatch, persistent catch-up, UTC 09:00 gate inside the worker. A saved daily receipt prevents duplicate successful reports.

The user service manager needs lingering enabled to operate after logout and at boot. Verify `loginctl show-user ubuntu -p Linger` and enable the existing user's lingering as a separate host operation if absent. The installer does not change host login policy. Verify the web unit, timer, loopback health route, proxied HTTPS read route and authorization rejection before declaring it live.

The existing collector's 03:00 UTC timer is independent and is never changed by this installer. The new daily-all-active policy and measured SQL reuse optimization require a separate collector code rollout against its existing authoritative state. Preserve its current registry, audit, ledger, monthly archive, pending spools, writer lease and timer definition. Take a consistent private SQLite backup before that rollout, then validate normal collection coverage, server deferrals and the exported snapshot. A prepared quality app is not evidence that this collector rollout happened.

## Budget, backup and rollback

Public reads and the daily job issue zero model calls. OpenAI and Jev remain disabled until cloud credential storage is approved and configured. The original pilot authorization is a shared **total $5**, not $5 per server/day/provider. Before enabling cloud model execution, migrate or reconcile the existing budget reservations and previously spent amount into its persistent budget. The installer rejects a higher limit and a new authorization ID. It does not copy local credentials or reset any budget.

Before replacing an existing quality release, stop its web and daily units, back up application SQLite databases consistently and retain those backups privately. SQLite backup APIs preserve committed WAL state; a live plain-file copy does not. Take code manifests and existing unit definitions with that record. Do not merge an old history backup over newer production observations.

The `.quality-activation.json` receipt records the actual previous release at activation and original unit checksums; replaced unit files are retained under the new release's `previous-units/`. Staging does not freeze a stale rollback target. A retry retains the initial activation receipt and original backups. On a failed activation, stop only the quality web/daily units, restore the `current` link to that recorded owned release, restore its unit definitions, reload the user manager and restart its web/timer. Keep persistent state and interrupted evidence. Do not automatically restore a database after the new release has accepted work; reconcile the saved backup and new observations first. No installer cleanup deletes an old release or private state.

Current verification: the operational safety tests cover fixed bundle exclusion, unchanged dry-run metadata/ledger/state, hash and symlink rejection, owner-only environment files, credential/env injection rejection, authoritative path and archive checks, unrelated unit preservation and shared budget limits. These tests use temporary fixtures, not the production ledger or live publishers.
