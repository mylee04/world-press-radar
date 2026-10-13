import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86400000;
const allowedReadTools = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health',
  'get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory']);
const errorCode = error => /^[A-Z][A-Z0-9_]{3,100}$/.test(error?.message ?? '') ? error.message : 'QUALITY_DAILY_READ_FAILED';
const utcDate = at => new Date(at).toISOString().slice(0, 10);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function dailyOptions(args, now = Date.now(), env = process.env) {
  const flags = new Set(['--local', '--scheduled', '--rerun', '--no-registry', '--no-investigate']);
  const values = new Set(['--date', '--output', '--history', '--runtime', '--max-investigations', '--not-before-utc-hour', '--max-history-mib']);
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const [name, ...tail] = args[index].split('=');
    if (Object.hasOwn(parsed, name)) throw Error('QUALITY_DAILY_DUPLICATE_OPTION');
    if (flags.has(name)) { if (tail.length) throw Error('QUALITY_DAILY_INVALID_OPTION'); parsed[name] = true; }
    else if (values.has(name)) {
      const value = tail.length ? tail.join('=') : args[++index];
      if (value === undefined || value.startsWith('--')) throw Error('QUALITY_DAILY_MISSING_OPTION');
      parsed[name] = value;
    } else throw Error('QUALITY_DAILY_UNKNOWN_OPTION');
  }
  const date = parsed['--date'] ?? utcDate(now - DAY);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || utcDate(Date.parse(date)) !== date || date >= utcDate(now)) throw Error('QUALITY_DAILY_DATE_MUST_BE_CLOSED_UTC_DAY');
  const integer = (name, fallback, min, max) => {
    const value = Number(parsed[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw Error('QUALITY_DAILY_INVALID_LIMIT');
    return value;
  };
  const output = resolve(parsed['--output'] ?? join(packageRoot, 'output/news-quality/daily'));
  const history = resolve(parsed['--history'] ?? env.WNS_QUALITY_HISTORY_PATH ?? join(packageRoot, 'output/news-quality/history.sqlite'));
  const runtimeValue = parsed['--runtime'] ?? env.WNS_QUALITY_RUNTIME_PATH;
  if (runtimeValue !== undefined && (typeof runtimeValue !== 'string' || !runtimeValue.trim())) throw Error('QUALITY_DAILY_INVALID_PATH');
  const runtime = runtimeValue === undefined ? null : resolve(runtimeValue);
  if ([output, history, runtime].some(value => value && /[\u0000-\u001f]/.test(value))) throw Error('QUALITY_DAILY_INVALID_PATH');
  return { date, output, history, runtime, remote: !parsed['--local'], scheduled: !!parsed['--scheduled'], rerun: !!parsed['--rerun'],
    captureRegistry: !parsed['--no-registry'], investigate: !parsed['--no-investigate'],
    maxInvestigations: integer('--max-investigations', 5, 1, 5), notBeforeUtcHour: integer('--not-before-utc-hour', 9, 0, 23),
    maxHistoryBytes: integer('--max-history-mib', 512, 1, 16384) * 1024 * 1024 };
}

export async function safeDirectory(path) {
  // Reject symlink ancestors before writing operator records outside a public web directory.
  const absolute = resolve(path), ancestors = [];
  for (let current = absolute; dirname(current) !== current; current = dirname(current)) ancestors.push(current);
  for (const current of ancestors.reverse()) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('QUALITY_DAILY_UNSAFE_DIRECTORY'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); }
  }
}

