# News Quality operations

The existing repository and `news.bymyleslee.com` MCP remain the product. The daily worker reads saved MCP records, stores its observations, and investigates only supported country decline signals. It never edits registrations, fetches publisher pages, invokes a paid model, deploys, or changes the article collector schedule.

## Run once

From `packages/world-news-sources-mcp`, after building the package:

```sh
npm run build
node scripts/quality-daily.mjs
```

Defaults: previous UTC day; current public MCP; complete registry pagination including disabled sources; at most five rules investigations; private records in `output/news-quality/daily`; SQLite history in `output/news-quality/history.sqlite`. Set `WNS_QUALITY_HISTORY_PATH` or `--history=/absolute/path/history.sqlite` to share the dashboard's history store.

An initial complete registry read establishes a baseline. Later differences show the observation interval, not a fabricated registration date. An incomplete or changing registry read does not replace that baseline. Missing collection cycles do not become completed cycles merely because the worker ran on a later day.

`--local` uses the package's saved activity files and registry. `--date=YYYY-MM-DD` selects a closed UTC day. `--no-investigate` records statistics only. `--no-registry` skips registry observation. `--max-investigations=1` further limits work. `--rerun` creates another immutable report for an already reported day. Paid engines are deliberately not accepted by this CLI.

The daily receipt prevents duplicate successful runs for the same date and configuration. Partial reports are retained and may be retried. Each report records its snapshot time, scope, actual investigations, errors, and zero model calls. “Completed” describes the report execution; it is not proof of collector completion or live publisher recovery.

## Prepare a daily schedule

```sh
node scripts/install-quality-schedule.mjs --target=launchd
node scripts/install-quality-schedule.mjs --target=systemd
node scripts/install-quality-schedule.mjs --target=cron
```

These commands only generate definitions in `output/news-quality/schedule`. They install nothing. Each definition dispatches hourly; the worker starts one daily report after 09:00 UTC and returns immediately after that date's receipt exists. UTC gating avoids local daylight-saving ambiguity and gives the existing early-morning collection time to finish. This does not assert that the collection actually completed.

For a reviewed definition, `--apply` installs only the new dedicated launchd job on macOS or systemd user timer on Linux. It refuses to overwrite or unload existing jobs. Cron output requires manual merging of its dedicated line; it never replaces the collector's crontab. A Mac launch agent runs while the owner is logged in and the machine is available; it is not an always-on cloud service. A systemd user timer also requires an active user service manager. Activation is a separate operation from preparing the definitions.

Check status with `launchctl print gui/$(id -u)/com.worldpressradar.quality-daily` or `systemctl --user status world-press-radar-quality.timer`. To stop only this job, use `launchctl bootout gui/$(id -u)/com.worldpressradar.quality-daily` or `systemctl --user disable --now world-press-radar-quality.timer`. Existing collector jobs are independent.

## Runtime limits and recovery

- The default stored SQLite size limit is 512 MiB across the database and WAL. Reaching it stops the worker; no history is automatically deleted and no paid storage is enabled.
- A process lock prevents concurrent daily reports. A crash may leave `.quality-daily.lock`. Check its PID and the previous report before removing a stale lock; an active process lock must not be removed.
- MCP pagination is bounded to 10,000 sources and 400 metadata calls. Registry capture checks duplicate IDs, pagination, source totals, and the provided registry marker before and after capture. The public MCP lacks a transactional snapshot token, so the observation is an interval and not an exact historic creation ledger.
- Model use remains a separate explicitly authorized investigation. The approved $5 comparison budget is a pilot limit, not a renewed daily allowance. Do not add paid calls to a timer using process-local budget resets. The shared persistent model budget must remain authoritative for any future paid automation.
- The worker's reports and SQLite files belong on private durable storage. Serve selected dashboard responses through the authenticated application; never expose the entire output directory as static files.

`PersistentModelBudget` now implements the shared pilot ceiling in SQLite, using a fixed authorization ID across OpenAI, Jev, repeated CLI calls and server restarts. `QualityRunStore` retains actual investigations, including interrupted state, without automatically restarting paid work. Configure the owner runtime's default history at `output/news-quality/history.sqlite` and its run/budget store at `output/news-quality/runtime.sqlite`.

The initial real remote observation is retained in `output/news-quality/ops-smoke/registry-baseline.json`: 5,404 normalized sources including disabled sources, observed October 13, 2026. Its exact `observed_at`, registry snapshot marker, typed IDs and URLs are preserved. A fresh default `QualityHistoryStore` can import it with `observeRegistry(payload)` without another network read. If a newer complete baseline already exists, respect the store's ordering checks instead of forcing this old observation over it.

## Production topology

The prepared Vercel configuration currently has 10-second functions and no durable process. Keep the existing public MCP and read-only dashboard there. A complete agent investigation can take longer and cannot safely rely on its process memory. The local Node runtime implements SQLite observations, retained investigation records, persistent budget reservations and an owner session. Cloud execution still needs a durable host and cloud-appropriate authentication. Keep model credentials only at that worker; the browser receives readiness, usage and completed results.

The existing Cloudflare worker stores aggregate MCP tool counters in D1. It has no quality read API or scheduled handler. These counters are not the source registry or article ledger. A future Cloudflare quality worker would need a reviewed schema migration, an authenticated read/write design, and an investigation transport appropriate to the Node Agents SDK; none is implied by the existing metrics binding.

Read-only preflight on 2026-10-13 confirmed the existing Vercel project identity, metrics environment keys, and production domains. No quality/OpenAI/TypeSafe runtime environment keys were present. The saved Cloudflare credential returned HTTP 401 for both the existing worker and D1 metadata. Restore that connection before attempting Cloudflare operations. No secret was copied or changed during these checks.

Both provider pilot calls have succeeded using the authorized $5 shared cap. TypeSafe account/key setup is complete; no additional account setup is a current blocker. Usage costs are estimates from reported tokens, not provider billing receipts. The daily worker remains rules only.

The prepared scheduler, worker and Vercel bundle require the separate activation/deployment step. Preparing definitions or bundles does not deploy, install a schedule or change a production source. Official replacement proposals apply only after individual approval; production rollout and subsequent authoritative collection are still required for production recovery.
