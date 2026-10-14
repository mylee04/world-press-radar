# Saved production episode replay, October 14, 2026

`cases.json` freezes 20 diagnostic source/date groups with 22 endpoint episodes, plus four contrasting multi-source stress groups that reuse nine of those episodes. The total is 24 groups and 31 endpoint appearances, covering 16 distinct normalized sources and 18 distinct typed endpoints. Within the original diagnostic set, seven endpoint episodes require confirmation of a saved failure, access/parsing failure, or dated content concern; fifteen are negative triage controls. This is a bounded case study, not a random sample or demonstrated production incident accuracy.

The labels describe what the saved evidence supports for each selected UTC date. They do not establish a current outage, an independently confirmed root cause, complete publisher output, or sustained recovery. Selection and date/status adjudication were performed by the assistant, with existing production rules used afterward as a consistency check. `independent_operator_review` and `external_incident_truth_verified` are both false. These are not independent human incident labels or a hidden held-out accuracy benchmark.

## Evidence provenance

The source capture is `output/news-quality/language-en-ko-20261014/production-metadata-after-activation/`. Its retained capture receipt records a read-only capture at `2026-10-14T05:03:49.263191+00:00`, 5,437 registry rows, 58,803 ledger/exported collection rows, and no collector start or export start during that capture. The frozen activity clock is `2026-10-14T05:00:48.369Z`. No publisher requests, model calls, keys, production writes, or source changes were made while curating this dataset.

The original monthly archive descriptor is `2026-10-ac5f108006b4f8b6812a3170b17b382a8a3e04082bf3f2acff462fd7ac7a079a.json.gz`, with 942,138 compressed bytes and 58,803 records. Its SHA-256 and byte length were checked through the existing `readHistory` implementation before materialization. Each group retains path/hash provenance for the registry, activity manifest, health export, archive, and capture receipt, plus pointers to its exact original registry rows, bindings, and endpoint-health observations. Yomiuri groups also reference the first scheduled collector postflight. The source files under `output/` remain private operator evidence and are not required to execute the self-contained frozen replay.

Every group preserves all typed endpoints of its actual normalized source, including the two endpoints each of Linkiesta and 시사IN. Normalizing the exact retained registry rows was checked to reproduce the original source and endpoint IDs. Ordered collection records were materialized from the checksum-verified archive without inventing checks, changing timestamps/statuses/counts, deleting later records, or backfilling completed collector cycles. Optional saved sample article links and non-decision diagnostics were omitted from `health_snapshot`; health dates, statuses, reasons, content dates, formats and counts retain their original values.

The compact archive does not retain HTTP/error-reason details for every collection. Null reasons stay null. A saved older health reason cannot establish the cause of a newer collection failure. For example, El Sol's older `HOST_COOLDOWN` health result does not independently diagnose its October 13 incomplete collection. The retained Yomiuri raw cycle observation separately records HTTP 429 at `2026-10-14T03:15:57.795Z`; this fact is not reconstructed from an absent archive field.

## Episode selection

