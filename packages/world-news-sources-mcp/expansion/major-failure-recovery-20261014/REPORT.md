# Major-country failure recovery — October 14, 2026

The targeted recovery is complete and deployed to [World Press Radar Quality](https://news.bymyleslee.com/quality/). Failed active endpoints with an October 14 observation fell from **1,148 to 864**: **282 existing addresses** worked after recheck, and **two individually approved replacements** completed their first production collection. Sustained recovery still needs subsequent regular collections.

| Measure | Result |
| --- | ---: |
| Completed batches | 11 |
| Unique selected typed endpoints | 477 |
| Actual collection events / unique checked endpoints | 354 / 349 |
| Latest nonempty format and URL extraction successes | 284 |
| Selected endpoints never actually checked | 128: 127 policy holds, 1 server wait |
| Active registrations / typed endpoints | 5,097 / 5,497, unchanged |

Selections and checks are deduplicated by endpoint identity. The 865 latest failed observations include one Yomiuri sitemap observation from October 13 that has not been checked today; it is excluded from the 864 October 14 failures. Source registrations and source IDs do not count unique publishers. Extracted URLs do not count published articles or prove full site coverage.

## Approved replacements

[Stuttgarter Nachrichten](https://www.stuttgarter-nachrichten.de/robots.txt) declares its replacement news sitemap in robots.txt. The approved sitemap-to-sitemap change collected **289 URLs**. Its XML contains **289 news publication-date elements and no sitemap lastmod elements**. The current collector reads lastmod only, so its newest-content value remains null; publication dates are present in the XML.

[Diamond Online](https://diamond.jp/list/info/about) declares the replacement DOL RSS feed. The approved RSS-to-RSS change collected **25 URLs**. Its proposal was refreshed against the registry after the Stuttgarter change. Both changes received individual administrator approval through the authenticated production service, preserved source identities and old endpoint history, and initialized a baseline with **zero newly discovered URLs** from the first list. Neither first collection proves longitudinal recovery.

## Date evidence and validation

Among 284 recognized nonempty responses, **272** have reliable, nonfuture content dates within the previous 30 days, **two** have stale dates, **nine** have unreliable date evidence, and **one** has dates the collector does not extract. All 272 recent responses are within seven days; 263 are within 24 hours. Future dates are excluded. Format recognition alone does not establish recent content.

All **411 local code tests**, **396 pinned release tests**, **30 data integration checks**, and the final local HTTP smoke check passed. All 20 encoding regression cases, including successful recognition and expected rejection cases, passed. The production false-positive rate has not been measured. The health merge verified and reparsed **284 cached successful responses**, merged 349 latest actual outcomes, and preserved the original full audit without additional publisher requests or ledger writes.

Production is **READY**, with the public activity snapshot generated at **19:48:42.050 UTC**. Deployment and production alias receipts were verified; no additional fetch of the new deployment URL was performed. This recovery made no paid provider calls. The approved combined pilot budget remains **$0.076268448 held of $5**, with four completed runs, 323 settled reservations and none pending.

## Remaining work

Confirm continued collection during the next regular window, **October 15 at 03:00 UTC / October 14 at 22:00 Chicago time**. Continue cause-based work on the 864 remaining failed active endpoints. The largest saved causes are HTTP 403 (307), wrong endpoint format (169), HTTP 404 (122), invalid XML (67), disallowed DTD (60), and timeout (51). Access restrictions remain held; obsolete URLs require official replacement discovery and individual approval; invalid XML requires contract diagnosis; transient timeouts and server retry waits require bounded rechecks. These failures do not automatically disable an entire registration or its healthy paired address. The stricter robots and redirect wrapper applies to this targeted recovery only; the normal daily collector retains its existing robots handling. Long-term reliability and anomaly detection accuracy remain unproven.

Evidence comes from completed production batch, approved application, first-collection, health-merge, postflight inventory, test and deployment receipts. The postflight inventory was observed at 19:58:11.755 UTC. Public evidence contains aggregate metadata and official declaration links, with no raw feed bodies, credentials, private service coordinates or local filesystem paths.
