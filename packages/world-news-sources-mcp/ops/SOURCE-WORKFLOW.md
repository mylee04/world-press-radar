# Curated source workflow

This workflow connects a monitoring purpose to a bounded source selection, saved endpoint evidence and an importable collector configuration. It introduces no registry changes, paid model calls, new collection schedule or article fetching in MCP calls.

## Selections and provenance

The versioned [curation document](../curation/source-packs.json) contains three starter selections: `us-business` (six publishers), `japan-general` (six publishers, including regional and explanatory coverage), and `korea-english` (three publishers, including specialized North Korea coverage). Every selected address is matched by country, endpoint type and canonical URL to existing registration IDs. Language, topics, aliases, section scope and official evidence are attached to those selected bindings only. Unregistered addresses remain explicit gaps rather than becoming invented registrations.

These selections are not complete national major-media lists, neutrality ratings or guarantees of usable articles. Each pack includes its known gaps and selection criteria. Official provenance establishes a declared address or scope; it does not establish universal current availability.

## Status and export policy

`get_source`, `get_endpoint_health` and pack endpoints retain the original structural audit fields and add `status_evidence`. The combined assessment uses the latest eligible actual collection or structural audit. The response preserves both observation times, their provenance, conflicts, content dates and nulls. Export generation time is never substituted for observation time. Invalid or future evidence is ignored; missing or corrupt required collection history is reported as unavailable evidence.

A valid empty feed, sitemap index and failed request have separate outcomes. Zero newly discovered URLs alone is not a failure. The first excluded baseline, an untracked null and a confirmed zero remain distinct. A content date older than 30 days is labeled by that explicit age rule; it does not estimate a publisher's normal cadence. Missing content dates cannot certify freshness.

A nonempty XML document with an explicitly recorded zero usable entry URLs does not establish article-list usability and is excluded. Compressed historical records do not retain total observed URL counts; their nonempty status is a saved XML outcome, with that evidence limit stated explicitly. URL totals are never borrowed from a different dated audit.

Default exports require an enabled registered binding, usable nonempty article-URL XML evidence at most 36 hours old and no stale or unreliable recorded content date. A missing content date remains explicitly unknown and may be included. The 36-hour cutoff accommodates a daily saved observation; it is a policy limit, not a live guarantee. Failed, unknown, stale, empty and index-only endpoints are excluded. Explicit `include=all` retains registered diagnostic entries and their exclusions, never converts them into working sources.

OPML contains RSS/Atom only and reports omitted sitemap counts. CSV/JSON preserve endpoint types and the separate collection, audit and content timestamps. CSV guards spreadsheet formula prefixes; XML escapes untrusted names and URLs. Exports are bounded and do not fetch publishers or article links. Importers that need sitemaps must use the typed exports rather than an RSS-only OPML file.

## Public interfaces

- MCP: `list_source_packs`, `get_source_pack`, `export_source_pack`; refresh an existing MCP connection's tool list after deployment.
- Search: `search_sources` accepts `pack_id` and curated aliases; `curation.matching_endpoint_ids` identifies which endpoints support curated language/topic matches.
- Homepage: `/` presents the selections in English by default, with Korean optional.
- HTTP: `GET /source-packs` and `GET /source-packs/{pack_id}/export?format=opml|csv|json`; add `include=all` only for diagnostic exports. These routes are read-only.

The submitted plugin skill source now documents the workflow. A deployed MCP change does not prove that a previously installed ChatGPT plugin has refreshed its tool cache or that directory skill metadata has been republished. Existing metric ingestion retains its bounded allowlist; new pack tool calls are acknowledged under `unknown` until a separate counter schema rollout. No user/query tracking is added.

## Acceptance and remaining validation

Implementation checks cover endpoint time/provenance selection, null/baseline distinctions, archive integrity and read-once scaling, selected-binding search scope, active shared bindings, safe OPML/CSV serialization, typed JSON, exclusions, bounded pagination, HTTP methods/queries and transport packaging. Browser acceptance covers all three selections, English/Korean text, mobile overflow, gaps and actual file downloads using a saved production metadata snapshot. A bounded consumer probe can parse exports and fetch only their configured XML documents; its checker environment and times must be recorded separately from production history.

These checks establish software behavior and saved-data consistency. They do not establish end-user time savings, external collector compatibility across all products, editorial balance, full-article ingestion, publication completeness or long-term anomaly-detection accuracy.

On October 16, local acceptance used the unchanged production snapshot generated at `2026-10-16T03:59:28.999Z`. Default exports contained 14 typed addresses: 13 RSS and one sitemap. All three OPML files parsed and matched the RSS subset of JSON. An independent bounded macOS consumer received and parsed 12 configured XML documents. Two were held before an endpoint request: ABC News because its robots request redirected outside the probe's exact-host rule, and Korea Times because robots returned HTTP 204 rather than a verifiable policy document. These holds do not establish endpoint failure. Korea Herald was separately excluded by its saved production failure. No article/child requests, full recollection or production status writes were performed by this consumer proof.

The repository suite passed 472 tests; the production-derived release passed 457 tests with its existing model policy and dependencies preserved. The exact 54-file public bundle passed SDK/legacy MCP, current saved country activity, download and desktop/mobile acceptance before deployment. Independent review corrections covered archive caching, typed search scope, shared active bindings, structured gap rendering and zero usable entry URLs. The [dated rollout receipt](SOURCE-WORKFLOW-2026-10-16.json) records production readiness and preservation checks. Public aliases were confirmed through deployment management; the new deployment URL was not fetched for acceptance. Existing primary history, excluded baselines, five repair files, private quality application code, runtime/history logical records and timer files were preserved. The next daily disk guard passed with over 50 GiB reserved.

The next pilot should ask a few consenting users to start Japanese monitoring from a blank collector configuration. Record time to select sources, distinguish saved status from current content, import the configuration and receive the first item; compare against manual publisher research. Record failures and missing major publishers without collecting article bodies or user queries. No user recruitment or messages are sent automatically.
