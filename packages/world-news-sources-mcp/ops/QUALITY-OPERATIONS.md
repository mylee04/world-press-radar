# News Quality operations

The existing repository and `news.bymyleslee.com` MCP remain the product. The daily worker reads saved MCP records, stores its observations, and investigates only supported country decline signals. It never edits registrations, fetches publisher pages, invokes a paid model, deploys, or changes the article collector schedule.

The collection policy is a separate component. Its implemented default targets all active addresses daily with six global workers (maximum sixteen), one in-flight request per host and a two-second host gap. Each HTTP attempt has an eight-second deadline and at most three redirects; at most one transient retry is permitted. The default 12,000 daily request budget includes HTTP-hop reservations, redirects and retries. 429 and server `Retry-After` waiting are respected and recorded as deferred/partial coverage. This policy is installed on the authoritative Oracle runner after 315 tests. Its rollout verified 5,416 active typed targets. After the approved [major-country source addition](../expansion/major20-20261014/README.md), the current registry contains 5,458 active typed targets, within a 10,000-target limit, six workers and the 12,000-request cap. The existing 03:00 UTC timer is unchanged; the next run is October 14, 2026.

## Run once

From `packages/world-news-sources-mcp`, after building the package:

```sh
npm run build
node scripts/quality-daily.mjs
```

Local CLI defaults: previous UTC day; current public MCP; complete registry pagination including disabled sources; at most five rules investigations; private reports in `output/news-quality/daily`; history in `output/news-quality/history.sqlite`. Set `WNS_QUALITY_HISTORY_PATH` or `--history=/absolute/path/history.sqlite` to share the dashboard history. `--runtime=/absolute/path/runtime.sqlite` or `WNS_QUALITY_RUNTIME_PATH` also stores actual investigations in the dashboard run store. Oracle uses `--local` with its authoritative current exports and private persistent paths.

An initial complete registry read establishes a baseline. Later differences show the observation interval, not a fabricated registration date. An incomplete or changing registry read does not replace that baseline. Missing collection cycles do not become completed cycles merely because the worker ran on a later day.

`--local` uses the package's saved activity files and registry. `--date=YYYY-MM-DD` selects a closed UTC day. `--no-investigate` records statistics only. `--no-registry` skips registry observation. `--max-investigations=1` further limits work. `--rerun` creates another immutable report for an already reported day. Paid engines are deliberately not accepted by this CLI.

The daily receipt prevents duplicate successful runs for the same date and configuration. Partial reports are retained and may be retried. Each report records its snapshot time, scope, actual investigations, errors, and zero model calls. “Completed” describes the report execution; it is not proof of collector completion or live publisher recovery.

## Active Oracle schedule

The installed cloud web service is `world-press-radar-quality-web.service`. Its separate `world-press-radar-quality-daily.timer` dispatches hourly with persistent catch-up; the rules-only worker starts after 09:00 UTC for the preceding closed UTC day. A receipt prevents duplicate successful reports. `Linger=yes` keeps the user manager active after logout and at boot. The collector retains its independent 03:00 UTC timer.

```sh
systemctl --user is-active world-press-radar-quality-web.service world-press-radar-quality-daily.timer
systemctl --user list-timers world-press-radar-quality-daily.timer
systemctl --user start world-press-radar-quality-daily.service
journalctl --user -u world-press-radar-quality-daily.service --since today
```

A manual start uses the same UTC gate and receipt checks; it does not force another completed report. To stop quality dispatch only, use `systemctl --user disable --now world-press-radar-quality-daily.timer`. To restart the web worker after a verified collector release switch, use `systemctl --user restart world-press-radar-quality-web.service`. These commands do not alter collector jobs. [Cloud deployment](QUALITY-CLOUD-DEPLOYMENT.md) describes verified immutable staging, activation, rollback and private state.

## Optional local schedule generators

```sh
node scripts/install-quality-schedule.mjs --target=launchd
node scripts/install-quality-schedule.mjs --target=systemd
node scripts/install-quality-schedule.mjs --target=cron
```

