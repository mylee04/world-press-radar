---
name: find-news-sources
description: Find configured publisher RSS feeds or sitemaps by country, name, domain, language or category, and explain their cached endpoint health when requested.
---

Use the World News Sources MCP tools for source discovery and cached endpoint metadata. Follow the user's requested scope and output format.

- Use `search_sources` for a source shortlist. Country codes, `endpoint_type` (`rss` or `sitemap`), query, language and category can narrow it. `enabled` is a configuration flag, not a health result.
- Use `list_countries` when supported countries or configuration counts are requested. Continue with `next_offset` when another page is needed; counts are not unique publishers or live feeds.
- Use `get_source` with an ID returned by search for details. Keep RSS and sitemap endpoints separate.
- For requested health or working-source comparisons, use `get_endpoint_health` with returned endpoint IDs, at most 20 per call. If `remaining_endpoint_ids` is nonempty, request those separately. Do not invent IDs, URLs or results.

Present the source name, country, endpoint type and configured URL. Add the recorded status and actual `checked_at` when discussing availability. `healthy` means a recent structural XML check succeeded; inspect `audit_status`, `entry_count` and `entries_with_url` for empty documents or absent URL outputs. A cached result is not a new live check.

Keep `newest_content_at` and `content_freshness` separate from `checked_at`. Missing dates cannot establish freshness. Report stale, unreliable, blocked, failed, unknown and incomplete results plainly. A sitemap success cannot establish RSS health. `sitemapindex` counts and sample URLs describe child sitemap entries; they do not establish article availability or child-file validity.

These tools provide source metadata, not article search or full text. They do not fetch publishers during calls, crawl children or article links, change the registry, or run the operator audit. For unsupported requests, explain this capability boundary and offer relevant source discovery or cached results without claiming the unsupported action occurred.
