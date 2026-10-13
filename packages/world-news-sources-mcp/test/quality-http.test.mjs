import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../dist/http.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { InvestigationStore } from '../dist/investigation.js';

const raw = { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Successful zero', url: 'https://example.com/feed' }] }] };
const catalog = normalizeRegistry(raw), source = catalog.sources[0], endpoint = source.endpoints[0];
function activity() {
  return new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-13T02:00:00.000Z',
    registry_at: '2026-10-13T01:00:00.000Z', tracking_start: '2026-10-01T00:00:00.000Z',
    available_since: '2026-10-01T00:00:00.000Z', semantics: 'Fixture, not published articles',
    scope_starts: { source: { [source.id]: '2026-10-01T00:00:00.000Z' }, country: { US: '2026-10-01T00:00:00.000Z' } },
    scope_latest: { source: { [source.id]: '2026-10-13T01:00:00.000Z' }, country: { US: '2026-10-13T01:00:00.000Z' } },
    bindings: [{ source_id: source.id, endpoint_id: endpoint.id, country: 'US', baseline_at: '2026-10-01T00:00:00.000Z' }],
    collections: ['2026-10-11', '2026-10-12', '2026-10-13'].map(date => ({ endpoint_id: endpoint.id,
      checked_at: `${date}T01:00:00.000Z`, status: 'working_nonempty', format: 'rss', source_ids: [source.id],
      countries: ['US'], source_new: { [source.id]: 0 }, country_new: { US: 0 }, baseline_sources: [], uncertain_urls: 0 })) });
}
function create(allow = true) { return createHttpHandler(catalog, new HealthStore(), ['example.com'], undefined, activity(), raw, allow); }
const post = (body, headers = {}) => new Request('https://example.com/quality/api/investigations', { method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://example.com', ...headers }, body: JSON.stringify(body) });

test('quality overview/drilldown retain zero discoveries and expose unresolved inventory history', async t => {
  const handler = create(); t.after(() => handler.close());
  const overview = await (await handler.fetch(new Request('https://example.com/quality/api/overview?date=2026-10-12'))).json();
  assert.equal(overview.items[0].metrics.success_rate.value, 100);
  assert.equal(overview.items[0].metrics.freshness.value, null);
  assert.equal(overview.inventory_changes.per_country[0].deletions, null);
  const sourceDetail = await (await handler.fetch(new Request(`https://example.com/quality/api/source?source_id=${source.id}&date=2026-10-12`))).json();
  assert.equal(sourceDetail.article_activity.daily.new_unique_candidate_urls, 0);
  assert.equal(sourceDetail.endpoints[0].classification, 'successful_no_new_discoveries');
});

test('bounded actual MCP investigation logs successful calls and preserves zero as a normal observation', async () => {
  const store = new InvestigationStore(catalog, new HealthStore(), activity());
  const run = store.start({ country: 'US', date: '2026-10-12' });
  const until = Date.now() + 5000;
  while (run.status === 'running' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.status, 'completed', run.summary);
  assert.ok(run.events.some(event => event.tool === 'get_source_collection_quality' && event.status === 'completed'));
  assert.equal(run.events.filter(event => event.tool !== null).length, run.tool_calls);
  assert.ok(run.events.filter(event => event.tool).every(event => event.duration_ms >= 0 && event.result));
  assert.equal(run.findings[0].classification, 'successful_no_new_discoveries');
  assert.equal(run.findings[0].live_failure_confirmed, false);
  assert.equal(run.cost.model_calls, 0);
  assert.equal(run.cost.server_cost_usd, null);
  assert.ok(run.events.every(event => event.parent_id === null));
});

test('dashboard start checks origin/body size/schema and hosted run support', async t => {
  const handler = create(), hosted = create(false); t.after(() => Promise.all([handler.close(), hosted.close()]));
  assert.equal((await handler.fetch(post({ country: 'US' }, { origin: 'https://chatgpt.com' }))).status, 403);
  assert.equal((await handler.fetch(post({ country: 'US' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await handler.fetch(post({ country: 'US', surprise: true }))).status, 400);
  assert.equal((await handler.fetch(post({ country: 'ZZ' }))).status, 400);
  assert.equal((await handler.fetch(post({ country: 'US', date: '2026-02-30' }))).status, 400);
  assert.equal((await handler.fetch(post({ padding: 'a'.repeat(9000) }))).status, 413);
  assert.equal((await handler.fetch(post({ country: 'US' }, { 'content-type': 'text/plain' }))).status, 400);
  assert.equal((await hosted.fetch(post({ country: 'US' }))).status, 503);
  assert.equal((await handler.fetch(post({ country: 'US', engine: 'openai' }))).status, 403);
  assert.equal((await handler.fetch(post({ country: 'US', engine: 'openai', budget_usd: 100 }))).status, 400);
});

test('expired completed runs are not exposed after the documented retention window', async () => {
  const store = new InvestigationStore(catalog, new HealthStore(), activity());
  const expired = { id: 'expired-fixture', status: 'completed', started_at: new Date(Date.now() - 3600001).toISOString() };
  store.runs.set(expired.id, expired);
  assert.equal(store.get(expired.id), undefined);
  assert.equal(store.runs.has(expired.id), false);
});

test('lost start response can be recovered by request ID without executing twice', async t => {
  const handler = create(); t.after(() => handler.close());
  const requestId = '52464baf-cc5b-4f1b-a4b7-a1df3f501c1c';
  const input = { country: 'US', date: '2026-10-12', engine: 'rules', request_id: requestId };
  // Simulate the browser losing the POST response after the server accepted it.
  await handler.fetch(post(input));
  const lookup = new Request(`https://example.com/quality/api/investigations/requests/${requestId}`);
  const recovered = await (await handler.fetch(lookup)).json();
  assert.equal(recovered.request_id,requestId);
  const repeated = await (await handler.fetch(post(input))).json();
  assert.equal(repeated.id,recovered.id);
  assert.equal(repeated.started_at,recovered.started_at);
  assert.equal((await handler.fetch(post({...input,date:'2026-10-11'}))).status,400);
  assert.equal((await handler.fetch(post({...input,engine:'openai'}))).status,400);
  assert.equal((await handler.fetch(post({...input,request_id:'bad'}))).status,400);
  assert.equal((await handler.fetch(new Request('https://example.com/quality/api/investigations/requests/95d2efc8-33f4-4697-bbaf-b13850e8f58c'))).status,404);
});

test('quality routes preserve host guards, forbid arbitrary files and return unknown-run errors', async t => {
  const handler = create(); t.after(() => handler.close());
  assert.equal((await handler.fetch(new Request('https://evil.example/quality/api/overview'))).status, 403);
  assert.equal((await handler.fetch(new Request('https://example.com/quality/.env.local'))).status, 404);
  assert.equal((await handler.fetch(new Request('https://example.com/quality/api/investigations/00000000-0000-0000-0000-000000000000'))).status, 404);
  const html = await handler.fetch(new Request('https://example.com/quality'));
  assert.equal(html.status, 200);
  assert.ok(html.headers.get('content-security-policy').includes("script-src 'self'"));
});
