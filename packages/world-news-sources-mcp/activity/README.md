# Durable article-URL observations

The authoritative store is an isolated operator SQLite ledger, separate from usage D1 and every legacy database. No article bodies, user queries or new credentials are needed. The existing Oracle audit runner can own this file after a verified transfer. Do not run its superseded release/timer. There is currently **no activity scheduler activated by this package**.

## Semantics

NEW means the first discovered canonical candidate URL **in that source or country**, after its endpoint/source binding's initial successful URL-document collection. Every new binding starts with an excluded baseline, including an empty valid feed. A new archive baseline excludes new-to-the-ledger URLs from source AND country NEW, even when another endpoint is initialized. Existing scope discoveries retain their original classification. Country discoveries are independent of global first observation and deduplicated across sources; do not sum source counts. URL appearances at different endpoints of the same source count once. No semantic/content duplicate detection is attempted.

Global, source, country, endpoint and endpoint/source/country relationships have real first/last UTC observation timestamps. The normalization version is `article-url-v1`: fragments and `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid` are removed; identity query parameters, order, encoding and path case are preserved. No publication metric is calculated. RSS item dates and sitemap `lastmod` remain separate health metadata, never discovery timestamps.

Sitemap-index children are excluded and do not initialize article coverage. Homepage and recognized section/category/tag/forum paths are stored as uncertain and excluded from candidate NEW. Other URLs are **candidates**, not verified article pages: the collector does not follow them or semantically classify publisher content. Unknown layouts can include navigation or other public pages. No historic backfill from audit counts/samples occurs.

## Operator commands

Node 22.13+ (Node SQLite) and the normal package dependencies are sufficient:

```sh
npm run build
npm run activity:collect -- --db /private/operator/activity.sqlite --snapshot activity/activity-snapshot.json --limit 10000 --daily-budget 12000
npm run activity:export -- --db /private/operator/activity.sqlite --snapshot activity/activity-snapshot.json
```

Run once daily **after** the parent has coordinated the Oracle runner's compatible release. Activity collection is distinct from the weekly full endpoint-health audit. Production default: full active endpoint pass (up to 10,000 distinct endpoints), at most 12,000 attempts per UTC day (retries included), two global workers, one request per host and a two-second host gap; DNS pinning, private-address rejection, 8-second timeout and bounded decompression/XML bodies are reused. Typed endpoint IDs are deduplicated across registrations. RSS and sitemap sharing the exact URL remain separate typed checks. Only transient failures receive at most one retry. Blocked/auth/WAF responses receive no bypass. Failed bindings have bounded exponential backoff; sitemap indexes are revisited weekly. Disabled registrations are excluded from collection.

`--endpoint ep_ID` may be repeated for a small selection. `--force` ignores due dates, not daily budget or writer lock. `--inspection` uses a separate ledger/snapshot and never enters a production bundle. Never pass production DB paths to fixture/test runs. Production initialization is real tracking, even when operators inspect its output; MCP verification calls are independently labelled `inspection` for usage statistics.

Every successful document retains **all extracted URLs**, not three health samples. Collections, scope relationships and initialization commit in one SQLite `BEGIN IMMEDIATE` transaction. A failed transaction cannot become a successful check. Complete pending documents are atomically journaled with the observed source/country bindings before commit and replayed by stable collection ID; replay does not recount or remap history using a later registry. Uncommitted legacy spools without that provenance stop for operator review; already committed IDs can replay safely. A durable writer lease prevents overlapping processes, expires after crashes, and fences stale owners. UTC-chronological collection order is required; replayed IDs are accepted, old previously uncommitted checks are rejected for manual reconciliation rather than silently rewriting discovery history. WAL/busy timeout protect readers/writers. Failed/blocked/timeout/malformed documents retain their real statuses without zero article claims.

## Free resource budget and coverage