| Group ID | Source and selected UTC day | Endpoint adjudication |
| --- | --- | --- |
| `mx-el-sol-prior-success-failure-20261013` | El Sol de México, October 13 | `failure_after_prior_success` |
| `be-newsmonkey-prior-success-timeout-20261013` | Newsmonkey, October 13 | `failure_after_prior_success` |
| `pt-campanario-prior-success-timeout-20261013` | Rádio Campanário archive sitemap, October 13 | `failure_after_prior_success` |
| `it-linkiesta-mixed-baseline-and-403-20261014` | Linkiesta, October 14 | RSS baseline: `successful_no_new_discoveries`; HTTP 403 sitemap: `access_failure_without_normal_baseline` |
| `jp-yomiuri-full-sitemap-429-20261014` | Yomiuri full sitemap, October 14 | `access_failure_without_normal_baseline` |
| `eg-shorouk-malformed-no-baseline-20261014` | Shorouk Citizens RSS, October 14 | `access_failure_without_normal_baseline` |
| `ar-chequeado-dated-stale-content-20261014` | Chequeado RSS, October 14 | `stale_content_evidence` |
| `mx-el-sol-saved-recovery-20261014` | El Sol de México, October 14 | `recovered_after_failure` |
| `be-newsmonkey-saved-recovery-20261014` | Newsmonkey, October 14 | `recovered_after_failure` |
| `ar-mdz-recovery-initial-baseline-zero-20261014` | MDZ Tecnología, October 14 | `recovered_after_failure`, with an excluded initial baseline and NEW = 0 |
| `pt-campanario-recovery-priority-over-old-date-20261014` | Rádio Campanário archive sitemap, October 14 | `recovered_after_failure`, despite old lastmod and NEW = 0 |
| `no-tv2-sykkel-measured-zero-20261014` | TV2 cycling RSS, October 14 | `successful_no_new_discoveries` |
| `my-free-malaysia-zero-missing-content-date-20261014` | Free Malaysia Today article sitemap, October 14 | `successful_no_new_discoveries`, with missing content date |
| `gb-bbc-index-only-20261014` | BBC sitemap index, October 14 | `index_only` |
| `us-reuters-index-only-20261014` | Reuters sitemap index, October 14 | `index_only` |
| `us-the19th-initial-baseline-zero-20261014` | The 19th RSS, October 14 | `successful_no_new_discoveries`, initial binding baseline |
| `kr-sisain-two-endpoint-baselines-20261014` | 시사IN, October 14 | Both RSS and sitemap: `successful_no_new_discoveries`, independent initial binding baselines |
| `jp-yomiuri-latest-not-attempted-deferred-20261014` | Yomiuri latest sitemap, October 14 | `not_attempted_in_period`, with a retained same-host deferral exception |
| `us-the19th-no-checks-before-first-baseline-20261013` | The 19th, October 13 | `untracked_or_no_available_checks`, before its first available October 14 collection |
| `kr-hankyung-success-positive-discoveries-20261014` | 한국경제 real-estate RSS, October 14 | `successful_collection`, with 25 first-discovered candidate URLs |

Four additional groups stress result-dependent selection and contrasting evidence. They preserve exact original source rows, all sibling endpoints, and a coherent selected country/date. They do not add independent incident labels:

| Stress group ID | Frozen sources | Contrast |
| --- | --- | --- |
| `stress-jp-yomiuri-access-versus-unattempted-20261014` | Yomiuri full and latest sitemap sources | Failed check versus no selected-day attempt |
| `stress-us-reuters-index-versus-first-baseline-20261014` | Reuters index and The 19th RSS | Index-only versus successful initial baseline |
| `stress-kr-sisain-baselines-versus-hankyung-discoveries-20261014` | 시사IN and 한국경제 real-estate | Two excluded endpoint baselines versus positive candidate discoveries |
| `stress-ar-chequeado-date-concern-versus-mdz-recovery-20261014` | Chequeado and MDZ Tecnología | Saved content-date concern versus later successful collection recovery |

First binding baselines and later successful measured-zero checks are separate cases. A baseline excludes its initial inventory from NEW; it does not prove there were zero feed entries or publications. Where the compact archive lacks a gross initial inventory count, none is supplied. Sitemap-index children are not article discoveries. Null tracking/selected-period absence is separate from measured zero.

The October 13 failure and October 14 recovery pairs intentionally share sources and endpoints. The 19th also appears once before its first available check and once at its first baseline. Repeated episodes are correlated, so 20 groups must not be reported as 20 independent publishers or external incidents.

Chequeado's retained readable RSS has an August 25 item date and an explicit saved stale-content label. This supports a bounded content-date confirmation request, not proof that the publisher stopped producing news. Its comparable advance cadence is unavailable. The fixed historical Rádio Campanário sitemap can legitimately retain old lastmod values; ordered saved collection recovery takes priority over those dates. Neither case claims a present outage or a newly established long-term cadence baseline.

