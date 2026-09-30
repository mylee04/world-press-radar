import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRegistry } from '../dist/catalog.js';
import { snapshotSchema } from '../dist/health.js';

const root = new URL('../', import.meta.url);
const output = new URL('../.deploy-vercel/', import.meta.url);
for (const dir of ['api', 'dist', 'metadata', 'public']) mkdirSync(new URL(`${dir}/`, output), { recursive: true });
const writeJson = (path, value) => writeFileSync(new URL(path, output), JSON.stringify(value) + '\n');
const raw = JSON.parse(readFileSync(new URL('../../data/rss-atlas.json', root), 'utf8'));
normalizeRegistry(raw); // Validate before preparing any upload.
const fields = ['name', 'url', 'sitemapUrl', 'row', 'enabled', 'category', 'language', 'tier'];
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
for (const file of ['catalog.js', 'health.js', 'http.js', 'server.js']) copyFileSync(new URL(`dist/${file}`, root), new URL(`dist/${file}`, output));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
writeJson('package.json', { ...pkg, scripts: {}, engines: { node: '22.x' } });
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
lock.packages[''].engines = { node: '22.x' };
writeJson('package-lock.json', lock);
writeJson('vercel.json', {
  framework: null, installCommand: 'npm ci --omit=dev --ignore-scripts', buildCommand: '', outputDirectory: 'public',
  functions: { 'api/*.mjs': { maxDuration: 10 } },
  rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/health', destination: '/api/health' }],
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }],
});
writeFileSync(new URL('dist/hosted.mjs', output), `import registry from '../metadata/registry.json' with {type:'json'};
import legacy from '../metadata/legacy-health.json' with {type:'json'};
import snapshot from '../metadata/health.json' with {type:'json'};
import {normalizeRegistry} from './catalog.js';
import {HealthStore} from './health.js';
import {createHttpHandler} from './http.js';
const hosts = ['news.bymyleslee.com', process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
export const handler = createHttpHandler(normalizeRegistry(registry), new HealthStore(snapshot, legacy), hosts);
`);
for (const route of ['mcp', 'health']) writeFileSync(new URL(`api/${route}.mjs`, output),
  `import {handler} from '../dist/hosted.mjs';\nexport default {fetch(request){const url=new URL(request.url);url.pathname='/${route}';return handler.fetch(new Request(url,request));}};\n`);
writeFileSync(new URL('public/index.html', output), '<!doctype html><html lang="en"><meta charset="utf-8"><title>World News Sources</title><body><h1>World News Sources</h1><p>Read-only RSS and sitemap source metadata over MCP.</p><p>MCP endpoint: <code>/mcp</code></p><p><a href="/health">Service status</a></p><p>Configured sources are not verified live feeds. Cached health can be stale or unknown.</p></body></html>\n');
console.log(`Prepared metadata-only Vercel bundle: ${fileURLToPath(output)}`);
