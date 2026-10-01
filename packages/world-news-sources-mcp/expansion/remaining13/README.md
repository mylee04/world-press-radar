# Remaining 13 major-country discovery — second batch

This is an **unapplied, verified candidate batch** on top of the first live batch. Oracle handles merge/collection/deployment; no registry, production health, ledger, site/demo, scheduler or credentials were changed here. No paid resource or GitHub push.

## Current state and scope

Three inspection-labelled live MCP calls confirmed **5,030 active registrations, 3,664 distinct RSS and 1,747 distinct sitemap endpoints, 72 active countries**. First batch initial enabled time observed through The Maple: **2026-10-01T20:11:07.987Z**. Parent reports deployment `dpl_7bBizprQw5MMSNghAyg6Cp6Zf7ru` with all eight new endpoints working and 3,477 baseline URLs excluded. Raw inspection results: `../second-pass-live-before.json`.

All remaining selected existing countries received scoped attention: **CN, IN, BR, AU, KR, MX, ID, TR, RU, SA, ZA, AR, ES**. US Grist/War on the Rocks received additional attention as outstanding G7 priorities. Together with the first pass, **all selected 20 countries have received a bounded discovery pass**. This does not imply complete national coverage or exhaustive publisher discovery.

19 publisher seed records, **84 governed network attempts** (75 main/follow-up + nine final comparisons), 28 XML attempts / **25 distinct typed endpoints**. Redirects and unsuccessful attempts are included; official About-page web research is outside the scripted totals. Main phase budget 144 lifetime governed attempts; final comparisons budget 20. Global concurrency two (one for final checks), one per host, two-second host gap. Current robots reviewed before candidate fetch; ordinary public XML only, DNS-pinned sanitized fetch, 8-second XML cap, 4 MiB RSS / 8 MiB sitemap. No article-page fetches; XML body/description fields are discarded.

## Proposed additions

**Four previously unregistered publisher domains, four registrations, five typed endpoints (three RSS, two sitemap).** No existing row/ID/state/history changes and no disabled-row reactivation.

| Country/source | Endpoint | Real XML output | Checked at UTC | Date evidence |
| --- | --- | ---: | --- | --- |
| TR / Medyascope | RSS | 12 URL entries | 2026-10-01T20:22:32.450Z | recent feed item dates |
| ZA / GroundUp | RSS | 15 URL entries | 2026-10-01T20:22:53.311Z | recent feed item dates |
| AR / elDiarioAR | RSS | 98 URL entries | 2026-10-01T20:22:58.565Z | recent feed item dates |
| AR / elDiarioAR | rolling news sitemap | 58 URL entries | 2026-10-01T20:23:07.976Z | recent sitemap lastmod |
| RU / Mediazona | rolling news sitemap | 26 URL entries | 2026-10-01T20:28:19.105Z | recent sitemap lastmod |

`registry-additions.json` contains exact URLs/typed IDs, official declarations/page hashes, real completion timestamps, output samples and current robots decisions. Mediazona's rolling child was explicitly enumerated by its officially declared sitemap index. elDiarioAR RSS+sitemap share one source for overlap deduplication.

Counts are available entries, not daily NEW or publication totals. Sitemap lastmod is not article publication time. RU describes Mediazona's Russian-language/Russian-affairs editorial scope, **not current legal headquarters**. Official publisher references: [Medyascope imprint](https://medyascope.tv/kunye/) (Istanbul), [GroundUp About](https://groundup.org.za/about/) (South African agency), [elDiarioAR About](https://www.eldiarioar.com/quienes-somos/) (Argentine publisher), [Mediazona](https://zona.media/) (editorial scope inference, disclosed above).

After applying unchanged, projected inventory: **5,034 registrations, 3,667 RSS, 1,749 sitemap; still 72 active countries**. Per-country before/after projections are in `report.json`; these are not yet live totals.

## Honest no-addition outcomes

| Country | Scoped result / reason no source was added |
| --- | --- |
| CN | Sixth Tone's official HTTP RSS and existing HTTPS RSS resolve to the same final API URL and identical 51-URL-set digest. Existing HTTPS freshly revalidated; no alias registration. |
| IN | The Wire, Newslaundry and The News Minute: no eligible official declaration found in the bounded homepage/robots scope. Not proof that RSS is unavailable. |
| BR | Brasil de Fato maps work, but include homepage/sections/about/navigation. Portuguese map has 250 dated paths among 307 entries. Mixed scope deferred, not labelled a clean article stream. |
| AU | Michael West homepage 403; no bypass. |
| KR | Korea Pro and Newstapa: no eligible declaration in bounded scope; no guessed feed paths. |
| MX | Pie de Página's officially declared RSS is malformed; no healthy source inferred. |
| ID | Project Multatuli homepage 403; no bypass. |
| SA | Official rolling news sitemap already configured and working. Fixed month partition omitted rather than adding a soon-frozen duplicate stream. |
| ES | El Salto robots returned 406 and policy stayed unknown. El Confidencial had no eligible declaration in bounded scope. |

