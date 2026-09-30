# Source activation history

Source search/details expose `enabled_changed_at` and `status_reason`, plus `status_history` entries (`old_enabled`, `new_enabled`, `changed_at`, `reason`). Times are UTC ISO 8601. `status_transition_count` counts recorded transitions; at most the latest 20 entries are returned. Git history preserves older operator changes when committed.

Existing registrations have no reliable historical activation dates: their timestamp/reason/count are **null** and history is empty. `status_history_consistent: true` means duplicate registrations agree; it does not imply historical evidence exists. Conflicting duplicates yield unknown metadata and `false`, rather than an invented date. Endpoint `checked_at` and publication freshness remain independent.

## Operator workflow

From this package directory, build and obtain the stable source ID through the read-only MCP:

```sh
npm run build
npm run source:status -- src_EXACT_ID disabled "Publisher officially discontinued this endpoint"
```

Replace the example ID with a real `src_` ID. Use `enabled` to reactivate, with an evidence-based reason. The operator command records its actual current clock time, requires a real state change, and updates all identical registrations together. It validates metadata, uses an exclusive edit lock and atomic file replacement, and preserves unrelated row fields. `WNS_REGISTRY_PATH` can point to a review/test registry; otherwise the existing `data/rss-atlas.json` is edited. Review the Git diff, run tests/typecheck, commit locally, and deploy the updated metadata when authorized. A filesystem edit outside this command should supply genuine transition evidence; do not invent older times. Reconcile conflicting duplicate states/history before using the command.

MCP tools remain read-only. Audits never activate/deactivate sources automatically, including after timeouts, blocks or HTTP errors. No production source states were changed when introducing this feature.
