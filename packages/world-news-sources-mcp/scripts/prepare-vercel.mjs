import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,rmSync,realpathSync,statSync } from 'node:fs';
import { relative,isAbsolute,resolve,dirname,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { normalizeRegistry } from '../dist/catalog.js';
import {readHistory} from '../dist/activity-history.js';
import { snapshotSchema } from '../dist/health.js';
import { DatabaseSync } from 'node:sqlite';
import { estimatePublisherInventory, estimateGlobalPublisherInventory } from '../dist/publisher-inventory.js';

const root = new URL('../', import.meta.url);
const output = new URL('../.deploy-vercel/', import.meta.url);
const metadataPath = (variable, fallback) => process.env[variable] ? pathToFileURL(resolve(process.env[variable])) : new URL(fallback, root);
const readMetadata = path => {
  if (statSync(path).size > 16 * 1024 * 1024) throw Error('Metadata file exceeds 16 MiB limit');
  return JSON.parse(readFileSync(path, 'utf8'));
};
const registryPath = metadataPath('WNS_REGISTRY_PATH', '../../data/rss-atlas.json');
const legacyPath = metadataPath('WNS_LEGACY_HEALTH_PATH', '../../audits/readme_rss_health_latest.json');
const snapshotPath = metadataPath('WNS_HEALTH_PATH', 'audits/health-latest.json');
const activityPath = metadataPath('WNS_ACTIVITY_PATH', 'activity/activity-snapshot.json');
for (const [name, path] of [['WNS_REGISTRY_PATH', registryPath], ['WNS_LEGACY_HEALTH_PATH', legacyPath], ['WNS_HEALTH_PATH', snapshotPath], ['WNS_ACTIVITY_PATH', activityPath]]) {
  if (process.env[name] && !existsSync(path)) throw Error(`${name} does not exist`);
}
for (const dir of ['api', 'dist', 'metadata', 'public']) mkdirSync(new URL(`${dir}/`, output), { recursive: true });
const writeJson = (path, value) => writeFileSync(new URL(path, output), JSON.stringify(value) + '\n');
const raw = readMetadata(registryPath);
normalizeRegistry(raw); // Validate before preparing any upload.
const fields = ['name', 'url', 'sitemapUrl', 'persistent_source_id', 'row', 'enabled', 'category', 'language', 'tier', 'enabled_changed_at', 'status_reason', 'status_history', 'status_transition_count', 'registry_addition_batch', 'source_homepage', 'endpoint_provenance'];
const registry = { countries: raw.countries.map(country => ({ code: country.code, name: country.name,
  feeds: country.feeds.map(feed => Object.fromEntries(fields.filter(key => feed[key] !== undefined).map(key => [key, feed[key]]))),
})) };
const legacy = readMetadata(legacyPath);
writeJson('metadata/registry.json', registry);
writeJson('metadata/legacy-health.json', { results: (legacy.results ?? []).map(({ countryCode, outlet, url, checkedAt, valid, httpCode }) =>
  ({ countryCode, outlet, url, checkedAt, valid, httpCode })) });
const snapshot = existsSync(snapshotPath) ? snapshotSchema.parse(readMetadata(snapshotPath)) : undefined;
writeJson('metadata/health.json', snapshot ?? { version: 1, observations: [] });
const activity = existsSync(activityPath) ? readMetadata(activityPath) : null;
if(activity && (activity.version !== 1 || activity.lane !== 'production')) throw new Error('Invalid production activity snapshot');
writeJson('metadata/activity.json', activity);
// A real complete daily MCP report makes the first dashboard load independent of 73 network reads.
let savedOverview = null;
const reportsDirectory = new URL('output/news-quality/daily/', root);
const receiptFile = new URL('latest.json', reportsDirectory);
if (existsSync(receiptFile)) {
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  const reportPath = realpathSync(receipt.report_path);
  const within = relative(realpathSync(reportsDirectory), reportPath);
  if (isAbsolute(within) || within === '..' || within.startsWith('../') || statSync(reportPath).size > 10*1024*1024) throw Error('Invalid saved dashboard report');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.data_source === 'remote' && report.status === 'completed' && report.overview?.date === report.date && Array.isArray(report.overview?.items)) {
    // Publish only derived counts from the exact complete registry revision.
    // The private observation database and full listing stay out of the bundle.
    const historyFile = new URL('output/news-quality/history.sqlite', root);
    if (existsSync(historyFile) && report.overview.registry_snapshot_at) {
      const db = new DatabaseSync(fileURLToPath(historyFile), { readOnly: true });
      try {
        const row = db.prepare('SELECT sources FROM quality_registry WHERE registry_snapshot_at=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(report.overview.registry_snapshot_at);
        if (row) {
          const sources = JSON.parse(String(row.sources));
          report.overview.items = report.overview.items.map(country => {
            const selected = sources.filter(source => source.country === country.country);
            return selected.filter(source => source.enabled).length === country.inventory?.active_normalized_sources
              ? { ...country, inventory: { ...country.inventory, ...estimatePublisherInventory(selected),
                publisher_inventory_snapshot_at: report.overview.registry_snapshot_at } } : country;
          });
          const active = sources.filter(source => source.enabled);
          const endpoints = type => new Set(active.flatMap(source => source.endpoints.filter(endpoint => endpoint.type === type).map(endpoint => endpoint.endpoint_id))).size;
          const global = report.overview.global_inventory;
          if (global && endpoints('rss') === global.unique_active_rss_endpoints && endpoints('sitemap') === global.unique_active_sitemap_endpoints)
            report.overview.global_inventory = { ...global, ...estimateGlobalPublisherInventory(sources), publisher_inventory_snapshot_at: report.overview.registry_snapshot_at };
        }
      } finally { db.close(); }
    }
    savedOverview = { ...report.overview, history: undefined,
      source: 'daily_saved_remote_mcp', evaluated_at: report.observed_at,
      runtime: { data_source: 'daily_saved_remote_mcp', report_observed_at: report.observed_at,
        report_status: report.status, sources_read_only: true, publisher_fetches: false } };
  }
}
writeJson('metadata/quality-overview.json', savedOverview);
const historyOutput=new URL('metadata/activity-history/',output);rmSync(historyOutput,{recursive:true,force:true});mkdirSync(historyOutput,{recursive:true});
for(const shard of activity?.history?.shards??[]){
  const historyDirectory = join(dirname(fileURLToPath(activityPath)), 'history');
  readHistory(historyDirectory,shard);
  copyFileSync(join(historyDirectory,shard.file),new URL(shard.file,historyOutput));
}
// Copy the complete runtime import graph, never operator state, keys or collector databases.
const modules = new Set(['http.js', 'activity.js', 'catalog.js', 'health.js', 'metrics.js']);
const pendingModules = [...modules];
while (pendingModules.length) {
  const file = pendingModules.shift();
  const source = readFileSync(new URL(`dist/${file}`, root), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]\.\/([a-zA-Z0-9_-]+\.js)['"]/g)) {
    if (!modules.has(match[1])) { modules.add(match[1]); pendingModules.push(match[1]); }
  }
}
// Remove old generated modules instead of accidentally uploading stale code.
rmSync(new URL('dist/', output), { recursive: true, force: true }); mkdirSync(new URL('dist/', output), { recursive: true });
for (const file of modules) copyFileSync(new URL(`dist/${file}`, root), new URL(`dist/${file}`, output));
copyFileSync(new URL('scripts/quality-cloud-gateway.mjs', root), new URL('dist/quality-cloud-gateway.mjs', output));
mkdirSync(new URL('dashboard/', output), { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css']) copyFileSync(new URL(`dashboard/${file}`, root), new URL(`dashboard/${file}`, output));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
writeJson('package.json', { ...pkg, scripts: {}, engines: { node: '22.x' } });
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
lock.packages[''].engines = { node: '22.x' };
writeJson('package-lock.json', lock);
writeJson('vercel.json', {
  framework: null, installCommand: 'npm ci --omit=dev --ignore-scripts', buildCommand: '', outputDirectory: 'public', cleanUrls: true,
  functions: { 'api/*.mjs': { maxDuration: 60,includeFiles:'{metadata/activity-history/**,dashboard/**}' } },
  rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/health', destination: '/api/health' },
    { source: '/quality', destination: '/api/quality' }, { source: '/quality/', destination: '/api/quality' },
    { source: '/quality/app.js', destination: '/api/quality?path=app.js' }, { source: '/quality/styles.css', destination: '/api/quality?path=styles.css' },
    { source: '/quality/:path*', destination: '/api/quality?path=:path*' }],
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] },
    { source: '/.well-known/openai-apps-challenge', headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }] }],
});
writeFileSync(new URL('dist/hosted.mjs', output), `import {fileURLToPath} from 'node:url';
import registry from '../metadata/registry.json' with {type:'json'};
import legacy from '../metadata/legacy-health.json' with {type:'json'};
import snapshot from '../metadata/health.json' with {type:'json'};
import activity from '../metadata/activity.json' with {type:'json'};
import savedOverview from '../metadata/quality-overview.json' with {type:'json'};
import {ActivityStore} from './activity.js';
import {normalizeRegistry} from './catalog.js';
import {HealthStore} from './health.js';
import {createHttpHandler} from './http.js';
import {createAggregateSink} from './metrics.js';
const hosts = ['news.bymyleslee.com', process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
export const handler = createHttpHandler(normalizeRegistry(registry), new HealthStore(snapshot, legacy), hosts,
  createAggregateSink(process.env.METRICS_COLLECTOR_URL,process.env.METRICS_WRITE_SECRET),new ActivityStore(activity ?? undefined,fileURLToPath(new URL('../metadata/activity-history/',import.meta.url))),registry,false,true,
  {savedRemoteOverview:date=>savedOverview && savedOverview.date===(date??new Date(Date.now()-86400000).toISOString().slice(0,10)) ? savedOverview : undefined});
`);
for (const route of ['mcp', 'health']) writeFileSync(new URL(`api/${route}.mjs`, output),
  `import {handler} from '../dist/hosted.mjs';\nexport default {fetch(request){const url=new URL(request.url);url.pathname='/${route}';return handler.fetch(new Request(url,request));}};\n`);