async function atomicJson(path, value, replace = false) {
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > 10 * 1024 * 1024) throw Error('QUALITY_DAILY_REPORT_LIMIT');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    if (!replace) {
      // Exclusive destination prevents an accidental manual run from replacing a saved report.
      const destination = await open(path, 'wx', 0o600); await destination.close();
    } else {
      try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('QUALITY_DAILY_UNSAFE_RECORD'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function captureRemoteRegistry(call, observedAt) {
  const before = await call('get_country_source_inventory', { include_disabled: true, offset: 0, limit: 1 });
  const sources = [], seen = new Set(); let offset = 0, expected = null, pages = 0;
  while (offset !== null && pages++ < 300 && sources.length <= 10000) {
    // enabled is deliberately omitted: disabled registrations must not appear as deletions.
    const page = await call('search_sources', { offset, limit: 50 });
    if (!Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < 0 || page.total > 10000) throw Error('QUALITY_DAILY_INVALID_REGISTRY_PAGE');
    if (expected !== null && expected !== page.total) throw Error('QUALITY_DAILY_REGISTRY_CHANGED_DURING_READ');
    expected = page.total;
    for (const source of page.items) {
      if (typeof source.id !== 'string' || seen.has(source.id)) throw Error('QUALITY_DAILY_REGISTRY_DUPLICATE_SOURCE');
      seen.add(source.id);
      sources.push({ source_id: source.id, country: source.countryCode, name: source.name, enabled: source.enabled,
        registration_count: source.registrationCount, endpoints: (source.endpoints ?? []).map(endpoint => ({ endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url })) });
    }
    const next = page.next_offset;
    if (next !== null && (!Number.isInteger(next) || next <= offset || next > expected)) throw Error('QUALITY_DAILY_INVALID_REGISTRY_PAGINATION');
    offset = next;
  }
  if (offset !== null || expected === null || sources.length !== expected) throw Error('QUALITY_DAILY_REGISTRY_INCOMPLETE');
  const after = await call('get_country_source_inventory', { include_disabled: true, offset: 0, limit: 1 });
  const beforeAt = before.registry_snapshot_at ?? null, afterAt = after.registry_snapshot_at ?? null;
  if (beforeAt !== afterAt || digest(before.global_totals ?? null) !== digest(after.global_totals ?? null)) throw Error('QUALITY_DAILY_REGISTRY_CHANGED_DURING_READ');
  return { observed_at: observedAt ?? new Date().toISOString(), registry_snapshot_at: afterAt, complete: true, sources };
}

export function investigationCountries(overview, maximum) {
  const common = overview.completed_cycle_common_signal?.state === 'investigate_common_collector_first'
    || overview.common_collector_signal?.state === 'investigate_common_collector_first';
  const rows = (overview.items ?? []).filter(row => row.completed_cycle_baseline?.state === 'comparable_completed_cycles'
    && row.completed_cycle_baseline.reasons?.length || row.anomaly?.state === 'review_needed');
  const severity = row => Math.max(0, ...(row.completed_cycle_baseline?.reasons ?? row.anomaly?.reasons ?? []).map(reason => -(reason.delta_percentage_points ?? 0)));
  rows.sort((a, b) => severity(b) - severity(a) || a.country.localeCompare(b.country));
  return { countries: [...new Set(rows.map(row => row.country))].slice(0, maximum), total: rows.length, commonCollectorFirst: common };
}

async function defaultRuntime(options) {
  const [{ loadData }, { getCountryQualityOverview }, { RemoteQualityStore, REMOTE_NEWS_MCP_URL }, { InvestigationStore }, { QualityHistoryStore }, { QualityRunStore }] = await Promise.all([
    import('../dist/config.js'), import('../dist/quality.js'), import('../dist/quality-remote.js'), import('../dist/investigation.js'), import('../dist/quality-history.js'),
    import('../dist/quality-runtime-storage.js'),
  ]);
  const data = loadData(), history = new QualityHistoryStore(options.history);
  let client, runStore, investigations, connected = !options.remote; let calls = 0; const started = Date.now();
  const close = async () => {
    // A failed close must not prevent the other SQLite connection or MCP client from closing.
    await Promise.allSettled([history, runStore, client].filter(Boolean).map(resource => Promise.resolve().then(() => resource.close())));
  };
  const call = async (name, args) => {
    if (!allowedReadTools.has(name) || calls++ >= 400 || Date.now() - started > 240000) throw Error('QUALITY_DAILY_MCP_LIMIT');
    const response = await client.callTool({ name, arguments: args }, { timeout: 15000 });
    if (response.isError || !response.structuredContent || typeof response.structuredContent !== 'object' || Array.isArray(response.structuredContent)) throw Error('QUALITY_DAILY_MCP_READ_FAILED');
    return response.structuredContent;
  };
  try {
    if (options.remote) {
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      client = new Client({ name: 'news-quality-daily-read-only', version: '0.1.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE_NEWS_MCP_URL), { fetch: (input, init) => {
        const headers = new Headers(init?.headers); headers.set('x-world-news-traffic', 'inspection');
        return fetch(input, { ...init, headers, signal: AbortSignal.timeout(15000) });
      } }));
      connected = true;
    }
    // The daily dispatcher is a separate, concurrent writer of rules evidence.
    // It must never acquire the server's runtime owner lease or reconcile its active jobs.
    if (options.runtime) runStore = new QualityRunStore(options.runtime);
    investigations = new InvestigationStore(data.catalog, data.health, data.activity, options.remote, { store: runStore });
  } catch (error) {
    await close();
    if (!connected) throw Error('QUALITY_DAILY_MCP_CONNECTION_FAILED');
    throw error;
  }
  return {
    history,
    overview: async date => {
      if (options.remote) return new RemoteQualityStore(call).overview(date);
      // The overview contains only actual snapshot cycle evidence; observeOverview
      // persists terminal cycles and ignores running cycles without inventing earlier runs.
      const first = getCountryQualityOverview(data.catalog, data.activity, data.health, { date, limit: 50 }), items = [...first.items];
      let offset = first.next_offset;
      while (offset !== null) { const next = getCountryQualityOverview(data.catalog, data.activity, data.health, { date, offset, limit: 50 }); items.push(...next.items); offset = next.next_offset; }
      return { ...first, items, next_offset: null };
    },
    registry: observedAt => options.remote ? captureRemoteRegistry(call, observedAt)
      : { observed_at: observedAt, registry_snapshot_at: data.activity.snapshot?.registry_at ?? null, complete: true,
        sources: data.catalog.sources.map(source => ({ source_id: source.id, country: source.countryCode, name: source.name, enabled: source.enabled,
          registration_count: source.registrationCount, endpoints: source.endpoints.map(endpoint => ({ endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url })) })) },
    investigate: async (country, date) => {
      const run = investigations.start({ country, date, engine: 'rules' });
      while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 100));
      return run;
    },
    close,
  };
}

