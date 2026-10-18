#!/usr/bin/env node
// Offline maintenance only. Hold the existing runner flock and require idle
// collection services before invoking this command. It never fetches publishers.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateActivityUrlStorage, urlStorageVersion } from '../dist/activity-url-storage.js';

const args = process.argv.slice(2);
const allowed = new Set(['--db', '--apply', '--vacuum']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i]) || args.indexOf(args[i]) !== i) throw Error('Invalid migration option');
  if (args[i] === '--db') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Existing --db path required');
    i++;
  }
}
if (!args.includes('--db')) throw Error('Existing --db path required');
if (args.includes('--vacuum') && !args.includes('--apply')) throw Error('--vacuum requires --apply');
const path = resolve(args[args.indexOf('--db') + 1]);
const input = lstatSync(path);
if (!input.isFile() || input.isSymbolicLink() || input.nlink !== 1 || input.size === 0) throw Error('Existing regular nonempty ledger required');
const apply = args.includes('--apply');
const spool = `${path}.spool`;
if (apply && existsSync(spool) && readdirSync(spool).some(name => name.endsWith('.json'))) throw Error('URL_MIGRATION_PENDING_SPOOL');
const gib = 1024 ** 3;
const freeBytes = () => { const fs = statfsSync(dirname(path)); return fs.bavail * fs.bsize; };
const size = () => [path, `${path}-wal`].reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
const requireSpace = reserve => {
  const free = freeBytes(), required = 50 * gib + reserve;
  if (free < required) throw Error(`URL_MIGRATION_SPACE_REQUIRED:${required}:${free}`);
};
const db = new DatabaseSync(path, { readOnly: !apply });
let stage = 'inspection', migrated = false, storageVersion = null;
try {
  db.exec('PRAGMA busy_timeout=5000');
  const version = urlStorageVersion(db);
  if (!version) throw Error('EXISTING_URL_STORAGE_REQUIRED');
  storageVersion = version;
  if (!apply) {
    console.log(JSON.stringify({ action: 'preview', storage_version: version, db_plus_wal_bytes: size(), filesystem_free_bytes: freeBytes(), automatic_migration: false }));
  } else {
    db.exec('PRAGMA cache_size=-131072');
    requireSpace(3 * size() + gib);
    const checkpoint = () => {
      const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(row.busy) !== 0) throw Error('URL_MIGRATION_CHECKPOINT_BUSY');
    };
    checkpoint();
    const beforeBytes = statSync(path).size;
    stage = 'atomic-conversion';
    console.error(JSON.stringify({ url_storage_phase: stage, started_at: new Date().toISOString() }));
    const migration = migrateActivityUrlStorage(db);
    migrated = migration.migrated;
    storageVersion = 2;
    stage = 'checkpoint'; checkpoint();
    if (args.includes('--vacuum')) {
      stage = 'compaction'; requireSpace(2 * size() + gib);
      console.error(JSON.stringify({ url_storage_phase: stage, started_at: new Date().toISOString() }));
      db.exec('VACUUM'); checkpoint();
    }
    console.log(JSON.stringify({ action: 'applied', ...migration, compacted: args.includes('--vacuum'), before_bytes: beforeBytes,
      after_bytes: statSync(path).size, filesystem_free_bytes: freeBytes(), data_backups_created: 0,
      history_or_baselines_expired: false, publisher_requests: 0 }));
  }
} catch (error) {
  console.error(JSON.stringify({ migration_failed_at: stage, conversion_committed: migrated, storage_version: storageVersion, error: error.message }));
  process.exitCode = 1;
} finally { db.close(); }