These commands only generate definitions in `output/news-quality/schedule`. They install nothing. Each definition dispatches hourly; the worker starts one daily report after 09:00 UTC and returns immediately after that date's receipt exists. UTC gating avoids local daylight-saving ambiguity and gives the existing early-morning collection time to finish. This does not assert that the collection actually completed.

For a reviewed definition, `--apply` installs only the new dedicated launchd job on macOS or systemd user timer on Linux. It refuses to overwrite or unload existing jobs. Cron output requires manual merging of its dedicated line; it never replaces the collector's crontab. A Mac launch agent runs while the owner is logged in and the machine is available; it is not an always-on cloud service. A systemd user timer also requires an active user service manager. These optional generators are separate from the already installed Oracle cloud units.

Check status with `launchctl print gui/$(id -u)/com.worldpressradar.quality-daily` or `systemctl --user status world-press-radar-quality.timer`. To stop only this job, use `launchctl bootout gui/$(id -u)/com.worldpressradar.quality-daily` or `systemctl --user disable --now world-press-radar-quality.timer`. Existing collector jobs are independent.

## Runtime limits and recovery

- The daily history size limit defaults to 512 MiB across `history.sqlite` and its WAL. Reaching it stops the worker; no history is automatically deleted and no paid storage is enabled.
- A process lock prevents concurrent daily reports. A crash may leave `.quality-daily.lock`. Check its PID and the previous report before removing a stale lock; an active process lock must not be removed.
- MCP pagination is bounded to 10,000 sources and 400 metadata calls. Registry capture checks duplicate IDs, pagination, source totals, and the provided registry marker before and after capture. The public MCP lacks a transactional snapshot token, so the observation is an interval and not an exact historic creation ledger.
- Model use remains a separate explicitly authorized investigation. The approved $5 comparison budget is a pilot limit, not a renewed daily allowance. Do not add paid calls to a timer using process-local budget resets. The shared persistent model budget must remain authoritative for any future paid automation.
- The worker's reports and SQLite files belong on private durable storage. Serve selected dashboard responses through the authenticated application; never expose the entire output directory as static files.

`PersistentModelBudget` shares one fixed pilot authorization across OpenAI, Jev, repeated CLI calls and server restarts. `QualityRunStore` retains actual investigations and their original process owner. Web restart reconciliation fails dead-owner or legacy interrupted runs without replaying paid work; it preserves runs owned by a live daily process. The daily process shares the run store without taking the web lease or reconciling interactive runs. Local defaults are `output/news-quality/history.sqlite` and `runtime.sqlite`; Oracle keeps both under `/home/ubuntu/.local/share/world-press-radar-quality/state`.

The initial real remote observation is retained in `output/news-quality/ops-smoke/registry-baseline.json`: 5,404 normalized sources including disabled sources, observed October 13, 2026. Its exact `observed_at`, registry snapshot marker, typed IDs and URLs are preserved. A fresh default `QualityHistoryStore` can import it with `observeRegistry(payload)` without another network read. If a newer complete baseline already exists, respect the store's ordering checks instead of forcing this old observation over it.

## Production topology and acceptance

The existing Vercel project serves public MCP metadata, the minimal dashboard assets and the quality API gateway. The gateway forwards to the existing Oracle nginx HTTPS route, which reaches a Node worker bound only to `127.0.0.1:3401`. History, runs and model-budget reservations stay in private durable SQLite outside immutable code releases. No private ledger, model credential or operator output directory is uploaded to Vercel.

Anonymous access is read-only: statistics and sanitized completed investigations. Every investigation start, including rules, and every proposal/approval/application action require the separate administrator credential and a same-origin request. The encrypted gateway credential is server-only and cannot authenticate an administrator. Browser login issues an eight-hour signed Secure/HttpOnly/SameSite=Strict cookie. Public result projection removes credentials, internal paths, session/request identifiers and stack traces.