`insufficient_evidence` is not forced into the local complete-history classifier, which does not emit that branch for these dated records. Real insufficient tracking and absent selected-day attempts supply the negative controls instead. No history was artificially removed to obtain a desired label.

## Replay schema and isolation

The dataset is explicitly `real_world_cases: true`, `fixture_set: false`, and `evidence_kind: saved_real_incident_replay`. Use each `group.date` as the selected date and `group.now` as the fixed clock; the top-level `selected_date` is the marker `per_group_date`.

Each group has `registry`, `activity_snapshot`, `health_snapshot`, and `now`, which hydrate the existing `normalizeRegistry`, `ActivityStore`, and `HealthStore`. Run the actual `InvestigationStore` with `remote=false` so real MCP SDK client/server calls read only this frozen evidence. All engines and repetitions must receive the exact same group evidence and clock. They must not fetch publishers or live production MCP, mutate the registry, or restart collectors. Budget accounting and result persistence belong to the evaluation runner, not these evidence stores.

`replay` holds saved tool/result pairs generated through the actual in-memory MCP client and server: country quality, country inventory, source search, source detail, source quality, endpoint health, country activity, and source activity. There are eight reads for each diagnostic group and eleven for each two-source stress group, totaling 204 saved reads. These pairs can check exact-argument result invariants. Adaptive queries/pagination should use the same frozen stores rather than fabricate a response. Each replay neighborhood contains one or two selected sources: country inventory and activity refer to that cohort, not the full production country. It does not measure whole-country discovery planning, common-collector diagnosis, or broad source prioritization.

Merged activity records are unioned by exact endpoint ID and check timestamp, with overlapping records checked for conflicts. Original `country_new` counters retain the already deduplicated national-ledger increments attributed to those checks. They are never recomputed by summing `source_new` counters. This is not an independently deduplicated union of every URL in the selected replay cohort: the compact archive has no URL ledger, so that separate quantity is explicitly null in `country_count_semantics`. No full national population totals are fabricated.

`gold` contains endpoint classifications and confirmation requirements. `source_gold` contains source-level acceptable actions. This distinction matters for Linkiesta: investigating its failing sitemap is a valid source action and must not be counted as an invented failure of its successful RSS. Grade raw Jev endpoint decisions against `gold`; grade original OpenAI source proposals against `source_gold`. Acceptable actions are bounded recommendations, not permission to apply changes. No current-live-state claim is accepted.

Never send `gold`, `source_gold`, descriptions, label reasons, uncertainty notes, adjudication, provenance, or case IDs that describe outcomes to a model. Evidence input consists only of the frozen registry/activity/health stores and their normal tool results. Preserve unknowns and saved dates. The October 13 cases retain later October 14 records/health deliberately: later evidence must not establish a selected-period attempt, outage, normal baseline, or recovery.

The production OpenAI investigator sees code-derived classifications in source-quality tool output. Its final findings are therefore not independent model endpoint classifications. Report its original action proposals, inspected evidence, coverage, validation rejections, safety and cost separately from the existing code labels. Jev's raw classification/confirmation decisions can be measured before its code-agreement and confidence gates; guarded final actions are a separate metric. Rules have no model cost, but total serving cost is not measured here.

There are no article bodies in the replay. Publisher names and registry language metadata are retained, and language may be null. Results cannot demonstrate general multilingual semantic news understanding. Three repeated provider runs, if performed, measure stability on this frozen small case set, not three independent real-world datasets.

## Verification performed during curation

The original archive integrity, all referenced file hashes, 24 group scopes, stable source/endpoint IDs, preserved sibling endpoints, actual history provenance, saved check timestamps, and confirmation/action separation were checked. All 204 real MCP reads completed against frozen in-memory stores. The 22 manually specified diagnostic endpoint classifications and confirmation labels matched the existing code's consistency check; the nine reused endpoint labels also remained unchanged after their coherent multi-source merges. No paid model evaluation or publisher validation was run by the curator.
