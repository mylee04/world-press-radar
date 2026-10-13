import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadData } from './config.js';
import { createCloudQualityRuntime } from './quality-local-runtime.js';
import { createQualityHandler } from './quality-http.js';
import { CloudQualityDataCache } from './quality-cloud-data.js';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

const port = Number(process.env.WNS_PORT ?? '3401');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('QUALITY_CLOUD_PORT_INVALID');
for (const key of ['WNS_REGISTRY_PATH', 'WNS_HEALTH_PATH', 'WNS_ACTIVITY_PATH'])
  if (!process.env[key] || !isAbsolute(process.env[key]!)) throw Error('QUALITY_CLOUD_DATA_PATHS_REQUIRED');
const runtime = createCloudQualityRuntime();
const cache = new CloudQualityDataCache([
  process.env.WNS_REGISTRY_PATH ?? fileURLToPath(new URL('../../../data/rss-atlas.json', import.meta.url)),
  process.env.WNS_HEALTH_PATH ?? fileURLToPath(new URL('../audits/health-latest.json', import.meta.url)),
  process.env.WNS_LEGACY_HEALTH_PATH ?? fileURLToPath(new URL('../../../audits/readme_rss_health_latest.json', import.meta.url)),
  process.env.WNS_ACTIVITY_PATH ?? fileURLToPath(new URL('../activity/activity-snapshot.json', import.meta.url)),
], () => {
  const data = loadData();
  return { data, quality: createQualityHandler(data.catalog, data.health, data.activity, data.rawRegistry, true,
    process.env.WNS_QUALITY_REMOTE === '1', runtime.options) };
}, () => runtime.store.list(100).some(run => run.status === 'running'));
const server = createServer(toNodeHandler({ async fetch(request: Request) {
  const url = new URL(request.url);
  // The backend never listens on a public interface; nginx is the only external transport.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return new Response('Invalid host', { status: 403 });
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', service: 'news-quality',
    persistence: 'sqlite', source_snapshot_at: cache.get().data.activity.snapshot?.generated_at ?? null,
    metadata_reload_failed: cache.reloadFailed() }, { headers: { 'cache-control': 'no-store' } });
  // Reject a direct external request before touching snapshots or durable state.
  try { runtime.options.cloudAccess!.publicUrl(request); }
  catch { return Response.json({ error: 'QUALITY_GATEWAY_AUTH_REQUIRED' }, { status: 403, headers: { 'cache-control': 'no-store' } }); }
  const response = await cache.get().quality(request);
  return response ?? new Response('Not found', { status: 404 });
} }));
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.error(`News quality cloud backend listening on loopback:${port}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  server.close();
  await runtime.close();
});
