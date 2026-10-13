import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,rmSync,realpathSync,statSync } from 'node:fs';
import { relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRegistry } from '../dist/catalog.js';
import {readHistory} from '../dist/activity-history.js';
import { snapshotSchema } from '../dist/health.js';

const root = new URL('../', import.meta.url);
const output = new URL('../.deploy-vercel/', import.meta.url);
for (const dir of ['api', 'dist', 'metadata', 'public']) mkdirSync(new URL(`${dir}/`, output), { recursive: true });
const writeJson = (path, value) => writeFileSync(new URL(path, output), JSON.stringify(value) + '\n');
const raw = JSON.parse(readFileSync(new URL('../../data/rss-atlas.json', root), 'utf8'));
normalizeRegistry(raw); // Validate before preparing any upload.
const fields = ['name', 'url', 'sitemapUrl', 'row', 'enabled', 'category', 'language', 'tier', 'enabled_changed_at', 'status_reason', 'status_history', 'status_transition_count', 'registry_addition_batch', 'source_homepage', 'endpoint_provenance'];
const registry = { countries: raw.countries.map(country => ({ code: country.code, name: country.name,
  feeds: country.feeds.map(feed => Object.fromEntries(fields.filter(key => feed[key] !== undefined).map(key => [key, feed[key]]))),
})) };
const legacy = JSON.parse(readFileSync(new URL('../../audits/readme_rss_health_latest.json', root), 'utf8'));
writeJson('metadata/registry.json', registry);
writeJson('metadata/legacy-health.json', { results: (legacy.results ?? []).map(({ countryCode, outlet, url, checkedAt, valid, httpCode }) =>
  ({ countryCode, outlet, url, checkedAt, valid, httpCode })) });
const snapshotPath = new URL('audits/health-latest.json', root);
const snapshot = existsSync(snapshotPath) ? snapshotSchema.parse(JSON.parse(readFileSync(snapshotPath, 'utf8'))) : undefined;
writeJson('metadata/health.json', snapshot ?? { version: 1, observations: [] });
const activityPath = new URL('activity/activity-snapshot.json', root);
const activity = existsSync(activityPath) ? JSON.parse(readFileSync(activityPath, 'utf8')) : null;
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
    savedOverview = { ...report.overview, history: undefined,
      source: 'daily_saved_remote_mcp', evaluated_at: report.observed_at,
      runtime: { data_source: 'daily_saved_remote_mcp', report_observed_at: report.observed_at,
        report_status: report.status, sources_read_only: true, publisher_fetches: false } };
  }
}
writeJson('metadata/quality-overview.json', savedOverview);
const historyOutput=new URL('metadata/activity-history/',output);rmSync(historyOutput,{recursive:true,force:true});mkdirSync(historyOutput,{recursive:true});
for(const shard of activity?.history?.shards??[]){
  readHistory(fileURLToPath(new URL('activity/history/',root)),shard);
  copyFileSync(new URL(`activity/history/${shard.file}`,root),new URL(shard.file,historyOutput));
}
// Copy the complete runtime import graph, never operator state, keys or collector databases.
const modules = new Set(['http.js']);
const pendingModules = [...modules];
while (pendingModules.length) {
  const file = pendingModules.shift();
  const source = readFileSync(new URL(`dist/${file}`, root), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]\.\/([a-zA-Z0-9_-]+\.js)['"]/g)) {
    if (!modules.has(match[1])) { modules.add(match[1]); pendingModules.push(match[1]); }
  }
}
for (const file of modules) copyFileSync(new URL(`dist/${file}`, root), new URL(`dist/${file}`, output));
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
  rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/health', destination: '/api/health' }, { source: '/quality/:path*', destination: '/api/quality?path=:path*' }],
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
  `import {handler} from '../dist/hosted.mjs';\nexport default {fetch(request){const url=new URL(request.url);const path=url.searchParams.get('path')??'';url.pathname='/quality/'+path;url.searchParams.delete('path');return handler.fetch(new Request(url,request));}};\n`);
for (const file of ['index.html', 'support.html', 'privacy.html', 'terms.html', 'styles.css', 'icon.svg']) {
  copyFileSync(new URL(`site/${file}`, root), new URL(`public/${file}`, output));
}
mkdirSync(new URL('public/.well-known/', output), { recursive: true });
copyFileSync(new URL('site/.well-known/openai-apps-challenge', root), new URL('public/.well-known/openai-apps-challenge', output));
console.log(`Prepared metadata-only Vercel bundle: ${fileURLToPath(output)}`);
