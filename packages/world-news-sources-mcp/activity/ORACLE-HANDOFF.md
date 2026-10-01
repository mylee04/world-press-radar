# Compatible Oracle handoff — October 1, 2026

Core is live at `https://news.bymyleslee.com/mcp` with seven read tools. This Mac is not running a timer. Initial tracking started `2026-10-01T01:36:12.370Z`; preserve it. Current production ledger: eight real collections, 335 unique URLs, four initialized endpoint/source bindings (US two, GB one, JP one). All other active countries remain untracked; these three countries are partial. Baseline NEW is zero, not 335. This is engineering proof, not a full production baseline.

## Exact safe transfer list

From the **pinned isolated-clone commit** returned in the completion message:

- `data/rss-atlas.json`
- `audits/readme_rss_health_latest.json` (historical fallback only)
- `packages/world-news-sources-mcp/{package.json,package-lock.json,tsconfig.json,README.md,.gitignore}`
- Package `src/`, `scripts/`, `test/`, `metrics/`, `site/`, `plugin/`
- Package `audits/health-latest.json`
- Package `activity/{README.md,ORACLE-HANDOFF.md,activity-snapshot.json,PRODUCTION-BASELINE-EVIDENCE.json,DEPLOYMENT-EVIDENCE.json}`
- Package `publication/{schemas/,PLATFORM-EVIDENCE.json}` only if plugin validation is run. These are public listing/review metadata; no browser state or credentials.

Outside Git, copy ONLY `activity/oracle-initial-2026-10-01.sqlite`, an SQLite `VACUUM INTO` backup, mode 600, **2,580,480 bytes**, SHA-256 **2692c0443cda9e569de969db7f39e4902acd8ac326df0d6e1a2e0335677b478e**. It has no secret or user-query data. Validate `PRAGMA integrity_check` and counts on VM before using it as the authoritative ledger. Keep the Mac source/backup intact; stop Mac writes after handoff. Do not initialize an empty ledger and inflate/restart the baseline.

Exclude `.git`, `.vercel`, `.env*`, `.npm`, Wrangler preferences, SSH files, token files, Library metadata, video/frames/screenshots/evidence, `node_modules`, generated hosted bundle and all other repository/application data. Never copy Mac Vercel/Cloudflare OAuth credentials. The VM's existing exact-project token stays VM-local. Preserve unrelated PostgreSQL and workloads.

## Cadence/cost correction and manual verification

The four-endpoint smoke is not a rotating production cadence. Production collector now defaults to **all due active endpoints** (limit 10,000), daily budget 12,000 attempts including transient retries, global concurrency two, per-host one and two-second gap. An initial active registry pass has 5,403 distinct typed endpoints. Subsequent successful endpoints become due next UTC day; failures back off up to seven days; indexes weekly. Backoff, blocked, unsupported/index-only and failed coverage remains explicit. No completeness is asserted for unobserved short-lived RSS entries between checks.

Allow roughly 40–120 minutes per full pass based on the earlier 5,775-endpoint audit and current small sample; measure the real VM run before choosing its daily slot. Large timeout/host-wait cases can take longer. SQLite URL+relationship pages measured about 2.1 KB/URL in this small sample; first entry-scale baseline may approach 1–3 GB. Verify existing free disk **before** activating; the soft DB+WAL budget is 8 GiB. If the VM cannot reserve that safely, report a concrete capacity constraint; do not delete unrelated files or buy/upgrade anything. No new paid resources or credentials are required by this architecture. Full history remains on VM; Vercel contains only a bounded event-time aggregate snapshot, preserving arbitrary IANA/DST/rolling windows.

After dependencies/build/tests and safe project link setup, run the initial manual compatible pipeline using the existing project token via `LoadCredential`:

```sh
WNS_DEPLOY_API=1 node scripts/refresh-activity.mjs --db /private/isolated/operator/activity.sqlite --limit 10000 --daily-budget 12000
```

The API adapter accepts exactly 24 generated upload files (current inline body 8,573,265 bytes), excludes local link/ignore files, adds `dist/activity.js` and `metadata/activity.json`, omits env/settings overrides, and saves ambiguous submission state without retrying POST. Local API tests pass; the **actual scoped-token deployment POST** remains to verify on VM. Mac production CLI deployment already passed live SDK+legacy initialize/list/call, all seven tools and real ledger snapshot timestamp comparisons. New-tool D1 inspection counters each recorded one successful verification call.

Only after manual collect→DB→export→API deploy→MCP smoke succeeds should the parent coordinate the daily activity timer and separate weekly full health audit. Both jobs must share the runner's overlap lock. The weekly `refresh-deploy.mjs` retains full health audit and scoped API support. Do not activate or deploy the superseded staged release.

ChatGPT refresh/reconnection is required to discover three new tools. Updated plugin ZIP validates locally; new natural-language review tests/demo and portal reupload remain pending. Old demo illustrates the original four tools only. Final directory submission and GitHub push remain held.

Final live deployment: `EmrBUiQ4dNZj8yxqbL5jxX6gEjpy`. Tests: 54/54; fresh HTTPS proof is `activity/LIVE-MCP-VERIFICATION.json`; France/pre-tracking null and New York/rolling24h proof is `activity/SCOPE-TIMEZONE-VERIFICATION.json`.
