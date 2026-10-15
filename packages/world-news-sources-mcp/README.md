# World News Sources

Source activation/deactivation timestamps and operator workflow: [STATUS-HISTORY.md](STATUS-HISTORY.md). Existing unknown historical dates remain null. Health audits do not change the enabled flag.

`world-news-sources-mcp` serves configured publisher RSS/sitemap metadata from this repository's `data/rss-atlas.json`. The core read tools need no database, PostgreSQL, Next.js, customer token, or model key. Optional collection and quality operations use private SQLite stores for their durable history.

The **News Quality Agent dashboard** separates attempt coverage, success among attempts and freshness, with actual rules/OpenAI/Jev investigation records. Run `npm run quality:dashboard` locally. The cloud runtime uses the existing Oracle server for durable history and execution, a Vercel gateway on the existing public domain, administrator-only investigation starts and approvals, and the migrated shared **$5** pilot cap. The public [dashboard](https://news.bymyleslee.com/quality/) and actual cloud rules/OpenAI/Jev investigations have passed acceptance; its web service and daily rules timer are active. Its first actual daily report completed with no errors or model calls; repeat-start and web-restart persistence checks passed. See [QUALITY.md](QUALITY.md) and [operations](ops/QUALITY-OPERATIONS.md).

## Run locally

Requires Node.js **22.13+** and npm. Install only this package's dependencies:

```sh
cd packages/world-news-sources-mcp
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke
npm start
```

`npm test` builds first. `npm start` serves MCP on **stdio**, waiting for a client; it is not a web server. For an MCP host that launches local processes, use an absolute path:

```json
{
  "mcpServers": {
    "world-news-sources-mcp": {
      "command": "node",
      "args": ["/absolute/path/world-press-radar/packages/world-news-sources-mcp/dist/stdio.js"]
    }
  }
}
```

Use an absolute Node executable if the host does not inherit your shell PATH. The server loads its data relative to its own file, so the client's working directory can be anywhere. Only MCP JSON is written to stdout; startup errors use stderr.

Optional paths, all local JSON files:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WNS_REGISTRY_PATH` | repository `data/rss-atlas.json` | Registry override |
| `WNS_LEGACY_HEALTH_PATH` | repository `audits/readme_rss_health_latest.json` | Historical marker-check audit; a missing file is allowed |
| `WNS_HEALTH_PATH` | local override if present, otherwise package `audits/health-latest.json` | Typed health snapshot; an explicitly supplied path must exist |

Ordinary metadata runtimes load files once at startup, capped at 16 MiB; restart after changes. The durable cloud quality runtime checks changed registry, health and activity exports every 30 seconds while no investigation is active. The package can also run outside this repository when given `WNS_REGISTRY_PATH`; the registry schema is enforced. It imports no web application or ingestion module. The root app's TypeScript configuration excludes this separately built package.

## Tools and examples

The four core metadata tools below are read-only and use cached metadata. Additional activity/inventory/quality tools are documented below. MCP tool calls never fetch a publisher or write the registry.

| Tool | Example arguments | Result |
| --- | --- | --- |
| `search_sources` | `{"country":"US","endpoint_type":"sitemap","enabled":true,"query":"Texas","limit":10}` | Matching sources with separate typed endpoints |
| `get_source` | `{"source_id":"<source id from search>"}` | Details and each endpoint's cached health |
| `list_countries` | `{"offset":0,"limit":20}` | Country codes, names and configuration counts |
| `get_endpoint_health` | `{"endpoint_ids":["<endpoint id from search>"]}` | Per-endpoint status, provenance and checked time |

`search_sources` also accepts exact `category` and `language` filters. Country code and query matching ignore case. `enabled` is the registry configuration flag, unrelated to live health; omitted means all registrations, including disabled ones.

Search and country lists return `items`, `total`, `offset`, and `next_offset`; repeat the same filters with the returned offset. Default page size is 20, maximum 50. A 60 KB JSON item budget can shorten a page. Text and structured MCP results together remain bounded. Health accepts at most 20 IDs and removes repeated IDs. Oversized health responses include `remaining_endpoint_ids` to request separately. Unknown keys, malformed IDs, invalid limits and offsets are rejected; unknown source/endpoint IDs return tool errors.

Endpoint IDs hash endpoint **type + normalized HTTP(S) URL**. Source IDs hash country code + normalized source name + its endpoint IDs. IDs survive registry reordering; editing a URL/type or source identity changes the relevant ID. Identical registrations merge with `registrationCount` and up to 50 original row numbers. Shared endpoints retain the same endpoint ID across registrations, while different source names/countries remain separate. If any merged registration is enabled, the normalized source is enabled. These source records are not consolidated corporate publishers.

## Health semantics

| `status` | Meaning |
| --- | --- |
| `unknown` | No usable check time, future time, or only a recent historical marker check |
| `stale` | The recorded check is older than 7 days; inspect `last_outcome` and `validation` |
| `healthy` | A recent bounded check returned 2xx and parsed the expected XML structure |
| `unhealthy` | A recent check failed from this checker environment; this does not prove universal failure |

`checked_at` preserves the observation time and never uses load/export time. New checks timestamp completion individually. The legacy audit's recorded checker timestamp is retained with `validation: legacy_xml_markers` and `last_outcome: reported_valid/reported_invalid`; those checks did not establish full feed validity. Registry `status`, `valid`, `checkedDate` and the legacy audit's aggregate sitemap-fallback summary never establish endpoint health. A sitemap success cannot change an RSS failure. Missing sitemap observations stay unknown.

An optional operator command checks **1–5 explicit configured endpoint IDs**, sequentially, and atomically updates the local typed snapshot:

```sh
# Obtain real IDs from search_sources first; this makes outbound HTTP requests.
npm run health:check -- ep_<24 hexadecimal characters>
```

Each endpoint has an 8-second total network deadline, at most 3 redirects and a 2 MiB limit for both wire and decompressed bodies. Every redirect is validated. DNS answers must be public and are pinned to the socket; local/reserved IPs, credentials and nonstandard ports are rejected. The validator sends an identifying user agent, parses well-formed XML with namespaces, rejects DTDs, checks RSS/Atom/RDF channel/feed structure or sitemap URL/index structure, and supports bounded gzip. It does not fetch article URLs or sitemap child documents. It never retries 403, solves CAPTCHA/WAF challenges, supplies authentication or uses browser impersonation.

Limitations: this is structural validation, not full RSS/Atom/Sitemap XSD conformance or a guarantee that articles exist or can be ingested. UTF-8 XML is supported; other character encodings, oversized feeds, conservatively blocked special-purpose IP ranges may fail. Health is environment-specific, cached, and has no automatic refresh. Run the CLI only for endpoints you are permitted to check, and avoid repeated checks. The bounded operator audit below checks the whole registry only when explicitly invoked. No scheduler is included. Use a single CLI writer at a time.

## Validation and coverage

Verified against local `develop` commit `c2f5691`: **73 country sections, 5,393 configured rows**. Normalization yields 5,393 source records and 5,775 distinct typed endpoints (4,009 RSS, 1,766 sitemap). These are configuration counts, not unique publishers or currently live feeds.

The existing audit was generated on **April 3, 2026** and is historical. Existing `export-rss-catalog.ts` selects RSS **or** sitemap, labels all OPML endpoints as RSS, and writes export time as `checked_at`. Existing `verify-readme-rss.ts` imports article-volume queries, initially checks RSS `url` values and uses XML markers. This package avoids those paths and preserves endpoint type and check provenance; it does not rewrite the old application's exports or verifier.

On September 30, 2026, package typecheck/build and **24 tests** passed on Node.js 26.5.0. Coverage includes both typed endpoints, duplicates, IDs, pagination/limits, invalid input, health freshness/fallback separation, XML output counts/dates, pinned DNS, private redirects, redirected-host request pacing, gzip bounds, 403/timeout fixtures, stdio, and modern/legacy HTTP clients. Tests use experimental Node module mocking for isolated network fixtures.

## HTTP and ChatGPT

Live endpoint: **https://news.bymyleslee.com/mcp**. This public endpoint serves configured source metadata, cached audit results and retained URL-discovery aggregates, with no authentication or publisher fetches during tool calls. Service/audit summary: https://news.bymyleslee.com/health. Actual HTTPS SDK calls, legacy `initialize` / `tools/list` / `tools/call`, and published-plugin source, health and country-activity queries were verified.

For local HTTP testing:

```sh
npm run build
npm run start:http                 # loopback 127.0.0.1:3000 only; WNS_PORT can override
npm run smoke:http -- http://127.0.0.1:3000/mcp
```

HTTP is stateless Streamable HTTP using the official SDK, including legacy MCP compatibility. `/mcp` accepts POST only; GET returns 405 because there are no persistent streams. Requests are capped at 64 KiB, subscriptions disabled, and Host/Origin validated. HTTPS terminates at Vercel. Metadata responses use normal pagination and byte limits.

Install the published [World News Sources plugin](https://chatgpt.com/plugins/plugin_asdk_app_6abd7c20121c8191a04bc4ca47c47da8), sign in to ChatGPT, and choose **Install plugin**. Start a new chat, type `@`, and select **World News Sources**, following the [official plugin usage guide](https://learn.chatgpt.com/docs/plugins). No separate World News Sources account or API key is required. The [homepage](https://news.bymyleslee.com) provides installation steps and copyable prompts for source search, cached endpoint health and country URL activity. Other MCP clients can connect directly to `/mcp` with **no authentication**. The existing portfolio and web application are separate Vercel projects.

## Full live audit and weekly refresh

```sh
npm run build
npm run audit -- YYYY-MM-DD        # full registry, including disabled registrations
# Repeating the SAME run ID resumes checkpoints; a NEW weekly date starts a fresh audit.
npm run refresh:deploy -- YYYY-MM-DD
```

`refresh:deploy` typechecks/tests, runs or resumes that audit, prepares a metadata-only bundle, deploys the already linked independent Vercel project, and verifies live HTTPS MCP calls. It uses the existing authorized Vercel CLI login. It stops if the linked project identity differs. No credentials are printed, scheduler installed, Git push made, or domain purchase required. A weekly automation can invoke this command from this package directory. Runtime needs Node/npm, Vercel CLI login, network access and enough time for thousands of bounded checks; the user's Mac must be available. Configure exactly one weekly automation separately.

Eight global workers, one per hostname, two seconds between checks, 8-second network budget per endpoint and at most three validated redirects. Redirect destinations share a per-host gate too. RSS bodies are capped at 4 MiB and sitemaps at 8 MiB including decompression. One retry is allowed after at least 30 seconds only for timeout, temporary DNS/reset, or selected 5xx responses. 401/403/429 are never retried; a 429 leaves pending same-host endpoints explicitly incomplete. No WAF/CAPTCHA/authentication bypass, article requests or sitemap-child expansion occurs.

Reports are saved every 30 seconds in `audits/<run-id>/`: `manifest.json` records inputs/limits, `observations.jsonl` is resumable, `report.json` has individual results plus type/country/enabled/disabled totals, and `README.md` summarizes coverage. Shared typed URLs are checked once; country and enabled/disabled buckets can overlap. A finished audit is promoted to `audits/health-latest.json`, which is shipped in the Vercel bundle. A completed full-audit timestamp means all endpoints were attempted, including recorded failures; it never means every feed works. Skipped endpoints prevent a new full-audit timestamp.

| Audit field | Meaning |
| --- | --- |
| `audit_status` | `working_nonempty`, `valid_empty`, `blocked`, `timeout`, `malformed`, `http_error`, `network_error`, or `incomplete` |
| `entry_count`, `entries_with_url`, `sample_urls` | Parsed outputs and at most three sample URLs; no article body is retained |
| `checked_at` | Actual endpoint observation completion time |
| `newest_content_at`, `content_freshness` | Newest usable item date or sitemap lastmod; `recent`, `stale` (>30 days), `missing`, or `unreliable` |
| `date_kind` | Feed item publication/update date or sitemap lastmod; these are not equivalent |
| `audit.last_completed_full_audit_at` | Last fully attempted registry audit, separate from individual timestamps |

A sitemap index's count and URLs describe **child sitemap entries** only. A successful fetch/XML parse can still have old content, no reliable dates, or no usable article links. `entries_with_url` shows URL availability. Fresh HTTP/XML health is separate from publication freshness. Size/encoding/safety limits and malformed XML remain visible and require investigation; they do not prove universal publisher failure. See the dated audit report for actual coverage and failures.

## September 30 audit result

Completed **2026-09-30T20:05:37.106Z**: all 5,775 distinct typed URLs were attempted, zero skipped. RSS: 3,057 working nonempty, 32 valid empty, 920 failed/incomplete out of 4,009. Sitemap: 1,493 working nonempty, 9 valid empty, 264 failed/incomplete out of 1,766. Overall 4,550 working nonempty + 41 valid empty; 1,184 failed/incomplete. Structurally valid documents still included 156 with old content dates, 705 missing dates and 18 unreliable dates. [Full report](audits/2026-09-30/README.md) and [deployment evidence](DEPLOYMENT.md) record limits and outcomes. This is environment-specific verification of configured XML endpoints, not a guarantee that all sources work or articles can be retrieved.

## Vercel bundle

`npm run prepare:vercel` writes ignored `.deploy-vercel/` with runtime metadata modules, whitelisted registry fields, saved health/activity, dashboard assets and the quality gateway. It excludes private databases, model credentials, the old portal, validator and audit runner. Hosted MCP tools remain read-only; the gateway sends authenticated quality operations to the separate durable Oracle process. Production is project `world-news-sources-mcp` under `mylee04s-projects`; deployment commands and evidence are in `DEPLOYMENT.md`. Hosting requires an HTTPS public hostname, Node 22 runtime and an access policy appropriate to public metadata. Do not deploy the old application root for this service.

Transport and SDK choices follow the [official MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) and [TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/server` 2.2.0, pinned in the lockfile).

