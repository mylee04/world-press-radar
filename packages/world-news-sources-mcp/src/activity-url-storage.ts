import type { DatabaseSync } from 'node:sqlite';

// URL equality, normalization and discovery rules are unchanged by this format.
export const LEGACY_URL_SCHEMA = `
CREATE TABLE IF NOT EXISTS urls(url TEXT PRIMARY KEY,normalization_version TEXT NOT NULL,kind TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scope_urls(scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,baseline INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope_kind,scope_id,url));
CREATE INDEX IF NOT EXISTS scope_discovery ON scope_urls(scope_kind,scope_id,baseline,kind,first_seen);
CREATE TABLE IF NOT EXISTS endpoint_urls(endpoint_id TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(endpoint_id,url));
CREATE TABLE IF NOT EXISTS binding_urls(source_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,country TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(source_id,endpoint_id,url));
`;

export const COMPACT_URL_SCHEMA = `
CREATE TABLE IF NOT EXISTS urls(id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,normalization_version TEXT NOT NULL,kind TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scope_urls(scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,url_id INTEGER NOT NULL REFERENCES urls(id),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,baseline INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope_kind,scope_id,url_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS scope_discovery ON scope_urls(scope_kind,scope_id,baseline,kind,first_seen);
CREATE TABLE IF NOT EXISTS endpoint_urls(endpoint_id TEXT NOT NULL,url_id INTEGER NOT NULL REFERENCES urls(id),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(endpoint_id,url_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS binding_urls(source_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,country TEXT NOT NULL,url_id INTEGER NOT NULL REFERENCES urls(id),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(source_id,endpoint_id,url_id)) WITHOUT ROWID;
`;

const TABLES = ['urls', 'scope_urls', 'endpoint_urls', 'binding_urls'] as const;
type UrlTable = typeof TABLES[number];
type RowCounts = Record<UrlTable, number>;
const columns: Record<UrlTable, string[]> = {
  urls: ['url', 'normalization_version', 'kind', 'first_seen', 'last_seen'],
  scope_urls: ['scope_kind', 'scope_id', 'url', 'first_seen', 'last_seen', 'baseline', 'kind'],
  endpoint_urls: ['endpoint_id', 'url', 'first_seen', 'last_seen'],
  binding_urls: ['source_id', 'endpoint_id', 'country', 'url', 'first_seen', 'last_seen'],
};

export function urlStorageVersion(db: DatabaseSync): 1 | 2 | null {
  const definitions = TABLES.map(table => db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table));
  if (definitions.every(value => !value)) return null;
  if (definitions.some(value => value?.type !== 'table')) throw Error('UNKNOWN_URL_STORAGE_SCHEMA');
  const actual = TABLES.map(table => db.prepare(`PRAGMA table_info(${table})`).all());
  const version = actual[0][0]?.name === 'id' ? 2 : 1;
  for (let i = 0; i < TABLES.length; i++) {
    const table = TABLES[i];
    const expected = version === 1 ? columns[table] : table === 'urls' ? ['id', ...columns.urls] : columns[table].map(name => name === 'url' ? 'url_id' : name);
    if (JSON.stringify(actual[i].map(row => row.name)) !== JSON.stringify(expected)) throw Error('UNKNOWN_URL_STORAGE_SCHEMA');
    const keys = table === 'urls' ? [version === 2 ? 'id' : 'url'] : table === 'scope_urls' ? ['scope_kind', 'scope_id', version === 2 ? 'url_id' : 'url'] : table === 'endpoint_urls' ? ['endpoint_id', version === 2 ? 'url_id' : 'url'] : ['source_id', 'endpoint_id', version === 2 ? 'url_id' : 'url'];
    if (actual[i].some(row => String(row.type).toUpperCase() !== (row.name === 'id' || row.name === 'url_id' || row.name === 'baseline' ? 'INTEGER' : 'TEXT') || Number(row.pk) !== keys.indexOf(String(row.name)) + 1)) throw Error('UNKNOWN_URL_STORAGE_SCHEMA');
    if (table !== 'urls') {
      const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
      if (references.length !== 1 || references[0].table !== 'urls' || references[0].from !== (version === 2 ? 'url_id' : 'url') || references[0].to !== (version === 2 ? 'id' : 'url')) throw Error('UNKNOWN_URL_STORAGE_SCHEMA');
    }
    if (version === 2 && table !== 'urls' && !/\bWITHOUT\s+ROWID\b/i.test(String(definitions[i]!.sql))) throw Error('UNKNOWN_URL_STORAGE_SCHEMA');
  }
  return version;
}

