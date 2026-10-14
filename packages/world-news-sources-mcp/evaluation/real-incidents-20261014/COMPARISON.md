# Saved production investigation comparison — October 14, 2026

The first complete investigation-loop comparison recorded all 216 intended executions: 24 saved-evidence groups × three repetitions × Rules, OpenAI and Jev. Rules and OpenAI completed 72/72 runs each; Jev completed 71/72 and failed one probability-contract validation. The original failed execution, cost and missing decisions remain in the results. Rules remain the operating default. Neither model result supports automatic source changes.

This is a bounded retrospective case study. The 20 diagnostic groups contain 22 real saved endpoint episodes; four stress groups reuse nine episodes in contrasting two-source cohorts. There are 16 distinct sources and 18 distinct typed endpoints, not 216 independent incidents. Assistant-adjudicated labels were checked against production rules afterward. There is no independent operator adjudication or external confirmation of current failures, root causes or long-term anomaly accuracy. See [dataset and provenance](README.md) and the machine-readable [aggregate results](results-summary.json).

## Method and isolation

The actual production `InvestigationStore`, MCP SDK in-memory transport, OpenAI Agents SDK loop and Jev decision stage ran against identical frozen registry, activity and health evidence. All 204 saved MCP manifest results matched before execution. Each group used its selected UTC date and a fixed analysis clock; provider requests, deadlines and elapsed time used real execution time. Provider order rotated across groups and repetitions. Gold labels, descriptive case IDs and adjudication prose never entered model inputs.

This compares the existing provider roles, not interchangeable classifiers. OpenAI adaptively chooses reads and proposes source actions; its source-quality tool exposes deterministic code classifications. Its score therefore measures assisted source-action agreement. Jev returns raw endpoint classification and confirmation choices before code/confidence gating. Final endpoint findings come from the same deterministic production code in every mode and cannot be credited as independent model accuracy. The small frozen country cohorts do not measure full-country search, shared collector diagnosis, article-language comprehension or repair recovery.

