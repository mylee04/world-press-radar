# Clinic and FBM artifact retention

The owner authorized removal of unnecessary Clinic Signals and FBM backups, inactive deployment artifacts and stale temporary exports on October 19, 2026. Running services, original application data and news collection history remain outside the deletion scope. Nothing in this policy starts collection, restores data or restarts a service.

## Kept artifacts

| Family | Retention |
| --- | --- |
| Clinic releases | Current release and two newest alternatives; any release referenced by a live process and any artifact younger than two hours is also protected |
| Clinic completed daily online snapshots | Latest three |
| Clinic `backups/contact-goal7000` manual DB snapshots | Latest complete snapshot; small manifests and audit proofs remain in expired folders |
| Clinic `data/.contact-backups` public-DB snapshots | Latest matching phase snapshot |
| FBM completed standalone daily PostgreSQL dumps | Latest seven |
| FBM original change archives, one-off dumps, migrations, assets and active build | Preserved |

Only exact approved names beneath the known artifact directories are eligible. Unknown files, incomplete snapshots, symlinked roots and process-referenced paths are excluded. Backup manifests and declared file sizes must match. Empty SQLite WAL and small coordination sidecars are recognized, along with small JSON audit records. This is artifact validation, not a new database integrity or restore test. The latest FBM custom-format dump's existing list check passed; no restore was performed.

The known FBM old build subdirectories under `deploy-backup-15f2f25c`, `deploy-backup-6d7d3133` and `deploy-backup-security-20260926` are eligible. Their parent folders and original patches, hashes, local source archives and configuration files are preserved. Current deployment does not create those old build directories. Live web and operator services continue from `/srv/fbm-ai/app`.

## Continuous cleanup

Oracle installs `shared-project-retention.py` as `/usr/local/sbin/shared-project-retention`. Without `--apply` it only previews. Apply uses a global maintenance lock, checks each candidate's inode/device/mtime again, rechecks the current release and excludes process paths. Descriptor-based `shutil.rmtree` unlinks release-local data symlinks without following them into original shared data. A fixture verifies this boundary. Removal receipts replace small per-scope files in `/var/lib/shared-project-retention`; the initial cleanup receipt is retained separately. Physical space recovery is measured by filesystem free space, because release hardlinks make summed folder sizes an unreliable estimate.

`shared-project-retention.timer` runs hourly with low CPU/I/O priority. The existing FBM backup script invokes its `fbm-backups` scope only after a successful standalone dump; its prior 30-day removal is replaced by the seven-copy rule. Clinic's existing backup function now defaults to three completed snapshots in both canonical local source and current server source. Existing backup schedules remain unchanged.

Clinic temp removal only targets exact old `tmp????????` names and the new `.city-inventory-*`, `.catalog-*`, `.residential-*` export prefixes in the shared data directory. Files must be at least one hour old, unopened and unchanged since planning. Cleanup must acquire the existing `.collection-worker.lock` inode; it never removes or replaces that lock and skips while the collector owns it. A `clinic-signals-ru-monitor.service` drop-in runs only the `clinic-temps` scope after the existing collector finishes or times out. This scope has a separate maintenance lock so a long release cleanup cannot make it miss the idle window. Both scopes still share the original collection lock for temp removal. The after-collector command ignores maintenance errors so cleanup cannot change the collector's existing result. It adds no collection run and requires no service restart.

Canonical and deployed Clinic `city_inventory.py`, `store.py` and `residential_leads.py` now assign the temporary name before serialization and unlink it in `finally`. Failed writes or replaces preserve the prior completed output. Nine focused cases cover success, JSON failure and replace failure across the three actual writer functions. Forced termination can bypass Python cleanup, so the stale-file sweep remains necessary. Clinic's preexisting 20-minute collection timeouts are a separate reliability issue; this work does not change that timeout or source-collection behavior.

Seven retention fixtures cover the kept sets, original/unknown preservation, process references, symlink safety, changed candidate refusal, the busy collection lock and preservation of manual audit metadata. A separate tiny fixture ran the actual Clinic backup function five times and confirmed its default retains three while leaving the original fixture database unchanged. No full application test suite, real collection, full production database scan or restore was performed. Private source diffs, previews and before/after receipts are under `output/news-quality/shared-storage-cleanup-20261019` and `output/news-quality/shared-disk-retention-20261019`.

## Applied result

Initial maintenance on October 19 at 13:34 UTC removed 61 inactive Clinic releases, four expired daily snapshots, 25 expired manual database copies and five earlier contact snapshots, plus 25 expired FBM daily dumps and three unused historical build subdirectories. Small Clinic manual audit records and the FBM original change archives remain. The filesystem gained 43,037,560,832 bytes, a measured 40.08 GiB, during this first pass. Six stale temporary files were correctly deferred while the original collector held its lock.

At 13:38:28 UTC, the collector reached its preexisting timeout naturally. Its new after-completion hook acquired the released worker lock and removed those six stale files, recovering another 1,201,446,912 bytes (1.12 GiB). The hook's receipt showed no skipped candidates. Combined measured recovery was about 41.20 GiB; observed shared free space reached approximately 130.22 GiB. Concurrent workloads can change net free space. Fresh or open temporary files remain protected and become eligible only when stale and the collection lock is free.

The Clinic web app, FBM web app and FBM operator service retained identical active PIDs and start times across cleanup. Clinic's four live SQLite files retained their original inodes, and the current release stayed unchanged. The news ledger retained identical size and modification time, its wrapper hash matched, and its regular timer was unchanged. No application service was manually restarted and no additional collection was launched. Hourly artifact retention and the existing private capacity warning timer remain enabled.
