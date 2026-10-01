import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRegistry } from './catalog.js';
import { HealthStore } from './health.js';
import { ActivityStore, type ActivitySnapshot } from './activity.js';

export function readJson(path: string): unknown {
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error('Metadata file exceeds 16 MiB limit');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadData() {
  const atlasPath = process.env.WNS_REGISTRY_PATH ?? fileURLToPath(new URL('../../../data/rss-atlas.json', import.meta.url));
  const legacyPath = process.env.WNS_LEGACY_HEALTH_PATH ?? fileURLToPath(new URL('../../../audits/readme_rss_health_latest.json', import.meta.url));
  const localPath = fileURLToPath(new URL('../health-snapshot.local.json', import.meta.url));
  const snapshotPath = process.env.WNS_HEALTH_PATH ?? (existsSync(localPath) ? localPath : fileURLToPath(new URL('../audits/health-latest.json', import.meta.url)));
  const activityPath = process.env.WNS_ACTIVITY_PATH ?? fileURLToPath(new URL('../activity/activity-snapshot.json', import.meta.url));
  if (process.env.WNS_HEALTH_PATH && !existsSync(snapshotPath)) throw new Error('WNS_HEALTH_PATH does not exist');
  return {
    catalog: normalizeRegistry(readJson(atlasPath)), snapshotPath,
    activity: new ActivityStore(existsSync(activityPath) ? readJson(activityPath) as ActivitySnapshot : undefined),
    health: new HealthStore(existsSync(snapshotPath) ? readJson(snapshotPath) : undefined,
      existsSync(legacyPath) ? readJson(legacyPath) : undefined),
  };
}
