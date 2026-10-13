# News Quality Agent

This extends World Press Radar's existing news MCP. Harvard CS2680 inspired the tool design, result-dependent investigation loop, visible execution and reproducible quality/cost comparison. It does not claim completion of the course or its assignments.

The application has a minimal country dashboard, actual MCP investigations, an adaptive OpenAI agent, a Jev evidence classifier, durable observation/run/budget stores, and an approval-controlled local repair workflow. Rules are the default. Models inspect evidence; code owns counts, dates, deduplication and supported failure classifications.

## Start

```sh
cd packages/world-news-sources-mcp
npm ci --ignore-scripts
npm run quality:dashboard
# http://127.0.0.1:3000/quality/
```

The dashboard reads `https://news.bymyleslee.com/mcp` through its original seven read tools, defaults to the preceding UTC day, and displays the actual saved-data timestamp. It does not fetch publishers. The local MCP also exposes two quality tools. `quality:dashboard:local` uses local metadata; its checked-in October 1 snapshot must not be represented as newer production data. `WNS_PORT=3400` chooses another loopback port. Restart to reload local files.

The three views are collection quality, source holdings and investigations. Country names are Korean. US and China appear first, followed by the recorded nominal-GDP ordering. Scope, missing data and raw execution evidence sit behind expandable controls.

## Metrics

| Metric | Meaning |
| --- | --- |
| Attempt coverage | Distinct attempted typed endpoints / currently active typed endpoints |
| Success rate | Successful article endpoints / attempted endpoints |
| Freshness | Reliable content dates within the observed update cadence; null without enough comparable history |
| Holdings | Active/disabled registration rows and distinct active RSS/sitemap addresses, separately |
| Day / 7 days / 30 days | First-discovered candidate URLs after excluded initialization baselines, in the stated source/country scope |
| Registry changes | Differences between complete registry observations; actual creation/deletion dates may be unknown |

Successful zero discoveries are not a failure. Untracked, failed or unavailable periods stay null; partial weeks/months retain missing-day counts. Discoveries are not publication counts or the publisher's complete output. Country URLs are deduplicated within country; source totals cannot be summed without overlaps. Global endpoint counts use the global inventory.

Registration rows, normalized sources, typed endpoints and corporate publishers are different. Current publisher identity and independent per-endpoint discovery totals remain unavailable where the export lacks evidence. Names/domains are not substituted for publishers. Current holdings are not historic inventory, and first observation is never treated as registration time.

## Investigations

| Mode | Role |
| --- | --- |
| Rules | Bounded MCP reads and deterministic classification; no model cost |
| OpenAI | Agents SDK `Agent`/`Runner` selects subsequent read tools from their actual results and returns a structured proposal |
| Jev | TypeSafe choice questions classify retrieved endpoint evidence; conflicting or low-confidence decisions require review |

Every displayed tool result, time, error, token count and model request comes from actual execution. No hidden reasoning or invented sub-agent branches appear. This version runs one agent and has no sub-agent tree.

Rules inspect at most 12 sources and 48 MCP calls within 45 seconds, checking common/peer evidence first. OpenAI has four model calls, twelve application reads and a 120-second deadline, within the same MCP scope. Jev assesses at most twelve observed endpoints. Each run states its sample and available scope.

Classifications separate prior success followed by failure, recovery, dated stale content, access failure without a normal baseline, successful zero discoveries, sitemap-index-only output and insufficient evidence. Saved findings do not prove current failures. Multi-endpoint source activity is not attributed to an endpoint without independent evidence.

OpenAI can search country sources, read source quality, read observed endpoint health and compare saved country activity. It has no write tool, shell, handoff or unrestricted fetch. Proposals must reference inspected sources; unsupported failure proposals are rejected. Retrieved names, URLs and messages are untrusted evidence.

## Durable history and anomaly detection

`QualityHistoryStore` saves country metrics, complete registry observations and collector cycle evidence in SQLite. The first complete registry observation is a baseline. Later added/removed/reappeared/activated records describe observation intervals, leaving actual occurrence dates null. Partial lists and stale snapshots cannot establish registry changes.

The collector records planned, attempted and successful endpoint cohorts, completion state, content dates and date kind. Comparable production due cycles require the same country's UTC weekday and unchanged cohort, at least two independent day samples, and adequate prior attempt coverage. A review signal needs a fall of at least 15 percentage points and a value below 80% of baseline. Several eligible countries falling together trigger common-collector investigation first.

Older records and the current remote seven-tool aggregates lack these completed cohorts. Their baseline stays unavailable; a later observation date does not establish completion, and a missing baseline is not a healthy verdict. Freshness needs at least three reliable content-date advances with comparable inspections. HTTP success and old observations cannot certify current freshness. Feed item dates and sitemap `lastmod` remain different evidence kinds.

`QualityRunStore` retains actual events in SQLite. Request IDs recover accepted starts after a lost response and across restarts when persistence is configured. Interrupted runs become explicit failures and are never silently replayed. Two concurrent runs are allowed. In-memory-only embeddings retain at most 20 runs for one hour.

## Credentials and cost

The user approved a **$5 combined pilot cap for OpenAI and Jev**, not a renewed daily allowance. `PersistentModelBudget` shares conservative reservations across providers, processes and restarts. Uncertain failures retain reservations; a fixed authorization ID prevents budget renewal at restart.

The existing OpenAI key is read from its configured file in memory. The user prepared the TypeSafe account and locally stored key. Values never appear in browser responses, reports or deployment bundles. Credential files are parsed as literal assignments, never sourced as shell code. Both live provider pilot calls have succeeded. Readiness reflects configuration; it does not promise future API availability.

