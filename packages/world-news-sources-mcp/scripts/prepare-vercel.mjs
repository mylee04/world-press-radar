import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,rmSync } from 'node:fs';
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
const fields = ['name', 'url', 'sitemapUrl', 'row', 'enabled', 'category', 'language', 'tier', 'enabled_changed_at', 'status_reason', 'status_history', 'status_transition_count'];
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
const historyOutput=new URL('metadata/activity-history/',output);rmSync(historyOutput,{recursive:true,force:true});mkdirSync(historyOutput,{recursive:true});
for(const shard of activity?.history?.shards??[]){
  readHistory(fileURLToPath(new URL('activity/history/',root)),shard);
  copyFileSync(new URL(`activity/history/${shard.file}`,root),new URL(shard.file,historyOutput));
}
for (const file of ['catalog.js', 'status.js', 'health.js', 'http.js', 'server.js', 'metrics.js', 'activity.js','activity-history.js']) copyFileSync(new URL(`dist/${file}`, root), new URL(`dist/${file}`, output));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
writeJson('package.json', { ...pkg, scripts: {}, engines: { node: '22.x' } });
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
lock.packages[''].engines = { node: '22.x' };
writeJson('package-lock.json', lock);
writeJson('vercel.json', {
  framework: null, installCommand: 'npm ci --omit=dev --ignore-scripts', buildCommand: '', outputDirectory: 'public', cleanUrls: true,
  functions: { 'api/*.mjs': { maxDuration: 10,includeFiles:'metadata/activity-history/**' } },
  rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/health', destination: '/api/health' }],
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] },
    { source: '/.well-known/openai-apps-challenge', headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }] }],
});
writeFileSync(new URL('dist/hosted.mjs', output), `import {fileURLToPath} from 'node:url';
import registry from '../metadata/registry.json' with {type:'json'};
import legacy from '../metadata/legacy-health.json' with {type:'json'};
import snapshot from '../metadata/health.json' with {type:'json'};
import activity from '../metadata/activity.json' with {type:'json'};
import {ActivityStore} from './activity.js';
import {normalizeRegistry} from './catalog.js';
import {HealthStore} from './health.js';
import {createHttpHandler} from './http.js';
import {createAggregateSink} from './metrics.js';
const hosts = ['news.bymyleslee.com', process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
export const handler = createHttpHandler(normalizeRegistry(registry), new HealthStore(snapshot, legacy), hosts,
  createAggregateSink(process.env.METRICS_COLLECTOR_URL,process.env.METRICS_WRITE_SECRET),new ActivityStore(activity ?? undefined,fileURLToPath(new URL('../metadata/activity-history/',import.meta.url))));
`);
for (const route of ['mcp', 'health']) writeFileSync(new URL(`api/${route}.mjs`, output),
  `import {handler} from '../dist/hosted.mjs';\nexport default {fetch(request){const url=new URL(request.url);url.pathname='/${route}';return handler.fetch(new Request(url,request));}};\n`);
for (const file of ['index.html', 'support.html', 'privacy.html', 'terms.html', 'styles.css', 'icon.svg']) {
  copyFileSync(new URL(`site/${file}`, root), new URL(`public/${file}`, output));
}
mkdirSync(new URL('public/.well-known/', output), { recursive: true });
copyFileSync(new URL('site/.well-known/openai-apps-challenge', root), new URL('public/.well-known/openai-apps-challenge', output));
console.log(`Prepared metadata-only Vercel bundle: ${fileURLToPath(output)}`);

// Approved static demo, retained by every scheduled bundle preparation.
const demoSource = new URL('site/demo/world-news-sources.mp4', root);
if (existsSync(demoSource)) {
  mkdirSync(new URL('public/demo/', output), {recursive: true});
  copyFileSync(demoSource, new URL('public/demo/world-news-sources.mp4', output));
}