export async function runDaily(options, services = {}) {
  const now = services.now ?? (() => Date.now()), started = now();
  if (options.scheduled && new Date(started).getUTCHours() < options.notBeforeUtcHour) return { status: 'waiting_for_daily_window', date: options.date, model_calls: 0 };
  await safeDirectory(options.output); await safeDirectory(dirname(options.history));
  if (options.runtime) {
    await safeDirectory(dirname(options.runtime));
    try { const stat = await lstat(options.runtime); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('QUALITY_DAILY_UNSAFE_RUNTIME'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let historyBytes = 0;
  for (const path of [options.history, `${options.history}-wal`]) {
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('QUALITY_DAILY_UNSAFE_HISTORY');
      historyBytes += stat.size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (historyBytes >= options.maxHistoryBytes) throw Error('QUALITY_DAILY_HISTORY_STORAGE_LIMIT');
  const mode = options.remote ? 'remote' : 'local', receiptPath = join(options.output, `${options.date}-${mode}.receipt.json`);
  const configuration = digest({ source: mode, history: options.history, runtime: options.runtime ?? null, capture_registry: options.captureRegistry,
    investigate: options.investigate, max_investigations: options.maxInvestigations });
  const lockPath = join(options.output, '.quality-daily.lock'); let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error('QUALITY_DAILY_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  let runtime;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date(started).toISOString(), date: options.date }));
    if (!options.rerun) {
      let receipt;
      try { if ((await lstat(receiptPath)).isSymbolicLink()) throw Error('QUALITY_DAILY_UNSAFE_RECORD'); receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt?.status === 'completed') {
        if (receipt.configuration !== configuration) throw Error('QUALITY_DAILY_RECEIPT_CONFIG_CONFLICT');
        return { ...receipt, status: 'already_recorded', model_calls: 0 };
      }
    }
    runtime = await (services.runtimeFactory ?? defaultRuntime)(options);
    const overview = await runtime.overview(options.date), observedAt = new Date(now()).toISOString();
    runtime.history.observeOverview(overview, observedAt);
    let registry = { state: 'not_requested' }, errors = [];
    if (options.captureRegistry) {
      try { registry = runtime.history.observeRegistry(await runtime.registry(new Date(now()).toISOString())); }
      catch (error) { registry = { state: 'capture_failed', error: errorCode(error) }; errors.push(registry.error); }
    }
    const decorated = runtime.history.decorateOverview(overview), selection = investigationCountries(decorated, options.maxInvestigations), runs = [];
    if (options.investigate) for (const country of selection.countries) {
      if (now() - started > 300000) { errors.push('QUALITY_DAILY_DURATION_LIMIT'); break; }
      const run = await runtime.investigate(country, options.date);
      if (run.cost?.provider !== 'rules' || run.cost?.model_calls !== 0) throw Error('QUALITY_DAILY_PAID_ENGINE_FORBIDDEN');
      runs.push(run); if (run.status !== 'completed') errors.push('QUALITY_DAILY_INVESTIGATION_FAILED');
    }
    if (overview.runtime?.inventory_partial || overview.runtime?.failed_country_lookups > 0) errors.push('QUALITY_DAILY_PARTIAL_REMOTE_READ');
    const report = { version: 1, id: randomUUID(), date: options.date, timezone: 'UTC', started_at: new Date(started).toISOString(), observed_at: observedAt,
      finished_at: new Date(now()).toISOString(), status: errors.length ? 'partial' : 'completed', data_source: mode,
      automated_registry_changes: false, publisher_live_checks: false, scheduler_installed_by_this_run: false,
      registry_observation: registry, overview: decorated, investigations: runs, anomaly_selection: selection, errors: [...new Set(errors)],
      cost: { provider: 'rules', model_calls: 0, model_cost_usd: 0, server_cost_usd: null },
      semantics: 'Saved collection evidence; first observation is a registry baseline, not an addition date. A completed report does not imply a completed collector cycle or verified present publisher health.' };
    const reportPath = join(options.output, `${options.date}-${mode}-${report.id}.json`); await atomicJson(reportPath, report);
    const receipt = { version: 1, date: options.date, status: report.status, configuration, report_path: reportPath,
      recorded_at: report.finished_at, investigated_countries: runs.map(run => run.country), anomaly_countries: selection.total,
      registry_state: registry.state, model_calls: 0, model_cost_usd: 0, errors: report.errors };
    await atomicJson(receiptPath, receipt, true); await atomicJson(join(options.output, 'latest.json'), receipt, true);
    return receipt;
  } finally { try { await runtime?.close(); } finally { await lock.close(); await unlink(lockPath).catch(() => {}); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDaily(dailyOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result)); if (result.status === 'partial') process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: errorCode(error), model_calls: 0 })); process.exitCode = 1; }
}