The user approved the existing model keys at `/home/ubuntu/.config/world-press-radar-quality/model-secrets.env`, mode 0600. `runtime.env` contains paths and flags only. The combined **$5 total** pilot authorization was migrated with prior reservations retained; the old local allowance is sealed. Provider calls remain explicit administrator actions. The daily timer always uses rules and zero model calls. Earlier local provider pilots and subsequent cloud OpenAI/Jev investigations succeeded. The shared usage estimate after cloud acceptance is $0.013497892 of $5. Reported-token costs are estimates, not billing receipts.

The public [dashboard](https://news.bymyleslee.com/quality/) passed actual browser acceptance on October 13, 2026. The web service and dedicated daily timer are active with `Linger=yes`. Rules completed 27 tool calls across 12 sources with no model call; OpenAI completed 6 tool calls across 3 sources and 3 model calls; Jev completed 27 tool calls across 12 sources and 12 model calls. These are bounded Korean investigations, not complete country checks. Actual anonymous start/proposal requests returned 403. The final root suite passed 316 tests. The corrected daily CLI entry point passed 11 regression tests. Its first actual report for October 12 UTC completed at `2026-10-13T22:54:06.610Z`, with a durable receipt, systemd result `success`, exit 0, zero model calls/cost and no errors. It established the initial registry observation baseline and ran no investigation because there was no supported decline baseline. Missing historical collector cycles were not backfilled. Acceptance completed at `2026-10-13T22:56:07.698091Z`: a second daily start retained the identical receipt, and a web restart preserved all three completed run IDs/payload hashes plus budget/reservation hashes. Web health and the daily timer remained active. The verification record is retained privately in `output/news-quality/cloud-final-persistence-verification.json`.

The existing Cloudflare D1 stores independent MCP tool counters. Its earlier credential preflight returned 401; the Oracle quality architecture does not depend on that connection. Missing usage acknowledgments may produce explicit `status: degraded` in post-deploy activity verification. MCP functionality, protocol/data identity and exported history remain strict; degraded usage counters are neither failed article collection nor complete usage statistics. Standalone HTTP smoke remains strict unless `--allow-metrics-degraded` is supplied.

Collector activation retained the current registry, audits, authoritative SQLite ledger, monthly shards, pending spools, tracking baseline, URL identities and existing timers. The local October 1 snapshot did not replace newer production history. Use [collector rollout](COLLECTOR-ROLLOUT.md) and the [activity checklist](../activity/README.md#deployoracle-handoff) for later updates. The first normally scheduled collection under the new policy is October 14 at 03:00 UTC; completed-cohort and freshness baselines must accumulate from real future observations. Each official replacement still needs individual approval and authoritative post-application collection before claiming recovery.

## October 14 source and baseline update

The approved major-country batch added 33 registrations and 42 unique typed addresses to 16 existing countries. Actual Oracle initialization succeeded for 41 addresses; Linkiesta’s news sitemap returned 403 while its RSS succeeded. The failed sitemap retains a live failed observation and uninitialized binding. Old collection records, canonical URLs, binding baselines and full-audit metadata were verified unchanged. The initial 7,531 returned canonical URLs remain excluded baselines rather than NEW articles.

The quality application release `quality-country-baseline-ready-20261014` compares completed country cohorts within a terminal globally partial cycle when another country caused the partial result. It excludes an affected country with unattempted/deferred addresses, and excludes failed, running or explicit selected-address cycles. Readiness checks allow a bounded five-second cold metadata read on the shared VM. All actual rules/OpenAI/Jev records and the fixed combined $5 budget remain durable; this batch uses zero paid calls.

A real Italian rules investigation completed 29 cached MCP tool calls across 12 of 110 active sources. It distinguished Linkiesta’s successful RSS with zero baseline NEW from its sitemap access failure without a prior normal baseline; it did not label Italy as stopped. The first full daily_all_active scheduled cycle is still pending at this update’s verification time. Long-term false-positive/false-negative accuracy needs real comparable weekday/cohort data and adjudicated examples. The existing cloud daily job retains real cycle evidence and investigates supported drops without another crawl or paid model. Existing source modifications still require individual manager approval.
