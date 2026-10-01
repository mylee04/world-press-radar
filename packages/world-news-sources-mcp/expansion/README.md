# G7 source expansion — verified first batch

**Local, unapplied proposal.** Production registry, Oracle ledger, cached production health, website/demo and deployment are untouched. No GitHub push, new resource, credential, paid API or upgrade.

## Selected existing countries and inventory

G7 first: **US, GB, CA, FR, DE, IT, JP**. Other selected countries: **CN, IN, BR, AU, KR, MX, ID, TR, RU, SA, ZA, AR, ES**. All 20 already exist in the registry. This is a practical economic/news-relevance selection, not a GDP ranking. No country is added.

`major20-inventory-before.json` contains the exact live country inventory, read through **two inspection-labelled MCP calls**. Snapshot: **2026-10-01T03:18:30.615Z**. Global active totals: 72 countries, **5,023 source registrations, 3,661 distinct typed RSS endpoints and 1,742 distinct typed sitemap endpoints**. Registrations are not unique publishers or healthy-endpoint counts.

## Verified proposal

**Seven new registrations / eight previously unconfigured typed endpoints: three RSS and five sitemap.** Two previously unregistered publisher domains (The Maple, Novara Media), plus five alternative/additional-language registrations for existing publishers. Maple RSS and posts sitemap share one new source, so their overlapping article URLs can be deduplicated within the source. Existing rows/IDs/status histories stay unchanged; no disabled row is re-enabled.

