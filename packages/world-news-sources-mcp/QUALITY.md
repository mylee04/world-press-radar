# News Quality Agent

This extends World Press Radar's existing news MCP. Harvard CS2680 inspired the tool design, result-dependent investigation loop, visible execution and reproducible quality/cost comparison. It does not claim completion of the course or its assignments.

The application has a minimal country dashboard, actual MCP investigations, an adaptive OpenAI agent, a Jev evidence classifier, durable observation/run/budget stores, and an approval-controlled registry repair workflow. Rules are the default. Models inspect evidence; code owns counts, dates, deduplication and supported failure classifications.

The implementation stays in TypeScript/Node.js. The user excluded Rust migration from the project plan on October 13, 2026.

## Start

```sh
cd packages/world-news-sources-mcp
npm ci --ignore-scripts
npm run quality:dashboard
# http://127.0.0.1:3000/quality/
```

The local default reads `https://news.bymyleslee.com/mcp` through its original seven read tools. The cloud worker reads the authoritative Oracle registry, health and activity exports, including completed-cycle evidence when present. Both default to the preceding UTC day and display the actual saved-data timestamp; dashboard reads do not fetch publishers. `quality:dashboard:local` uses local metadata; its checked-in October 1 snapshot must not be represented as newer production data. `WNS_PORT=3400` chooses another loopback port. The cloud metadata cache checks for changed exports every 30 seconds while no investigation is active.

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

Registration rows, normalized sources, typed endpoints and corporate publishers are different. The summary and both country tables show an explicitly estimated newsroom/brand count (`≈`) immediately after the country, using registered site domains, narrowly reviewed brand aliases, and shared-host namespaces/names. The global summary deduplicates brands across countries instead of summing country estimates. This is not a verified legal-entity or ownership-group census. A remote overview uses only a complete registry observation with the exact matching registry revision and active source count; the global summary also requires matching RSS/sitemap endpoint totals. Partial, absent, or mismatched observations leave the count null. Country drilldowns use complete source listings. Unknown shared servers and unlinked domains can still introduce error. Independent per-endpoint discovery totals remain unavailable where the export lacks evidence. Current holdings are not historic inventory, and first observation is never treated as registration time.

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

The new collection policy targets every active address daily. It defaults to six global workers (maximum sixteen), one request per host with a two-second gap, eight seconds per fetch attempt, at most three redirects and one transient retry. HTTP-hop reservations, redirects and retries share the 12,000-request daily cap. Already-checked and server-deferred targets remain visible; 429/`Retry-After` waiting, budget limits and unfinished work are partial coverage, not successful zero results. The policy is installed on the authoritative Oracle collector. Its 03:00 UTC timer remains unchanged; the next scheduled run is October 14, 2026. The verified runtime plan contains 5,416 active typed targets, a 10,000-target limit, six workers and the 12,000-request cap.

The October 13 baseline inspected the existing two-worker production release, eight bounded live endpoint probes and read-only SQLite diagnostics. Isolated Oracle measurements identified repeated per-URL SQL preparation and validated statement reuse, precomputed country baselines and removal of unused UPSERT return values. Counts, timestamps, relationships, transactions and replay semantics remain unchanged. The code and safe rollout tooling are installed on Oracle; rollout retained the authoritative registry, article ledger, tracking baseline and URL identities. These isolated measurements do not establish whole-run speedup. See [the original findings](ops/COLLECTOR-PERFORMANCE-2026-10-13.md), [the storage comparison](ops/COLLECTOR-STORAGE-2026-10-13.md) and [collector rollout](ops/COLLECTOR-ROLLOUT.md).

Older records and the current remote seven-tool aggregates lack these completed cohorts. Their baseline stays unavailable; a later observation date does not establish completion, and a missing baseline is not a healthy verdict. Freshness needs at least three reliable content-date advances with comparable inspections. HTTP success and old observations cannot certify current freshness. Feed item dates and sitemap `lastmod` remain different evidence kinds.

`QualityRunStore` retains actual events in private SQLite. Request IDs recover accepted starts after a lost response and across restarts. Restart reconciliation marks dead-owner or legacy interrupted runs as failures without replaying them; a live independent daily process keeps its run. The daily worker shares the run store without taking the web process lease. Two concurrent interactive runs are allowed. In-memory-only embeddings retain at most 20 runs for one hour.

