# Marking operational usage

All operator, agent, development, demonstration and automated verification calls to the public MCP, including intentional invalid inputs, must be sent with `x-world-news-traffic: inspection`. Public source-pack download checks need the same header. This separates our own checks from possible outside use without collecting names, emails or search arguments.

Use the dedicated runner from `packages/world-news-sources-mcp` for a small operational check:

```bash
node scripts/operator-mcp.mjs --tool search_sources --input /tmp/wpr-search-check.json
node scripts/operator-mcp.mjs --export japan-general --format opml --output /tmp/wpr-check.opml
```

The input file is a JSON object containing only the tool arguments, for example `{"country":"JP","limit":1}`. The runner uses the fixed public service, tags every request as inspection, checks for `x-world-news-metrics: recorded` on both successful and unsuccessful calls, follows no redirects, performs no automatic retries and bounds request and response sizes. Output contains the acknowledgment and outcome, not the supplied arguments. An export output file is created with private permissions and cannot overwrite an existing file. The runner calls the cached read-only service; it never starts a publisher audit or article collection.

The CLI has no unmarked mode or arbitrary URL option. If the service fails to acknowledge recording, the check stops. Resolve the recording problem rather than falling back to an unmarked call. An HTTP or MCP error with a recorded acknowledgment remains an inspection error in the aggregate. A network failure can have an ambiguous delivery outcome; do not repeat a call automatically just to obtain a receipt.

Do not use the managed published-plugin connector for our own verification, demonstrations or debugging. That connector cannot attach the inspection header. Do not use the public source-pack download button or an untagged browser navigation for download verification. Use the runner for the actual download. If a check is possible only through an untaggable path, stop that check and report the limitation. Known prior unmarked checks need exact tool names and UTC dates for an explicit operator adjustment before including them in usage claims. Do not invent adjustments for uncertain historical traffic.

Existing tagged paths include `test/http-smoke.mjs`, `test/metrics-live-smoke.mjs`, the quality remote client, the quality investigation client, `scripts/quality-daily.mjs` and the server's first-storage-format collection monitor. Retain their inspection headers when changing transport code. Prefer the dedicated runner for new checks; do not run a broad smoke suite when a single bounded call answers the question.

Usage queries should read the existing aggregate store or reports directly. Querying usage does not require a public MCP call, a download or a publisher fetch. Never generate activity merely to inspect activity.

Daily reporting separates marked inspections, explicitly documented operator adjustments and the remaining unclassified traffic. The remaining traffic is a possible outside-use signal, not confirmed external users or satisfaction. Client-provided inspection hints are not authenticated identities, and anonymous callers cannot be retrospectively classified. Repeat-use estimates cover only supported optional pseudonymous identifiers, exclude marked inspections and remain subject to opt-out and observation-window limits. Source-pack exports do not confirm a successful connection to an external reader.

## Documented prior operator calls

`metrics/operator-adjustments.json` records four verified unmarked calls on 2026-10-23 UTC: three `search_sources` calls (two nonempty results and one zero-match result) and one nonempty `export_source_pack` call. Their aggregate receipt is in the local first-product report and the subsequent documented positive search. Three events occurred before repeat measurement was enabled; the later search contributed one provided identifier. No source queries or identifier values are included in the correction file.

Install this file at the Oracle runtime's `state/daily-summary/operator-adjustments.json`, with private permissions, together with the updated daily summary helper. The helper moves these counts only in the rendered report and preserves the original aggregate store. Adjustments are bounded by available counts, validated as a complete document and applied only to their exact UTC day. Missing or inconsistent adjustments withhold outside-use classification rather than assume all unknown traffic is external. Repeat estimates are withheld on a known operator-presence day and while that day remains in the prior seven-day comparison window. Identifier counts are never blindly subtracted because opt-out can remove presence independently of event totals.

The daily private message shows declared inspections, verified earlier unmarked inspections and remaining unidentified calls. Positive search or export signals cover only instrumented successful outcomes; older calls, errors and missing measurements cannot establish a zero outside-use rate. The existing daily delivery schedule and message deduplication remain in place.