| Country / source | Type | Actual XML output | Checked at (UTC) | Date evidence |
| --- | --- | ---: | --- | --- |
| CA / The Maple | [rss](https://www.readthemaple.com/rss/) | 15 URL entries | 2026-10-01T19:41:06.182Z | feed_item_date: recent |
| CA / The Maple | [sitemap](https://www.readthemaple.com/sitemap-posts.xml) | 1393 URL entries | 2026-10-01T19:41:13.144Z | sitemap_lastmod: recent |
| GB / Novara Media | [rss](https://novaramedia.com/feed/) | 10 URL entries | 2026-10-01T19:41:18.077Z | feed_item_date: recent |
| FR / Capital (Official RSS) | [rss](https://feed.prismamediadigital.com/v1/cap/rss?limit=20) | 10 URL entries | 2026-10-01T19:31:22.165Z | feed_item_date: recent |
| GB / Halifax Courier (News Sitemap) | [sitemap](https://www.halifaxcourier.co.uk/sitemaps/googlenews) | 51 URL entries | 2026-10-01T19:31:14.967Z | sitemap_lastmod: recent |
| DE / Kölner Stadt-Anzeiger (News Sitemap) | [sitemap](https://www.ksta.de/xml/newssitemap.xml) | 302 URL entries | 2026-10-01T19:31:25.209Z | sitemap_lastmod: recent |
| IT / Il Giornale (News Sitemap) | [sitemap](https://www.ilgiornale.it/arc/outboundfeeds/sitemap-news/latest/) | 133 URL entries | 2026-10-01T19:31:42.315Z | sitemap_lastmod: recent |
| JP / Nippon.com (Japanese News Sitemap) | [sitemap](https://www.nippon.com/ja/googleNews.xml) | 1623 URL entries | 2026-10-01T19:36:58.323Z | sitemap_lastmod: unreliable |

`registry-additions.json` is authoritative for exact URLs, typed IDs, check timestamps, official declaration URLs/page hashes, XML formats, up to three output samples, and robots reviews. Capital's provider-hosted RSS is explicitly declared by its official homepage. Sitemap children were explicitly enumerated by validated parent indexes; no guessed URL was accepted.

These counts are available URL entries, **not daily NEW or article publication totals**. Sitemap lastmod is separate from RSS publication dates. Nippon's dates remain unreliable. URL heuristics cannot establish that every candidate URL is an article; no article bodies were fetched.

If applied unchanged: **5,030 active registrations; 3,664 unique RSS + 1,747 unique sitemap endpoints; still 72 active countries.** These are projections, not deployed totals. Publisher references: [The Maple](https://www.readthemaple.com/about-us/) identifies Canadian operations/association; [Novara Media](https://novaramedia.com/about/) identifies its England/Wales publisher.

## Measured scope and exclusions

18 publisher seed records across G7; 105 governed discovery attempts plus eight targeted robots-review attempts (**113 total**, including redirects/unsuccessful attempts). XML: 50 attempts, **49 distinct typed endpoints** (7 RSS, 42 sitemap). Two were already cataloged. Primary About-page browser research is outside scripted totals.

| XML status | RSS | Sitemap |
| --- | ---: | ---: |
| working_nonempty | 5 | 34 |
| valid_empty | 0 | 3 |
| timeout | 0 | 3 |
| malformed | 2 | 1 |
| bounded incomplete | 0 | 1 |

The 34 nonempty sitemap results include **15 indexes**. Index children are sitemap references, not articles. The remaining 13 selected countries have not yet had a discovery pass. This is not a full registry health audit.

- Basta! RSS parsed 11 entries but its current robots wildcard rule disallows the path. Excluded from additions and future collection. Its mixed section/homepage sitemap is deferred too.
- Reporterre homepage/robots returned 403; no bypass or further guesses.
- CORRECTIV and a Narwhal leaf timed out at eight seconds. Nippon's large Japanese article sitemap exceeded 8 MiB. These remain failures/incomplete, not healthy by inference.
- Grist, Narwhal and War on the Rocks archive partitions were deferred. Recent archive lastmod does not prove recent publication.
- Il Post's declared October leaf was valid-empty; tags are not article streams. Monthly archives were not installed as permanent rolling feeds.
- Halifax's new RSS URL still returned the wrong format. Its sitemap works separately. Capital/KSTA/Il Giornale old failed RSS remain unchanged.
- Mainichi English RSS and Capital news sitemap were already configured: reverification is not an addition.

`report.json` provides country/type totals and a decision for every checked candidate; checkpoint files retain provenance/checks. Global concurrency was two initially, one afterward; one request per host, two-second host gap. Existing sanitized DNS-pinned fetch, 8-second XML timeouts, 4 MiB RSS / 8 MiB sitemap caps. No credentials, paid services, access-control workarounds, article-body fetches or persistent scheduler.

The discovery scripts are bounded operator experiments. A final current robots review is mandatory for selected candidates. The targeted review handles wildcard/end/longest-match for selected paths; [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) is the primary reference.

## Coordinate application with the Oracle task

This worktree starts at **80265a77559e6710e78a821085396686d7ac26c1**. Production may have newer demo/submission patches. **Transfer the additive operator files/evidence only; do not redeploy this entire older worktree or replace the authoritative ledger with its committed activity sample.** Parent reports portal 0.2.0 In review at Oct 1 19:17 UTC. Listing, demo, ZIP, policy and ownership files are not changed here.

1. Between runs, use the existing shared runner overlap lock. Confirm current authoritative release, registry, DB and preserved site/demo/history with the parent/Oracle task.
2. Build/test the current release plus `src/operator-additions.ts`, `scripts/add-registry-sources.mjs`, its test and `expansion/` evidence. Dry run:

   ```sh
   npm run build
   WNS_REGISTRY_PATH=/path/to/current/data/rss-atlas.json node scripts/add-registry-sources.mjs expansion/registry-additions.json
   ```

3. The operator rejects registry hash drift, duplicate/disabled typed endpoints, observation identity/type mismatch, indexes/empty/failed XML, checks older than seven days, robots reviews older than one day or disallowed rules. Reconcile evidence instead of bypassing guards. After coordination, append `--apply` to atomically edit the local authoritative registry under the status-operator lock. Replay preserves later operator deactivation/history.
4. Initial enabled datetime is **actual apply time**, initial-state reason, empty transition history/count zero. No invented disabled→enabled transition. Future status changes use `source:status`. Existing historical unknown dates remain unknown. XML checked_at is separate.
5. Collect the exact **eight endpoint IDs from `dry-run.json`** using the existing collector and authoritative `WNS_ACTIVITY_DB`, `--limit 8`, existing daily budget and optional controlled `--force`. Do not create a new ledger or timer.
6. First successful collection for each new binding is an **excluded baseline**. Preexisting archive URLs never become daily NEW. Failed checks remain uninitialized, not valid-zero. RSS+sitemap source overlap and country-wide overlap deduplicate through the existing ledger. Never backfill discovery samples/counts into activity history.
7. Export full history from the authoritative DB. Verify baseline initialization, preserved old counts and partial coverage. Deploy via the existing project-scoped free workflow, preserving current demo/site/challenge/policies and every manifest-listed history shard.
8. Verify deployed initialize/list/calls: new source details, per-endpoint health, inventory and baseline activity, plus unchanged original endpoint status/history. Tool signatures are unchanged: no new ChatGPT connector install is required solely for registry additions.

`verified-health-additions.json` contains **only eight partial discovery observations**, not a completed full audit. Any targeted merge must preserve original observations and must not advance `lastCompletedFullAuditAt`. Prefer the authoritative collection/health workflow. No production merge or deployment has been performed here.

Steady-state extra collection load: roughly **eight endpoint checks/day**, plus existing bounded transient retries. First initialization adds eight bindings and relationships for actual returned URLs. No new infrastructure/permission is needed. Real storage growth depends on publisher output; retain existing capacity caps and observe actual growth.

## Validation and next batch

**75/75 tests pass**, including six addition regressions: unchanged old rows/IDs/status, real initial datetime, idempotent replay after deactivation, scope/duplicate/disabled and invalid XML/robots rejection, source/country excluded baselines/dedup, test-lane separation, original failed RSS health preserved beside a healthy alternative. All prior seven-tool/transport tests pass. TypeScript build/typecheck pass. `dry-run.json` records the unapplied proposal. Temporary inspection ledgers are never production data.

After applying/baseline-verifying this batch, prioritize official current US endpoints (better official guidance for Grist/War on the Rocks), then unresolved G7 candidates, then the existing other 13 selected countries. No country additions or bulk reactivation.