## Credentials and cost

The user approved a **$5 combined pilot cap for OpenAI and Jev**, not a renewed daily allowance. `PersistentModelBudget` shares conservative reservations across providers, processes and restarts. Uncertain failures retain reservations; a fixed authorization ID prevents budget renewal at restart.

The user approved reusing the existing OpenAI and TypeSafe keys on Oracle in `/home/ubuntu/.config/world-press-radar-quality/model-secrets.env`, with mode 0600. The worker reads literal assignments in memory, never sources them as shell code, and never returns values to the browser, reports or deployment bundles. The shared pilot budget was migrated with prior reservations retained and the old local allowance sealed. Both earlier local provider pilots and subsequent actual cloud investigations succeeded. Readiness reflects configuration, not future API availability.

| Control | Purpose |
| --- | --- |
| `WNS_QUALITY_TOTAL_BUDGET_USD` | Shared authorized ceiling |
| `WNS_QUALITY_BUDGET_PATH`, `WNS_QUALITY_BUDGET_ID` | Durable budget location and fixed authorization |
| `WNS_OPENAI_KEY_FILE`, `WNS_JEV_KEY_FILE` | Credential file locations |
| `WNS_OPENAI_PAID_APPROVED`, `WNS_JEV_PAID_APPROVED` | Explicit provider gates |
| Provider `*_MODEL`, `*_TOTAL_BUDGET_USD`, `*_RUN_BUDGET_USD` | Model and provider/run limits |
| Provider `*_INPUT_USD_PER_MILLION`, OpenAI `*_OUTPUT_USD_PER_MILLION` | Rates for usage estimates |

Provider controls default off. Usage-derived costs are estimates, not billing receipts. Missing usage never becomes zero cost. Automatic model retries, remote tracing, sensitive SDK logging and OpenAI response storage are disabled. In cloud mode, every investigation start, including rules, and all repair mutations require the separate administrator credential and a same-origin request. The gateway credential permits forwarding only. Browser login creates an eight-hour signed Secure/HttpOnly/SameSite=Strict cookie; anonymous visitors can read statistics and sanitized completed investigations.

## Approval-controlled repair

The operator selects a source, endpoint and publisher website. Bounded official-page feed declarations or `robots.txt` sitemap declarations produce validated XML candidates and an exact proposal. The operator must confirm website ownership; a declaration alone does not prove it.

Approval binds the proposal digest, registry hash, actor and session. Apply changes only the explicitly configured registry and retains rollback evidence. Local mode affects its local registry; cloud mode is bound to the approved Oracle collector release root. Changed registries, expired validation, conflicting proposals and unauthenticated mutations are rejected. Model suggestions cannot apply changes. Restart the cloud worker after a collector release switch so its repair binding follows the new release.

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

The daily worker saves country/registry observations and investigates at most five supported declines using **rules only**. Receipts prevent duplicate successful reports; partial runs are retryable. Oracle runs an activated dedicated hourly systemd dispatcher, gated after 09:00 UTC for the preceding closed UTC day; user lingering keeps it independent of login. The collector retains its separate 03:00 UTC timer. Local launchd/cron generators remain optional. See [operations](ops/QUALITY-OPERATIONS.md).

Ten fixed synthetic English/Korean/Japanese cases compare exact-label agreement, false positives, missed failures, language results, actual time, reported usage and estimated costs. Providers use the same cases. Synthetic agreement is not general multilingual news accuracy. Rules have zero model cost; server cost is unmeasured. Live evidence is retained privately in `output/news-quality/`.

The October 13, 2026 comparison used `gpt-6-luna` and `jev-1.13.0`:

| Method | Exact labels | False findings / missed findings | Measured case time | Estimated API cost |
| --- | --- | --- | --- | --- |
| Rules | 10/10 | 0 / 0 | 0.75 s | $0 |
| Jev | 9/10 | 2 / 0 | 1.44 s | $0.000611352 |
| OpenAI | 9/10 | 0 / 0 | 14.41 s | $0.0010334 |

