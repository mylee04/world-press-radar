# World News Sources

`world-news-sources-mcp` is a small, private, database-free MCP package for configured publisher RSS and sitemap metadata. It reads this repository's `data/rss-atlas.json` directly. No article ingestion, PostgreSQL, Next.js, customer token or LLM/API key is needed to run it.

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
| `WNS_HEALTH_PATH` | package `health-snapshot.local.json` | Typed health snapshot; an explicitly supplied path must exist |

Files are loaded once at startup, capped at 16 MiB. Restart after changing registry or health files. The package can also run outside this repository when given `WNS_REGISTRY_PATH`; the registry schema is enforced. It imports no web application or ingestion module. The root app's TypeScript configuration excludes this separately built package.

## Tools and examples

All four tools are read-only and use cached metadata. Tool calls never fetch a publisher or write files.

| Tool | Example arguments | Result |
| --- | --- | --- |
| `search_sources` | `{"country":"US","endpoint_type":"sitemap","enabled":true,"query":"Texas","limit":10}` | Matching sources with separate typed endpoints |
| `get_source` | `{"source_id":"<source id from search>"}` | Details and each endpoint's cached health |
| `list_countries` | `{"offset":0,"limit":20}` | Country codes, names and configuration counts |
| `get_endpoint_health` | `{"endpoint_ids":["<endpoint id from search>"]}` | Per-endpoint status, provenance and checked time |

`search_sources` also accepts exact `category` and `language` filters. Country code and query matching ignore case. `enabled` is the registry configuration flag, unrelated to live health; omitted means all registrations, including disabled ones.

Search and country lists return `items`, `total`, `offset`, and `next_offset`; repeat the same filters with the returned offset. Default page size is 20, maximum 50. A 60 KB JSON item budget can shorten a page. Text and structured MCP results together remain bounded. Health accepts at most 20 IDs and removes repeated IDs. Unknown keys, malformed IDs, invalid limits and offsets are rejected; unknown source/endpoint IDs return tool errors.

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

Limitations: this is structural validation, not full RSS/Atom/Sitemap XSD conformance or a guarantee that articles exist or can be ingested. UTF-8 XML is supported; other character encodings, oversized feeds, empty sitemaps and conservatively blocked IPv6 ranges may fail. Health is environment-specific, cached, and has no automatic refresh. Run the CLI only for endpoints you are permitted to check, and avoid repeated checks. No bulk crawler or scheduler is included. Use a single CLI writer at a time.

## Validation and coverage

Verified against local `develop` commit `c2f5691`: **73 country sections, 5,393 configured rows**. Normalization yields 5,393 source records and 5,775 distinct typed endpoints (4,009 RSS, 1,766 sitemap). These are configuration counts, not unique publishers or currently live feeds.

The existing audit was generated on **April 3, 2026** and is historical. Existing `export-rss-catalog.ts` selects RSS **or** sitemap, labels all OPML endpoints as RSS, and writes export time as `checked_at`. Existing `verify-readme-rss.ts` imports article-volume queries, initially checks RSS `url` values and uses XML markers. This package avoids those paths and preserves endpoint type and check provenance; it does not rewrite the old application's exports or verifier.

On September 30, 2026, package typecheck/build, **15 tests** and a real SDK stdio smoke test passed on Node.js 26.5.0. Coverage includes typed endpoints, duplicates, stable IDs, filters, pagination/response limits, invalid input, timestamp freshness, fallback separation, XML format rejection, pinned DNS, blocked private redirects, gzip bounds, HTTP 403 and timeout fixtures. Tests use Node's experimental module mocking for isolated network fixtures (the experimental/deprecation warnings on newer Node releases do not affect runtime). **No live publisher health checks or full crawl were performed.**

## Connecting to ChatGPT later

The smallest local verification is `npm run smoke`, which launches and calls this package through the official SDK with no credentials. ChatGPT connection itself has not been performed.

According to the [official ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), developer-mode testing can use a public HTTPS Streamable HTTP endpoint or Secure MCP Tunnel. If an authorized tunnel and runtime credentials already exist, the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) supports this package's stdio command directly. Tunnel access and developer mode depend on account/workspace permissions; the tunnel has its own credential requirements. No tunnel or credentials are created by this package.

For the public HTTPS route, the next development step is a small **Streamable HTTP adapter** around `createServer(catalog, health)`, using the official SDK's Node transport, with request limits, Origin/Host validation, TLS, lifecycle handling and an access policy suitable for the chosen host. Ship only this package plus registry/health JSON, with no customer portal or database. Read-only hosting need not give the process outbound publisher access; run approved health checks separately and supply their snapshot. This package currently includes stdio only, so it cannot be added as an HTTPS `/mcp` URL yet. Hosting, tunnels, publication and public directory installation are outside this implementation.

Transport and SDK choices follow the [official MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) and [TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/server` 2.2.0, pinned in the lockfile).
