# October 4 deployment size repair

The preserved weekly audit finished at 2026-10-03T23:15:11.879Z. Its deployment request was rejected with HTTP 400: `Request body too large. Limit: 10mb`. The body measured 11,016,229 bytes.

The deployment adapter now uploads files larger than 256 KiB through its existing content-addressed file endpoint and uses SHA references in the deployment request. Archive and approved demo files retain their existing upload behavior. The local JSON request guard is 9 MiB, below the API's observed limit. File whitelisting, shard integrity checks, project identity, environment checks and single-submission state guards remain in force.

The operational repair published the same preserved results once as `dpl_7cyct15nkUMsGZSWJgdWSTyv2hUd`, verified READY at 2026-10-04T02:34:53.726Z on https://news.bymyleslee.com. The repaired request measured 96,931 bytes. No collection, credentials, schedules or services were changed.

Live HTTPS MCP smoke passed. The published audit contains 5,788 endpoints: 4,705 checked, 4,414 successful, 291 failed and 1,083 policy-deferred. It is partial; the last completed full audit remains 2026-09-30T20:05:37.106Z. The activity export is dated 2026-10-03T23:15:13.638Z; that timestamp is an export time, not a new collection.

The October 4 source reconciliation imports the already approved operational recovery policy, additive source registrations, demo asset, bundle preparation and operator verification helpers. A 127-file SHA-256 manifest covers all exported operational source, scripts, tests, public assets, package configuration, registry and compiled code; the locally built release matches every entry. The two new size regression tests and release documentation/CI are additional verification files. See [OPERATIONAL-SOURCE-MANIFEST.json](OPERATIONAL-SOURCE-MANIFEST.json).

The current Oracle release stays in place because its operational code already matches this source. Live SQLite/WAL/spool, current activity exports/history and audit reports are not transferred back or overwritten. Checked-in historical snapshots remain historical and must not be used to replace the live ledger. Production health and source/country activity are verified through cached HTTP MCP reads; no new collection or deployment is needed for this code release.

Validation: repository `bun run typecheck`, package typecheck and 97 package tests passed locally, including recovery, quota, retained history, transport and size regression tests. The existing preflight workflow now also runs package typecheck/tests under Node 22. The operational deployment tests passed 12/12 before the preserved-results publication.