Current registry: 72 active countries, 5,023 active registrations, 5,403 distinct typed active endpoints (3,674 RSS references, 1,757 sitemap references). A 250-endpoint engineering sample takes at least 22 days to rotate through the registry and can miss short-lived RSS links; it is **not the production coverage cadence**. Production targets every due active endpoint daily, with initial full baseline, bounded backoff and explicit unsuccessful coverage. Successful bindings become due at the next UTC calendar day, not 24 hours after a late-running check. At global concurrency two, allow roughly 40–120 minutes per full run; blocked/timeout retries and per-host waits can make it longer. This is an estimate to measure on Oracle, not a runtime guarantee. The previous health audit reported roughly 816,807 entries across 3,883 active non-index working endpoints; these are workload estimates, not tracked articles or deduplicated URLs.

SQLite requires no per-write cloud charge and uses existing VM disk/CPU. Budget roughly **1–3 GB** for initial URL/relationship/index storage, dependent on URL length and overlap; verify actual VM free disk before activating. Default soft storage stop is 8,192 MiB (`--max-db-mib`), checked before each new document; Oracle must have sufficient existing free disk before activation; a bounded document/transaction can cross it slightly. No deletion, retention purge, paid upgrade or purchase is automatic. Stop/report exhausted capacity. Request bodies are bounded (RSS 4 MiB, sitemap 8 MiB); huge/unsupported XML remains incomplete. Repeated checks extend `last_seen`; absent URLs are not declared deleted.

The hosted service contains a cached aggregate snapshot only, never the SQLite database. Snapshot window: at most 180 days, 25,000 collection records and 10 MiB. At roughly 5,403 checks/day, 25,000 records cover only about 4.6 days (less if the byte budget binds). This is a recent public cache, not 180-day availability; older authoritative history remains in SQLite. Tools disclose `history_not_in_snapshot` instead of zero outside available history. Query date ranges are at most 31 calendar days, pages at most 50, and use exact IANA local boundaries including DST/fractional offsets. Rolling 24 hours is an independent real-time window. Snapshot age and latest collection are explicit; no live feed fetch occurs on a tool call.

## Deploy/Oracle handoff

`scripts/refresh-deploy.mjs` retains the weekly complete health audit. It supports `WNS_DEPLOY_API=1` with the already approved project-scoped Vercel token and narrow `scripts/deploy-project-api.mjs`; no account-user CLI lookup or broader credential is needed. Use the new `scripts/refresh-activity.mjs` for collect/test/export/deploy without a full health crawl. Keep uncertain API submission state; never blindly repeat a deployment POST.

Transfer only package source/scripts/tests/metrics/site/plugin/audits snapshots, package manifests, required registry metadata and an SQLite backup made with `VACUUM INTO` while this Mac collector is stopped. Preserve the initial production tracking timestamps. Exclude `.vercel` credential state, Wrangler config, `.npm`, `.ssh`, video/evidence folders, `.env`, secrets and private token files. Populate only the existing verified nonsecret project link on VM; its project-scoped token remains VM-local. Do not copy any Mac credential. Choose one production writer; no incompatible timers.

ChatGPT must refresh/reconnect the existing MCP to discover its seven tools. Final directory submission/demo revision remains held until the updated tool set and truthful coverage are included.

Implementation references: [Node SQLite](https://nodejs.org/api/sqlite.html), [Vercel scoped deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment), [D1 free pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Measured engineering sample: 335 unique URLs, eight real checks, 2.74 MB SQLite total; URL/relationship/index pages use about 0.72 MB (about 2.1 KB/URL in this small non-overlapping sample). Initial 816k entry-scale storage could approach 1.7 GB before growth. At an illustrative 10k–30k new unique URLs/day, storage could grow around 20–60 MB/day plus collection records. Actual churn/overlap must be measured; raise a capacity issue before crossing the soft budget, with no automatic deletion or paid resources.

Byte-bounded export keeps the latest whole timestamp cohorts and reports available_since plus snapshot_coverage. It does not truncate the SQLite ledger. The 10 MiB cap stays below the scoped API adapter’s 12 MiB per-file limit and leaves room in its 24 MiB request body. A static metadata-only snapshot that cannot fit fails clearly rather than silently claiming a valid export.