| Control | Purpose |
| --- | --- |
| `WNS_QUALITY_TOTAL_BUDGET_USD` | Shared authorized ceiling |
| `WNS_QUALITY_BUDGET_PATH`, `WNS_QUALITY_BUDGET_ID` | Durable budget location and fixed authorization |
| `WNS_OPENAI_KEY_FILE`, `WNS_JEV_KEY_FILE` | Credential file locations |
| `WNS_OPENAI_PAID_APPROVED`, `WNS_JEV_PAID_APPROVED` | Explicit provider gates |
| Provider `*_MODEL`, `*_TOTAL_BUDGET_USD`, `*_RUN_BUDGET_USD` | Model and provider/run limits |
| Provider `*_INPUT_USD_PER_MILLION`, OpenAI `*_OUTPUT_USD_PER_MILLION` | Rates for usage estimates |

Provider controls default off. Production secret setup is separate. Usage-derived costs are estimates, not billing receipts. Missing usage never becomes zero cost. Automatic model retries, remote tracing, sensitive SDK logging and OpenAI response storage are disabled. Paid execution and repair mutations require the loopback owner session and same-origin requests; that session is not cloud authentication.

## Approval-controlled repair

The operator selects a source, endpoint and publisher website. Bounded official-page feed declarations or `robots.txt` sitemap declarations produce validated XML candidates and an exact proposal. The operator must confirm website ownership; a declaration alone does not prove it.

Approval binds the proposal digest, registry hash, actor and session. Apply changes only the local registry and retains rollback evidence. Changed registries, expired validation, conflicting proposals and unauthenticated mutations are rejected. Model suggestions cannot apply changes. Local application is not production deployment.

Recovery requires a successful non-baseline collector observation after application plus newer reliable content dates. A valid candidate, HTTP success or first initialization collection is insufficient. Without collector evidence, verification explicitly waits. No actual publisher registration has been automatically replaced by the demos.

## Daily operation and evaluation

```sh
npm run quality:report -- --date=2026-10-12 --country=KR
node scripts/quality-daily.mjs
node scripts/install-quality-schedule.mjs --target=launchd
npm run quality:evaluate
npm run quality:evaluate -- --provider all --output /absolute/path/new-result.json
npm test
```

The daily worker saves country/registry observations and investigates at most five supported declines using **rules only**. Receipts prevent duplicate successful reports; partial runs are retryable. Scheduler definitions for launchd, systemd and cron are prepared, not activated. See [operations](ops/QUALITY-OPERATIONS.md).

Ten fixed synthetic English/Korean/Japanese cases compare exact-label agreement, false positives, missed failures, language results, actual time, reported usage and estimated costs. Providers use the same cases. Synthetic agreement is not general multilingual news accuracy. Rules have zero model cost; server cost is unmeasured. Live evidence is retained privately in `output/news-quality/`.

The October 13, 2026 comparison used `gpt-6-luna` and `jev-1.13.0`:

| Method | Exact labels | False findings / missed findings | Measured case time | Estimated API cost |
| --- | --- | --- | --- | --- |
| Rules | 10/10 | 0 / 0 | 0.75 s | $0 |
| Jev | 9/10 | 2 / 0 | 1.44 s | $0.000611352 |
| OpenAI | 9/10 | 0 / 0 | 14.41 s | $0.0010334 |

Exact labels by language were rules 3/3 English, 4/4 Korean, 3/3 Japanese; Jev 3/3, 3/4, 3/3; OpenAI 2/3, 4/4, 3/3. Jev's two false findings also violated the evidence contract, despite some classification labels being correct. Keep rules as the default, use OpenAI for additional evidence-driven reads, and treat Jev as a review candidate behind code agreement/confidence checks. Ten synthetic cases do not establish production accuracy or justify automatic model-only repairs.

## Production state

The existing repository and original working-tree changes are preserved. The current Vercel configuration has 10-second functions and no durable process. Prepared hosted views keep investigations/mutations disabled. A full cloud agent needs authenticated durable execution, persistent run/budget storage and a reviewed UI connection. The existing Cloudflare D1 holds tool counters; its saved credential returned 401 at preflight.

Daily activation, cloud execution hosting/authentication, production secret locations and rollout remain separate from local implementation. Authoritative completed-cycle and freshness history must accumulate; historic completion is not backfilled. Each official replacement still needs explicit approval and post-apply collection before claiming recovery.

## Verified integration run — 2026-10-13

The actual OpenAI investigation completed with 13 MCP calls, three model calls and three inspected Korean sources. Jev completed with 34 MCP calls, twelve model calls and twelve inspected sources. These are partial country investigations, not whole-country health certifications. Invalid model proposals are recorded and excluded from accepted proposals; model summaries remain unverified.

Total provider-reported usage estimates for the pilots, comparison and integration debugging were $0.009963582 against the shared $5 cap. Provider billing receipts were not available. The final suite passed 212 tests. Original checkout fingerprints remained unchanged for all 15 pre-existing dirty/untracked files.

Read-only cloud preview: https://world-news-sources-mmbxxj7gx-mylee04s-projects.vercel.app/quality/. Vercel reports Ready. Local bundle validation returned 73 countries from the actual saved MCP report in 7ms. Production was not promoted. Cloud investigation hosting/authentication, durable remote storage, credential destination approval and daily scheduler activation remain operational requirements.

TypeSafe integration follows the official [agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), HTTP API and Choice documentation. The skill was read directly; no global skill installation was required.