writeFileSync(new URL('api/quality.mjs', output),
  `import {handler} from '../dist/hosted.mjs';\nimport {createQualityCloudGateway,normalizeQualityRequest} from '../dist/quality-cloud-gateway.mjs';\nconst gateway=createQualityCloudGateway({backendUrl:process.env.WNS_QUALITY_BACKEND_URL,gatewayToken:process.env.WNS_QUALITY_GATEWAY_TOKEN,publicOrigins:[process.env.WNS_QUALITY_PUBLIC_ORIGIN]});\nexport default {async fetch(request){const forwarded=normalizeQualityRequest(request);if(!forwarded)return new Response('Not found',{status:404});const url=new URL(forwarded.url);if(url.pathname.startsWith('/quality/api/')&&process.env.WNS_QUALITY_BACKEND_URL)return gateway(forwarded);return handler.fetch(forwarded);}};\n`);
for (const file of ['index.html', 'support.html', 'privacy.html', 'terms.html', 'styles.css', 'icon.svg']) {
  copyFileSync(new URL(`site/${file}`, root), new URL(`public/${file}`, output));
}
mkdirSync(new URL('public/.well-known/', output), { recursive: true });
copyFileSync(new URL('site/.well-known/openai-apps-challenge', root), new URL('public/.well-known/openai-apps-challenge', output));
console.log(`Prepared metadata-only Vercel bundle: ${fileURLToPath(output)}`);