function counts(db: DatabaseSync, prefix = ''): RowCounts {
  return Object.fromEntries(TABLES.map(table => [table, Number(db.prepare(`SELECT COUNT(*) n FROM ${prefix}${table}`).get()!.n)])) as RowCounts;
}

export type UrlStorageMigration = { from: 1 | 2; to: 2; migrated: boolean; rows: RowCounts };

// Maintenance only: the operator must also hold the runner lock with collectors
// idle and no pending spool. Ordinary ActivityLedger opens never convert v1.
export function migrateActivityUrlStorage(db: DatabaseSync): UrlStorageMigration {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    const version = urlStorageVersion(db);
    if (version === null) throw Error('EXISTING_URL_STORAGE_REQUIRED');
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='writer_lock'").get() && db.prepare('SELECT 1 FROM writer_lock LIMIT 1').get()) throw Error('URL_MIGRATION_WRITER_ACTIVE');
    if (version === 2) {
      const rows = counts(db); db.exec('COMMIT'); return { from: 2, to: 2, migrated: false, rows };
    }
    // A custom trigger/index must be migrated deliberately instead of dropped.
    for (const table of TABLES) {
      const extras = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE tbl_name=? AND (type='trigger' OR (type='index' AND sql IS NOT NULL))").all(table);
      if (extras.some(row => row.name !== 'scope_discovery' || row.type !== 'index')) throw Error('URL_MIGRATION_CUSTOM_SCHEMA');
      if (db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(`url_v2_${table}`)) throw Error('URL_MIGRATION_STAGING_EXISTS');
    }
    const rows = counts(db);
    const stagingSchema = COMPACT_URL_SCHEMA.replace(/\b(urls|scope_urls|endpoint_urls|binding_urls)\b/g, 'url_v2_$1').replace(/CREATE INDEX IF NOT EXISTS scope_discovery[^;]+;/, '');
    db.exec(stagingSchema);
    // Existing rowids provide bounded integer identities. Do not normalize old URLs.
    db.exec('INSERT INTO url_v2_urls SELECT rowid,url,normalization_version,kind,first_seen,last_seen FROM urls');
    for (const table of TABLES.slice(1)) {
      const sourceColumns = columns[table].map(name => name === 'url' ? 'u.id' : `old.${name}`).join(',');
      db.exec(`INSERT INTO url_v2_${table} SELECT ${sourceColumns} FROM ${table} old JOIN url_v2_urls u ON u.url=old.url`);
    }
    const copied = counts(db, 'url_v2_');
    for (const table of TABLES) {
      if (rows[table] !== copied[table]) throw Error(`URL_MIGRATION_ROW_MISMATCH:${table}`);
      const keys = table === 'scope_urls' ? ['scope_kind', 'scope_id'] : table === 'endpoint_urls' ? ['endpoint_id'] : ['source_id', 'endpoint_id'];
      const join = table === 'urls' ? 'LEFT JOIN url_v2_urls new ON new.url=old.url' : `LEFT JOIN url_v2_urls u ON u.url=old.url LEFT JOIN url_v2_${table} new ON new.url_id=u.id AND ${keys.map(name => `new.${name}=old.${name}`).join(' AND ')}`;
      const mismatch = columns[table].filter(name => name !== 'url').map(name => `old.${name} IS NOT new.${name}`).join(' OR ');
      const absent = table === 'urls' ? 'new.id IS NULL' : 'u.id IS NULL OR new.url_id IS NULL';
      // Direct indexed lookups avoid materializing every relationship with its
      // long URL again while checking a multi-gigabyte production ledger.
      const missing = db.prepare(`SELECT 1 FROM ${table} old ${join} WHERE ${absent} OR ${mismatch} LIMIT 1`).get();
      if (missing) throw Error(`URL_MIGRATION_VALUE_MISMATCH:${table}`);
    }
    // All old rows have exactly one identical mapped row before removal. Other
    // tables (including immutable collection details and baselines) are untouched.
    for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
    for (const table of TABLES) db.exec(`ALTER TABLE url_v2_${table} RENAME TO ${table}`);
    db.exec('CREATE INDEX scope_discovery ON scope_urls(scope_kind,scope_id,baseline,kind,first_seen)');
    if (urlStorageVersion(db) !== 2) throw Error('URL_MIGRATION_SCHEMA_MISMATCH');
    db.exec('COMMIT');
    return { from: 1, to: 2, migrated: true, rows };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