Exact labels by language were rules 3/3 English, 4/4 Korean, 3/3 Japanese; Jev 3/3, 3/4, 3/3; OpenAI 2/3, 4/4, 3/3. Jev's two false findings also violated the evidence contract, despite some classification labels being correct. Keep rules as the default, use OpenAI for additional evidence-driven reads, and treat Jev as a review candidate behind code agreement/confidence checks. Ten synthetic cases do not establish production accuracy or justify automatic model-only repairs.

## Production state

The public dashboard is [https://news.bymyleslee.com/quality/](https://news.bymyleslee.com/quality/), verified in the actual browser on October 13, 2026. It uses the existing Vercel domain and Oracle server. The cloud web service listens only on `127.0.0.1:3401`; a narrow nginx HTTPS route and Vercel gateway connect it to the public UI. History, investigations and the shared model budget remain in private Oracle SQLite outside immutable code releases. The web service and daily timer are active with `Linger=yes`. The first actual daily report for October 12 UTC completed at `2026-10-13T22:54:06.610Z` with no errors, model calls or model cost. It recorded the initial registry observation baseline and found no supported decline eligible for investigation; historic completed cycles were not fabricated. A repeat daily start retained the same receipt. The final web restart preserved the exact three completed investigations, their saved payloads and the shared budget/reservations; web health and the daily timer remained active.

The gateway uses an encrypted server-only credential; the separate administrator credential is required for execution and registry changes. Actual anonymous investigation starts and proposal requests returned 403. The public bundle contains saved metadata and dashboard assets, with no private databases or model credentials. Browser verification showed 73 country sections, 72 active countries, approximately 2,792 distinct newsroom/brands, 5,034 active registrations, 3,667 RSS addresses and 1,749 sitemap addresses. The last collection was October 13 at 03:53 UTC; the later 22:31 UTC snapshot generation is shown separately. The existing Cloudflare D1 remains an independent MCP counter service.

The collector release is activated after 315 tests on Oracle. It preserves the current registry, audits, private activity ledger, exported shards, pending spools, tracking baseline and existing timers. The old local snapshot did not replace newer production data. The first normally scheduled collection under the new policy is October 14 at 03:00 UTC. Authoritative completed-cycle and freshness history must accumulate from real runs; historic completion is not backfilled. Official replacements still need individual approval and post-apply collection before claiming recovery. Activity refresh may report an explicit degraded usage-acknowledgment warning; functional MCP and history mismatches still fail. See [cloud deployment](ops/QUALITY-CLOUD-DEPLOYMENT.md) and [collector rollout](ops/COLLECTOR-ROLLOUT.md).

## Verified integration run — 2026-10-13

In the earlier local integration, OpenAI completed with 13 MCP calls, three model calls and three inspected Korean sources. Jev completed with 34 MCP calls, twelve model calls and twelve inspected sources. These are partial country investigations, not whole-country health certifications. Invalid model proposals are recorded and excluded from accepted proposals; model summaries remain unverified.

The earlier local pilots, comparison and integration debugging accounted for an estimated $0.009963582 before migration. They are separate from the subsequent cloud runs below. Provider billing receipts were not available. The local integration suite passed 212 tests; the final cloud implementation suite passed 316 tests. The subsequent daily CLI entry-point regression suite passed 11 tests. Original checkout fingerprints remained unchanged for all 15 pre-existing dirty/untracked files.

Actual cloud acceptance completed these Korean investigations:

| Mode | Tool calls | Inspected sources | Model calls | Estimated API cost |
| --- | --- | --- | --- | --- |
| Rules | 27 | 12 of 48 | 0 | $0 |
| OpenAI | 6 | 3 of 48 | 3 | $0.0017533 |
| Jev | 27 | 12 of 48 | 12 | $0.00178101 |

These bounded runs are not whole-country health certifications. The shared total after cloud acceptance is **$0.013497892 of $5**, including the earlier local usage estimate. Vercel deployment `dpl_FbuoKYZM6qa236t3YqpfwJj19mvw` is Ready with the existing production aliases; actual browser acceptance confirmed the public route and data.

TypeSafe integration follows the official [agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), HTTP API and Choice documentation. The skill was read directly; no global skill installation was required.