## Published plugin

The [World News Sources plugin](https://chatgpt.com/plugins/plugin_asdk_app_6abd7c20121c8191a04bc4ca47c47da8) was published on October 15, 2026. Its public detail page and **Install plugin** action were visible without signing in; installation completion in an independent user account has not been verified. The English directory package is in [`plugin/`](plugin/); `npm run plugin:package` creates the ZIP. [`publication/READINESS.md`](publication/READINESS.md) retains the earlier submission evidence and gates. The public [website](https://news.bymyleslee.com), [support](https://news.bymyleslee.com/support), [privacy](https://news.bymyleslee.com/privacy) and [terms](https://news.bymyleslee.com/terms) identify Myungeun Lee and the approved support contact.

Optional long-term aggregate counters are described in [`metrics/README.md`](metrics/README.md). No query database or user profiles are used; deployment evidence records when collection becomes active. Local package tests include atomic concurrent increments, durability, privacy projection and protocol/error classification.

## Article-URL activity and current inventory

Nine read tools are available in this checkout, including `get_country_source_inventory`, `get_source_article_activity`, `get_country_article_activity`, `get_country_collection_quality` and `get_source_collection_quality`. The older deployed MCP had seven tools; the remote dashboard reader remains compatible with those seven. The cloud quality runtime reads the authoritative Oracle metadata with the nine-tool implementation. [Activity operator documentation](activity/README.md) defines excluded initialization baselines, scope-specific discovery, deduplication, timezone/DST, partial coverage and the separate durable SQLite ledger. Future collector runs record completed cohorts and reliable content dates for comparable quality baselines. No MCP tool crawls a publisher. Counts describe first-discovered candidate URLs, not publications or entry counts.

```json
{"name":"get_country_source_inventory","arguments":{"country":"US","include_disabled":true}}
{"name":"get_country_article_activity","arguments":{"country":"US","start_date":"2026-10-01","end_date":"2026-10-01","timezone":"America/New_York"}}
{"name":"get_source_article_activity","arguments":{"source_id":"<ID returned by search_sources>","mode":"rolling_24h"}}
```

Use `npm run activity:collect` to collect/export without deployment, or `node scripts/refresh-activity.mjs` for the bounded collection→tests/export→deployment→real MCP smoke workflow. `WNS_DEPLOY_API=1` selects the existing project-scoped Vercel REST adapter for Oracle. The weekly `refresh:deploy` health audit remains separate. No timer is created here. Refresh the ChatGPT connection to discover the new tools. Directory submission and demo revision are held until this updated release is represented truthfully.
