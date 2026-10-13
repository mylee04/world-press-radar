import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openAIPolicy } from './openai-runtime.js';
import { jevPolicy } from './jev-runtime.js';
import { PersistentModelBudget, QualityRunStore, QualityRuntimeLease } from './quality-runtime-storage.js';
import { QualityHistoryStore } from './quality-history.js';
import { RepairWorkflowStore, type CollectorRecoveryEvidence } from './repair-workflow.js';
import type { QualityRuntimeOptions } from './quality-http.js';
import { readRemoteNewsTool } from './quality-remote.js';
import { CloudQualityAccess } from './quality-cloud-auth.js';

/** Owner-only Node runtime. Hosted public functions never enable this configuration. */
export function createLocalQualityRuntime(env: NodeJS.ProcessEnv = process.env) {
  return createQualityRuntime(env);
}

/** One durable process behind the public gateway, with paid execution disabled unless explicitly configured. */
export function createCloudQualityRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (!env.WNS_QUALITY_STATE_DIR || !isAbsolute(env.WNS_QUALITY_STATE_DIR)) throw Error('QUALITY_CLOUD_STATE_DIRECTORY_REQUIRED');
  return createQualityRuntime(env, new CloudQualityAccess(env));
}

function createQualityRuntime(env: NodeJS.ProcessEnv, cloudAccess?: CloudQualityAccess) {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const repositoryRoot = resolve(packageRoot, '../..');
  const directory = resolve(env.WNS_QUALITY_STATE_DIR ?? join(packageRoot, 'output/news-quality'));
  let registryPath = resolve(env.WNS_REGISTRY_PATH ?? join(repositoryRoot, 'data/rss-atlas.json'));
  let allowedRegistryRoot = cloudAccess && env.WNS_QUALITY_REGISTRY_ROOT ? resolve(env.WNS_QUALITY_REGISTRY_ROOT) : repositoryRoot;
  if (cloudAccess && env.WNS_QUALITY_REGISTRY_ROOT && !isAbsolute(env.WNS_QUALITY_REGISTRY_ROOT)) throw Error('QUALITY_REGISTRY_ROOT_INVALID');
  const rel = relative(allowedRegistryRoot, registryPath);
  // Foreign registries stay read-only unless the cloud operator explicitly approves their exact root.
  const editable = !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
  if (cloudAccess && env.WNS_QUALITY_REPAIR_ENABLED === '1' && (!env.WNS_QUALITY_REGISTRY_ROOT || !env.WNS_REGISTRY_PATH || !editable))
    throw Error('QUALITY_CLOUD_REPAIR_ROOT_REQUIRED');
  let repairDirectory = cloudAccess ? resolve(env.WNS_QUALITY_REPAIR_STATE_DIR ?? join(allowedRegistryRoot, 'output/news-quality/repairs')) : join(directory, 'repairs');
  if (cloudAccess && env.WNS_QUALITY_REPAIR_ENABLED === '1') {
    const repairRel = relative(allowedRegistryRoot, repairDirectory);
    if (isAbsolute(repairRel) || repairRel === '..' || repairRel.startsWith('../')) throw Error('WORKFLOW_PATH_OUTSIDE_APPROVED_ROOT');
    // A configured current-release alias is the sole allowed symlink. Resolve that root once;
    // the workflow still rejects every symlink in paths below the physical approved directory.
    allowedRegistryRoot = realpathSync(allowedRegistryRoot);
    registryPath = resolve(allowedRegistryRoot, rel);
    repairDirectory = resolve(allowedRegistryRoot, repairRel);
  }
  const lease = new QualityRuntimeLease(join(directory, 'runtime.sqlite'));
  const history = new QualityHistoryStore(env.WNS_QUALITY_HISTORY_PATH ?? join(directory, 'history.sqlite'));
  const store = new QualityRunStore(join(directory, 'runtime.sqlite'));
  store.reconcileInterrupted();
  const policy = openAIPolicy(env), jev = jevPolicy(env);
  const commonLimit = Number(env.WNS_QUALITY_TOTAL_BUDGET_USD ?? 0);
  if (!Number.isFinite(commonLimit) || commonLimit < 0) throw Error('QUALITY_SHARED_BUDGET_INVALID');
  if ((policy.authorized || jev.authorized) && !(commonLimit > 0)) throw Error('QUALITY_SHARED_BUDGET_REQUIRED');
  const budget = commonLimit > 0 ? new PersistentModelBudget(env.WNS_QUALITY_BUDGET_PATH ?? join(directory, 'runtime.sqlite'),
    commonLimit, env.WNS_QUALITY_BUDGET_ID ?? 'news-quality-pilot-20261013') : undefined;
  if (budget) {
    policy.totalBudgetUsd = Math.min(policy.totalBudgetUsd, commonLimit);
    jev.totalBudgetUsd = Math.min(jev.totalBudgetUsd, commonLimit);
  }
  const collectorPath = resolve(env.WNS_ACTIVITY_DB ?? join(packageRoot, 'activity/production.sqlite'));
  async function readCollectorEvidence(endpointId: string, sourceId: string, after: string): Promise<CollectorRecoveryEvidence | null> {
    if (!existsSync(collectorPath) || !lstatSync(collectorPath).isFile() || lstatSync(collectorPath).isSymbolicLink()) return null;
    const db = new DatabaseSync(collectorPath, { readOnly: true });
    try {
      if (db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value !== 'production') return null;
      const row = db.prepare(`SELECT c.id,c.checked_at,c.status,c.format,c.details FROM collections c
        WHERE c.endpoint_id=? AND c.checked_at>? AND EXISTS(SELECT 1 FROM json_each(c.details,'$.source_ids') WHERE value=?)
        ORDER BY c.checked_at DESC LIMIT 1`).get(endpointId, after, sourceId);
      if (!row) return null;
      const details = JSON.parse(String(row.details));
      return { run_id: String(details.cycle_id ?? row.id), completed_at: String(row.checked_at),
        successful: ['working_nonempty', 'valid_empty'].includes(String(row.status)) && row.format !== 'sitemapindex',
        baseline: !Array.isArray(details.baseline_sources) || details.baseline_sources.includes(sourceId),
        first_discovered_urls: typeof details.source_new?.[sourceId] === 'number' ? details.source_new[sourceId] : null,
        newest_content_at: details.newest_content_at ?? null };
    } catch { return null; } finally { db.close(); }
  }
  let repair: RepairWorkflowStore | undefined;
  try {
    repair = editable && (!cloudAccess || env.WNS_QUALITY_REPAIR_ENABLED === '1') ? new RepairWorkflowStore({ directory: repairDirectory, registryPath,
      allowedRegistryRoot, authorizeMutation: principal => principal.actor_id === (cloudAccess ? 'cloud_admin' : 'local_owner')
        && /^[A-Za-z0-9_-]{43}$/.test(principal.session_id), readCollectorEvidence }) : undefined;
  } catch (error) {
    // A rejected repair path must not leave a live process holding the state-directory lease.
    history.close(); store.close(); budget?.close(); lease.close(); throw error;
  }
  function savedRemoteOverview(date?: string) {
    const selected = date ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selected)) return undefined;
    const reports = join(directory, 'daily'), receiptPath = join(reports, `${selected}-remote.receipt.json`);
    if (!existsSync(receiptPath)) return undefined;
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const path = realpathSync(receipt.report_path), rel = relative(realpathSync(reports), path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || lstatSync(path).size > 10 * 1024 * 1024) return undefined;
      const report = JSON.parse(readFileSync(path, 'utf8'));
      if (report.data_source !== 'remote' || report.date !== selected || report.overview?.date !== selected || !Array.isArray(report.overview?.items)) return undefined;
      return { ...report.overview, source: 'daily_saved_remote_mcp', evaluated_at: report.observed_at,
        runtime: { ...report.overview.runtime, data_source: 'daily_saved_remote_mcp',
          report_observed_at: report.observed_at, report_status: report.status } };
    } catch { return undefined; }
  }
  const options: QualityRuntimeOptions = { localOwner: !cloudAccess, cloudAccess, history, repair,
    savedRemoteOverview, investigations: { policy, jevPolicy: jev, budget, store } };
  return { options, store, history, budget, async close() {
    // An accepted paid request is allowed to settle before the budget database closes.
    const deadline = Date.now() + 130000;
    while (store.list(100).some(run => run.status === 'running') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 250));
    await readRemoteNewsTool.close();
    history.close(); store.close(); budget?.close(); lease.close();
  } };
}