The isolated Oracle process used pinned code and dependencies, the existing approved protected key file, and the same fixed combined $5 budget authorization. No publisher request, production MCP request, registry change, collector start or deployment occurred. No paid retry, failed-run replacement or budget reset was performed. Full model/tool traces remain in private operator evidence; this report publishes aggregates only. The experiment follows the trace-plus-repeatable-dataset approach described by the [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) and [agent evaluation guidance](https://developers.openai.com/api/docs/guides/agent-evals).

## Baseline results

| Measure | Rules | OpenAI `gpt-6-luna` | Jev `jev-1.13.0` |
| --- | ---: | ---: | ---: |
| Completed / intended investigations | 72 / 72 | 72 / 72 | 71 / 72 |
| Actual MCP reads / errors | 384 / 0 | 300 / 0 | 384 / 0 |
| Actual paid API requests | 0 | 216 | 92 |
| Deterministic endpoint labels and confirmation flags | 93 / 93 each | 93 / 93 each | 93 / 93 each |
| Original model outcome | — | 77 / 101 supported source steps (76.24%) | 82 / 90 exact endpoint labels (91.11%) |
| Original model missing outcome | — | 0 omitted source proposals | 3 / 93 intended endpoint decisions absent |
| Median elapsed time per investigation | 0.153 s | 6.634 s | 0.393 s |
| 95th percentile elapsed time | 0.296 s | 8.994 s | 0.752 s |
| Summed investigation elapsed time | 12.836 s | 496.444 s | 32.243 s |
| Reported input / output tokens | 0 / 0 | 385,791 / 24,139 | 288,618 / 15,151 |
| Estimated API cost | $0 | $0.050648600 | $0.012121956 |

The differing outcome rows have different units and evidence exposure; they are not an accuracy ranking. All three modes inspected every intended endpoint. Jev's failed model stage occurred after the deterministic reads, so its 93 code findings do not fill its three missing raw decisions. Counting unavailable raw decisions as no credit gives Jev 82/93 intended classifications, rather than hiding the failed denominator.

On raw confirmation choices, Jev produced 27 true positives, 18 false positives, 45 true negatives and zero false negatives among the 90 retained decisions. OpenAI proposed a confirmation action for all 27 relevant source appearances, plus 21 negative-control source appearances, across 84 proposed source appearances. A source-level confirmation action is not an endpoint outage assertion. These are agreement counts against the predeclared saved-evidence triage policy, not externally verified incident false-positive rates.

| Cohort | Rules code labels | OpenAI supported original steps | Jev exact original labels | Jev completed investigations |
| --- | ---: | ---: | ---: | ---: |
| 20 diagnostic groups × 3 | 66 / 66 | 56 / 77 | 60 / 66 | 60 / 60 |
| 4 reused stress groups × 3 | 27 / 27 | 21 / 24 | 22 / 24 evaluated; 3 missing | 11 / 12 |

Decision-and-coverage signatures varied between repeats in 14/24 OpenAI groups. Jev had the same retained signature in 23 groups; the remaining stress group differed because one run failed. Rules were stable in all 24 groups. Three repeated runs of correlated saved episodes do not establish population reliability or stable provider behavior in new incidents.

## Findings and bounded fixes

OpenAI's original production guard rejected seven steps. Of its 94 retained steps, 22 were outside the frozen source-action gold: 20 additional freshness confirmations and two initialization-only proposals on recorded access/parsing failures. Inspection of the freshness proposals found broader advice about later observation, missing dates or open windows, rather than claims that successful zero discoveries prove an outage. The gold remains unchanged; broader review advice still counts as outside the declared triage policy.

The two initialization-only proposals missed the priority of bounded failure triage. The local guard now checks every inspected sibling endpoint, including details omitted from the model's bounded view. Saved failure or dated stale-content evidence takes priority over initialization. Genuine missing history, unattempted observations and index-only article-tracking gaps still permit initialization; successful article baselines alone do not. A separate deterministic replay of the captured proposals rejects exactly those two formerly retained failure initializations and rejects zero formerly retained gold-supported steps. It generates no replacement model responses and does not replace or improve the recorded baseline whole-loop score.

Jev's eight label mismatches comprise three saved recoveries called stale content and five successful baseline/zero episodes called insufficient evidence. Its downstream confidence/agreement gates yielded 37 additional freshness-review actions outside the source-action gold. They remained review recommendations. One Korean stress run failed with `JEV_PROBABILITY_CONTRACT_INVALID` after two paid requests costing an estimated $0.000133602. The invalid response body was not retained, so the exact invalid probability branch cannot be reconstructed. The strict probability contract was preserved.

The older Jev loop lost its first valid decision when a later request failed. The local implementation now durably saves validated partial decisions and scope while running, marks failed assessments incomplete, retains known usage/cost, and provides no final source actions on failure. Its regression exercises one valid response followed by an invalid probability response. Missing decisions from the original real experiment cannot be recovered or retrospectively invented.

Both fixes are local source changes with regression coverage. They have not been deployed or repeated through paid live APIs. There is no measured end-to-end provider improvement claim after these fixes.

Final local validation passed 353/353 package tests, TypeScript type checking, dashboard JavaScript syntax checking and whitespace checks. The final regressions include actual frozen MCP failure and Reuters index-only cases, omitted/mixed sibling evidence, and durable Jev failure after one validated decision. The isolated Oracle baseline also passed its ten evaluator regressions and all 24 unpaid real MCP replay groups before paid execution.

## Cost and reproducibility

New experiment usage estimates total **$0.062770556**. The existing combined authorization advanced from **$0.013497892** to **$0.076268448 of $5**, leaving **$4.923731552**. A read-only postflight reconciled the authoritative SQLite delta with the reported experiment costs: 323 cumulative reservations, all settled, including 15 earlier requests and 308 requests in this experiment. The unchanged collector/quality release pointers and all four existing web/daily/collection/health units were verified active.

Configured usage rates were OpenAI $0.10 per million input tokens and $0.50 per million output tokens, verified against the [model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), and Jev $0.042 per million input tokens with free output, verified against [TypeSafe](https://typesafe.ai/). These are reported-token estimates, not billing receipts. Server cost, total operating cost and general workload latency were not measured.

| Artifact | SHA-256 |
| --- | --- |
| Dataset file bytes | `dc86ba310307daaf55b6d3fe642de4f825a83b0696818739776c2aa2d1aa7c87` |
| Dataset canonical JSON used by runner | `6b2989ef56cf3df9fc36ce25c07bf30cb3d038476beb790c96f0da941c2fe4ba` |
| Pinned baseline evaluator script | `45db0f061b3729b64ca70f52540c9e0b31b6352cbc504744df7e2edbbec86ef3` |
| Private complete baseline result | `1c61d0a10dc6a34d073f52a688546f36fe5a863f87afbd000565aba0fa75f4e2` |

The dataset byte and canonical hashes differ because the latter sorts/normalizes JSON before hashing. The retained staged bundle manifest pins the baseline code; subsequent local fixes do not rewrite that bundle or result.

Reproduce the unpaid replay from the package directory:

```sh
npm run quality:evaluate:investigation -- --cases evaluation/real-incidents-20261014/cases.json --provider rules --output /absolute/path/new-private-result.json
```

Paid runs are explicit CLI actions on the already approved Oracle environment, with the existing protected key paths and authoritative fixed-budget SQLite row. `--provider all --repeats=3` makes actual API requests. The runner rejects fresh allowances, symlink budget files and existing result paths; failed results remain failed and are not retried automatically.

The next evidence to collect is independent operator adjudication, additional real completed comparable collection cohorts, and individually approved repair follow-through. Broadening memory, product multi-agent coordination or GPU serving should follow evidence that those changes address a measured bottleneck. The Harvard-inspired observation, loop and initial quality/cost evaluation now have concrete artifacts; this does not complete the full Lens → Loop → Opt → Serve → Stack scope described by [CS2680](https://cs2680.seas.harvard.edu/).
