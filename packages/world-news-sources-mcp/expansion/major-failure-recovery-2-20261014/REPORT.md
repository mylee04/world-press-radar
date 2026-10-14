# Major-country failure recovery, round 2 — October 14, 2026

Production rechecks confirmed recovery of **four UOL section feeds**, reducing failed active endpoints with an October 14 observation from **864 to 860**. Ten previously working feeds also passed compatibility checks; they are excluded from the recovery count. The latest failure inventory contains 861 failures because it also includes one Yomiuri sitemap observation from October 13 that has not been checked today.

| Measure | Result |
| --- | ---: |
| Completed batches | 4 |
| Selection events / unique selected typed endpoints | 76 / 72 |
| Actual collection events / unique checked endpoints | 36 / 32 |
| Latest nonempty successes | 14: 4 recoveries, 10 compatibility checks |
| Selected endpoints never actually checked | 40: 32 policy holds, 8 server waits |
| Active registrations / typed endpoints | 5,097 / 5,497, unchanged |

UOL explicitly declares ISO-8859-1 in its HTTP XML Content-Type header but omits an XML encoding declaration. The collector previously failed when it decoded the bytes as UTF-8. Passing the recorded MIME charset to strict decoding now works in actual collection and repair validation. Undeclared encoding is not guessed, required RSS metadata checks remain, and arbitrary sitemap namespace variants are not treated as equivalent. See [RFC 7303](https://www.rfc-editor.org/rfc/rfc7303.html#section-3.2), the [RSS specification](https://www.rssboard.org/rss-specification), and the [sitemap protocol](https://www.sitemaps.org/protocol.html).

The four feeds each yielded 15 canonical URLs: **60 extracted URLs**, with **zero newly discovered URLs from their first baseline lists**. All four still have unreliable date evidence and no extracted newest-content date, so there are **zero recent-content confirmations**. Format recognition does not prove date reliability, publication totals or complete publisher coverage; four section feeds are not four publishers.

All **428 local tests**, **413 pinned-release tests**, **30 data integration checks**, and ten production compatibility checks passed. The new test coverage includes 16 MIME cases and one repair-path case, with both successful recognition and expected rejection cases. The production false-positive rate and long-term recovery are not yet measured.

No registrations changed and no paid provider calls occurred. Four quality-service validator modules were updated while model guards and protected runtime tables stayed unchanged. Five private repair-evidence files were copied with verified hashes, preserving two previously applied proposals and one proposed record; the copy approved or applied no new source changes. Tracking history, known baselines and timer settings were preserved. The approved budget ledger records a **$0.076268448 cumulative estimate of the $5 approved limit**, with four prior quality runs, 323 settled reservations and none pending.

The collector and quality validator updates are active, and [World Press Radar Quality](https://news.bymyleslee.com/quality/) is deployed with a **READY** production receipt. Its activity snapshot was generated at **21:27:51.107 UTC**. The 49-file public bundle changed three validator modules; deployment and production alias receipts were verified at 21:36:54.224 UTC. The final local HTTP smoke check passed; the metrics endpoint check was not configured. No additional fetch of the new deployment URL was performed.

Research used a selected roster of 57 major-publisher endpoint anchors, including 17 US/Canada and 18 Asia/Europe address entries. Those selections overlap diagnostics and actual checks and are not an exhaustive global survey. No exact same-type, same-scope replacement is ready for application. Continue cause-based work on the remaining 860 failed active endpoints, respecting the 32 policy holds and eight server waits in this selected set. Confirm sustained collection during the next regular window, **October 15 at 03:00 UTC / October 14 at 22:00 Chicago time**. The stricter robots and redirect wrapper applies to this targeted operation only; the ordinary daily collector retains its existing robots handling.

Evidence comes from completed production batch and baseline-verification receipts, a postflight inventory observed at 21:29:25.128 UTC, cache integrity and health-merge receipts, runtime preservation receipts, final test logs, and the READY deployment receipt. Public evidence contains aggregate metadata and official links, without raw feed bodies, credentials, private service coordinates, approval identifiers or filesystem paths.
