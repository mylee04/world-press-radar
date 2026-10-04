# October 4 deployment size repair

The preserved weekly audit finished at 2026-10-03T23:15:11.879Z. Its deployment request was rejected with HTTP 400: `Request body too large. Limit: 10mb`. The body measured 11,016,229 bytes.

The deployment adapter now uploads files larger than 256 KiB through its existing content-addressed file endpoint and uses SHA references in the deployment request. Archive and approved demo files retain their existing upload behavior. The local JSON request guard is 9 MiB, below the API's observed limit. File whitelisting, shard integrity checks, project identity, environment checks and single-submission state guards remain in force.

The operational repair published the same preserved results once as `dpl_7cyct15nkUMsGZSWJgdWSTyv2hUd`, verified READY at 2026-10-04T02:34:53.726Z on https://news.bymyleslee.com. The repaired request measured 96,931 bytes. No collection, credentials, schedules or services were changed.

Live HTTPS MCP smoke passed. The published audit contains 5,788 endpoints: 4,705 checked, 4,414 successful, 291 failed and 1,083 policy-deferred. It is partial; the last completed full audit remains 2026-09-30T20:05:37.106Z. The activity export is dated 2026-10-03T23:15:13.638Z; that timestamp is an export time, not a new collection.

This code change records the adapter already installed on the Oracle runner. It does not replace the current runner release or deploy historical checked-in snapshots. Earlier operational recovery-policy changes and approved live registry/demo state have not all been reconciled into this source branch; therefore this revision is not a byte-for-byte release of the complete current application. The deployment adapter itself matches the runner exactly. Do not use this source branch to overwrite the current operational release until those differences are reconciled.

Validation: repository `bun run typecheck`, package typecheck and 80 package tests passed, including size regression tests. The existing operational deployment tests passed 12/12 before the preserved-results publication.
