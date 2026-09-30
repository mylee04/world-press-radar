# Aggregate MCP usage

The application collector records **tools/call attempts**, including validation and tool errors. Initialize, tools/list, ping, notifications, `/health` and static pages are excluded. A successful tool returning an unhealthy publisher endpoint is a successful tool call.

The only persisted fields are UTC day, one of four fixed tool names (or `unknown`), a traffic hint, calls, successes, errors, duration sum/max and four latency buckets. No individual event log, request ID, IP, user ID, query, argument, prompt, conversation or result content is stored. Calls are not users; unique-user count is unavailable. Durations measure MCP handler completion, excluding the collector request; client network/model time is not measured. Values above 120 seconds are capped.

## Durability and limits

Dedicated Cloudflare Workers Free collector with a D1 Free binding. Parameterized SQL UPSERT increments counters atomically; no in-memory totals or read-modify-write race. The local test uses four independent SQLite connections and reopens the disk database. Remote D1 verification is required separately.

One authenticated write is attempted per identifiable tool call. There is no blind retry or event-ID deduplication history. Collector timeout, quota exhaustion, network outage or terminated function can leave gaps. An ambiguous response can have committed even when the MCP returns `x-world-news-metrics: unavailable`. Totals are operational observations, not billing-grade exact-once records. Collector unavailability preserves tool results and emits a constant warning without user data. Successful acknowledgments are durable; the response header is `x-world-news-metrics: recorded`.

Free quotas are shared with other account usage. As documented September 30, 2026: Workers Free 100,000 requests/day; D1 Free 100,000 rows written/day, 5 million read/day and 5 GB total storage (500 MB/database). Index updates can increase rows-written usage. Free quota exhaustion rejects operations; do not switch to a paid plan. No paid add-on, log drain, scheduler or dashboard authentication is created here.

## Owner access

Use the existing authenticated Cloudflare D1 Console and run `report.sql`; or use the approved local Wrangler OAuth login:

```sh
npx wrangler@4.145.0 d1 execute world-news-sources-metrics --remote --file metrics/report.sql --config metrics/wrangler.jsonc
```

The collector exposes **no read/dashboard API**. A separate owner web dashboard/authentication would require another access design and approval. Daily rows can be exported to plot long-term totals. Retained aggregates do not identify individuals.

## Traffic separation

Operator smoke tests set `x-world-news-traffic: inspection`. Other calls use `unclassified`, not “real users.” This hint is client-supplied and spoofable. Always show total calls across both buckets and label inspection counts as declared; automatic OpenAI scans and ChatGPT demos cannot always be identified. Pre-activation tests are not retrospectively counted. The deployment evidence records the activation timestamp and controlled verification calls.

## Configuration

The MCP uses `METRICS_COLLECTOR_URL` (exact HTTPS `/v1/aggregate` endpoint) and `METRICS_WRITE_SECRET`. Only the dedicated collector's Worker secret and the Vercel project's production secret share the generated write value. Do not put it in source, reports, public plugin ZIP, CLI arguments or owner exports. No account-wide Cloudflare token goes to Vercel. Collector observability/log capture is disabled; infrastructure providers can still process network metadata under their policies.

Before enabling, publish a privacy notice matching the actual aggregate fields, Cloudflare processing and long-term aggregate retention. The public MCP remains unauthenticated; only aggregate writes require the secret.

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