Further exclusions: Medyascope numbered archive partition; GroundUp's 20,021-entry mixed archive (16,971 `/article/` paths, uncertain remainder); Mediazona month partition replaced in the proposal by its explicitly declared rolling news child; Grist archive/award URLs and War on the Rocks tag map. Current lastmod alone does not establish current article publication.

XML check totals: RSS five nonempty / one malformed; sitemap 19 nonempty, including indexes and excluded archives/navigation. These are **checks**, not additions or unique publishers. Every candidate decision, type/country totals and homepage outcomes are retained in `report.json`, `checkpoints.json`, `targeted.json`. No-result countries remain eligible for a later focused official-guide pass.

## Safe operator/Oracle handoff

This branch includes additive operator/evidence files only. The current production release contains newer site/demo/submission changes: preserve those and all current activity history shards. Never deploy the older worktree wholesale or replace the authoritative DB with the committed sample.

The expected registry SHA is **ec64bf054b506c0184dd7bd172338b709bb3ab69f0320a97998cae9a3b332b10**. It is reconstructed deterministically from the original registry plus the first approved batch using its live initial enabled time. **Oracle must compare it to the actual current registry**; a mismatch requires reconciliation, not overriding the guard. The included dry run reconstructs in memory, never changes the registry.

1. Between runs, hold the existing runner overlap lock and use the latest release/authoritative registry and DB.
2. Cherry-pick/transfer this additive evidence and test change; preserve current deployment assets. Build/test, then dry run:

   ```sh
   WNS_REGISTRY_PATH=/path/to/current/data/rss-atlas.json node scripts/add-registry-sources.mjs expansion/remaining13/registry-additions.json
   ```

3. Once hash/evidence match, append `--apply` for atomic local registry edit. Actual application time becomes each new initial enabled datetime; transition history remains empty/count zero. Existing unknown/history timestamps are preserved. Operator refuses old evidence (>seven-day XML, >one-day robots), duplicates and invalid XML/policy.
4. Use the existing collector with the **five typed endpoint IDs in `dry-run.json`**, authoritative `WNS_ACTIVITY_DB`, `--limit 5`, existing daily budget and controlled `--force` if needed. No new timer or ledger.
5. First successful binding collections are excluded baselines. Never use discovery counts/samples as activity history, never call the initial available URLs daily NEW. Deduplicate elDiarioAR RSS+sitemap within source and across country sources through the existing durable ledger. Failures remain uninitialized/partial rather than fabricated zero.
6. Export full durable history and preserve the latest site/demo/challenge/policies/archive manifest. Deploy through the existing scoped free workflow. Verify real live source/details/health/inventory/activity baseline plus unchanged old records/history. No tool signatures changed, so no connector reinstall is needed solely for this data batch.

`verified-health-additions.json` is partial actual-check metadata for five new endpoints. `verified-existing-health.json` revalidates the exact already-configured Sixth Tone HTTPS endpoint. If merging, preserve every existing observation and **do not advance completed-full-audit time** from this partial pass. Oracle collection uses fresh real XML, not sampled health entries.

Extra steady-state load: about **five checks/day** plus existing bounded transient retries. First available output is at most 209 returned entries across these five current snapshots before deduplication; this is not an asserted unique baseline URL count. No large archive is included. No new persistent access, credentials or costs are required.

## Tests and next priorities

**78/78 tests pass**, including the existing seven-tool/transport suite. Three new regressions check the precise incremental registry state and preserved first-batch activation/history, all remaining13-country attention and proven alias/excluded archive decisions, plus robots wildcard/end/bot-group/encoding matching. Existing tests cover new-binding excluded baselines, cross-endpoint/country dedup and failure separation. Build and typecheck pass. Another **20/20 related tests pass against a temporary full registry with both batches applied**, confirming the suite survives the data update. Inventory assertions now derive expected totals directly from raw stored registry rows/typed URLs, instead of freezing old counts. Historical operator fixtures remove only our owned batch rows and bind checksums in memory; production batch checksums and guards remain unchanged. All tests use isolated fixtures/temporary inspection ledgers; production is unchanged. `TEST-EVIDENCE.json` records the commands and hashes.

Next: apply and baseline-verify this compact batch first. Future bounded discovery should prioritize better official current G7 endpoints (especially US), then official publisher RSS guides for India/Korea/Spain and clean article-only Brazilian declarations. Retain blocked outcomes and revisit only through normal access, never endless retries or inferred healthy paths. No country additions or bulk activation.
