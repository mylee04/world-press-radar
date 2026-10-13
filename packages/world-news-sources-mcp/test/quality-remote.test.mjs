import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteQualityStore, readRemoteNewsTool, createRemoteNewsReader } from '../dist/quality-remote.js';

const date = '2026-10-12', id = `src_${'a'.repeat(24)}`, ep = `ep_${'b'.repeat(24)}`;
const inventory = (country = 'US') => ({country, name: country, active_source_registrations: 12, active_normalized_sources: 10,
  disabled_source_registrations: 2, unique_active_rss_endpoints: 8, unique_active_sitemap_endpoints: 4});
const day = (period, values = {}) => ({period, from: `${period}T00:00:00.000Z`, to_exclusive: `${period}T23:59:59.000Z`,
  new_unique_candidate_urls: 0, state: 'partial', expected_endpoints: 12, targeted_endpoints: 8, successful_article_endpoints: 6,
  failed_checks: 2, index_only_checks: 0, baseline_checks: 0, ...values});
const activity = items => ({items, snapshot_at:'2026-10-13T03:53:00.000Z', latest_collection:'2026-10-13T03:52:00.000Z',
  scope_tracking_start:'2026-10-01T00:00:00.000Z', history_available_since:'2026-10-01T00:00:00.000Z', initialization:'initialized',
  metric:'first_discovered_unique_candidate_url_after_binding_baseline'});
const source = () => ({id, name:'Test Outlet', countryCode:'US', countryName:'United States', enabled:true, activeRegistrationCount:1,
  endpoints:[{id:ep,type:'rss',url:'https://news.example/rss',health:{status:'unknown',checked_at:null,content_freshness:'missing'}}]});

test('overview reads original public tools and computes saved ratios without fabricated baseline or freshness', async () => {
  const calls = [];
  const store = new RemoteQualityStore(async (name, args) => {
    calls.push({name,args});
    if (name === 'get_country_source_inventory') return {items:[inventory()],total:1,next_offset:null,registry_snapshot_at:'2026-10-13T00:00:00.000Z',
      global_totals:{active_countries:1,active_source_registrations:12,unique_active_rss_endpoints:7,unique_active_sitemap_endpoints:4}};
    return activity([day(date)]);
  });
  const got = await store.overview(date), row = got.items[0];
  assert.equal(row.metrics.attempt_coverage.value, 100*8/12); assert.equal(row.metrics.success_rate.value, 75);
  assert.equal(row.metrics.successful_registered_coverage.value, 50); assert.equal(row.metrics.freshness.value, null);
  assert.equal(row.baseline.state,'insufficient_comparable_history'); assert.equal(row.anomaly.operational_failure_confirmed,false);
  assert.equal(row.period.observation_window_closed,true); assert.equal(got.latest_collection,'2026-10-13T03:52:00.000Z');
  assert.equal(got.source,'remote_cached_mcp'); assert.equal(got.inventory_changes.per_country[0].additions,null);
  assert.equal(got.inventory_changes.recorded_events_only,false);
  assert.equal(got.inventory_changes.as_of,'2026-10-13T00:00:00.000Z');
  assert.equal(row.inventory.disabled_source_registrations,2);
  assert.equal(row.inventory.unique_publishers,null);
  assert.equal(got.global_inventory.unique_active_rss_endpoints,7); // Never sum country unique counts (8) into global (7).
  assert.deepEqual(calls.map(call=>call.name),['get_country_source_inventory','get_country_article_activity']);
  assert.equal(calls[1].args.start_date,'2026-10-06'); assert.equal(calls[1].args.end_date,date);
  await store.overview(date); assert.equal(calls.length,4); // Injected observers never get fake cached tool events.
});

test('missing registry timestamp and change ledger never become current time or zero events', async () => {
  const store = new RemoteQualityStore(async name => name === 'get_country_source_inventory'
    ? {items:[inventory()],total:1,next_offset:null} : activity([day(date)]));
  const changes = (await store.overview(date)).inventory_changes;
  assert.equal(changes.as_of,null);
  assert.equal(changes.recorded_events_only,false);
  assert.equal(changes.unknown_addition_timestamp_count,null);
  for (const key of ['additions','deactivations','reactivations','deletions','net_change'])
    assert.equal(changes.per_country[0][key],null);
  assert.equal(changes.state,'addition_and_deletion_ledgers_not_exported');
});

test('inventory pagination and selected-country overview keep actual call scope bounded', async () => {
  const calls = [];
  const store = new RemoteQualityStore(async (name,args) => {
    calls.push({name,args});
    if (name === 'get_country_source_inventory') return args.offset === 0 ? {items:[inventory('JP')],total:2,next_offset:1}
      : {items:[inventory('US')],total:2,next_offset:null};
    return activity([day(date)]);
  });
  const got = await store.overview(date,'US'); assert.equal(got.items.length,1); assert.equal(got.items[0].country,'US');
  assert.equal(got.common_collector_signal.assessment_scope,'selected_country_only');
  assert.equal(calls.filter(call=>call.name==='get_country_article_activity').length,1);
  assert.equal(calls.at(-1).args.country,'US');
});

test('country activity concurrency is four and a failed lookup stays unknown', async () => {
  let active = 0, maximum = 0;
  const store = new RemoteQualityStore(async name => {
    if (name === 'get_country_source_inventory') return {items:Array.from({length:9},(_,i)=>inventory(`C${i}`)),total:9,next_offset:null};
    active++; maximum=Math.max(maximum,active); await new Promise(resolve=>setTimeout(resolve,2)); active--;
    if (maximum===4) throw Error('Saved record unavailable'); return activity([day(date)]);
  });
  const got = await store.overview(date); assert.equal(maximum,4); assert.ok(got.runtime.failed_country_lookups>0);
  const failed = got.items.find(row=>row.lookup_error);
  assert.equal(failed.metrics.success_rate.value,null); assert.equal(failed.metrics.attempt_coverage.value,null);
  assert.equal(failed.period.state,'lookup_failed'); assert.equal(failed.period.run_completion,'unknown');
  assert.equal(failed.period.data_available,false); assert.match(failed.period.lookup_error,/Saved record unavailable/);
  assert.equal(got.common_collector_signal.assessment_scope,'bounded_country_sample');
  assert.equal(got.common_collector_signal.checked_country_count,got.items.filter(row=>!row.lookup_error).length);
});

test('inventory bound never claims complete country assessment when more than 73 countries exist', async () => {
  let activityCalls = 0;
  const store = new RemoteQualityStore(async (name,args) => {
    if (name === 'get_country_source_inventory') return {items:Array.from({length:50},(_,index)=>inventory(`C${args.offset+index}`)),
      total:100,next_offset:args.offset+50 < 100 ? args.offset+50 : null};
    activityCalls++; return activity([day(date)]);
  });
  const got = await store.overview(date);
  assert.equal(got.items.length,73); assert.equal(activityCalls,73); assert.equal(got.runtime.inventory_partial,true);
  assert.equal(got.common_collector_signal.total_catalog_countries,100);
  assert.equal(got.common_collector_signal.checked_country_count,73);
  assert.equal(got.common_collector_signal.requested_country_count,73);
  assert.equal(got.common_collector_signal.assessment_scope,'bounded_country_sample');
});

test('saved watermark keeps an incomplete day partial; untracked counts remain null', async () => {
  const store = new RemoteQualityStore(async name => name==='get_country_source_inventory' ? {items:[inventory()],total:1,next_offset:null}
    : {...activity([day(date,{state:'not_tracked',targeted_endpoints:0,successful_article_endpoints:0,new_unique_candidate_urls:null})]), latest_collection:'2026-10-12T03:52:00.000Z'});
  const got = await store.overview(date); assert.equal(got.items[0].period.observation_window_closed,false);
  assert.equal(got.items[0].metrics.attempt_coverage.value,null); assert.equal(got.items[0].metrics.success_rate.value,null);
});

test('source single-endpoint failure after earlier success is dated evidence, never a fake exact timestamp', async () => {
  const s=source(), a=activity([day('2026-10-11',{expected_endpoints:1,targeted_endpoints:1,successful_article_endpoints:1,failed_checks:0,new_unique_candidate_urls:4}),
    day(date,{expected_endpoints:1,targeted_endpoints:1,successful_article_endpoints:0,failed_checks:1,new_unique_candidate_urls:null})]);
  const calls=[]; const store=new RemoteQualityStore(async(name,args)=>{calls.push({name,args});return name==='get_source'?s:a;});
  const got=await store.source(id,date), endpoint=got.endpoints[0];
  assert.equal(endpoint.classification,'failure_after_prior_success'); assert.equal(endpoint.prior_success_at,null);
  assert.equal(endpoint.prior_success_date,'2026-10-11'); assert.equal(endpoint.last_collection.checked_at,null);
  assert.equal(endpoint.daily.attributed_source_new_urls,null); assert.equal(endpoint.daily.new_unique_candidate_urls,null);
  assert.equal(got.article_activity.daily.new_unique_candidate_urls,null); assert.equal(got.article_activity.weekly.new_unique_candidate_urls,4);
  assert.equal(got.article_activity.weekly.known_days,1); assert.equal(got.article_activity.weekly.unknown_days,6);
  assert.equal(calls[1].args.start_date,'2026-09-13'); assert.equal(calls[1].args.end_date,date);
});

test('successful zero and later recovery are distinct; mixed or multi-endpoint evidence stays insufficient', async () => {
  const s=source(); let a=activity([day('2026-10-11',{targeted_endpoints:1,successful_article_endpoints:0,failed_checks:1,new_unique_candidate_urls:null}),
    day(date,{targeted_endpoints:1,successful_article_endpoints:1,failed_checks:0,new_unique_candidate_urls:0})]);
  const store=new RemoteQualityStore(async name=>name==='get_source'?s:a);
  assert.equal((await store.source(id,date)).endpoints[0].classification,'recovered_after_failure');
  a=activity([day(date,{targeted_endpoints:1,successful_article_endpoints:1,failed_checks:0,new_unique_candidate_urls:0})]);
  assert.equal((await store.source(id,date)).endpoints[0].classification,'successful_no_new_discoveries');
  a=activity([day(date,{targeted_endpoints:1,successful_article_endpoints:1,failed_checks:1,new_unique_candidate_urls:0})]);
  assert.equal((await store.source(id,date)).endpoints[0].classification,'insufficient_endpoint_history');
  s.endpoints.push({id:`ep_${'c'.repeat(24)}`,type:'sitemap',url:'https://news.example/map.xml',health:{checked_at:null}});
  a=activity([day(date,{successful_article_endpoints:0,failed_checks:1})]);
  assert.ok((await store.source(id,date)).endpoints.every(endpoint=>endpoint.classification==='insufficient_endpoint_history'));
});

test('dated stale health is saved evidence and future health dates cannot justify a classification', async () => {
  const s=source(); s.endpoints[0].health={checked_at:'2026-10-11T00:00:00.000Z',newest_content_at:'2026-08-08T00:00:00.000Z',content_freshness:'stale'};
  const store=new RemoteQualityStore(async name=>name==='get_source'?s:activity([day(date,{targeted_endpoints:1,successful_article_endpoints:1,failed_checks:0})]));
  const got=await store.source(id,date); assert.equal(got.endpoints[0].classification,'stale_content_evidence');
  assert.equal(got.endpoints[0].content_evidence_is_current_collection,false); assert.equal(got.endpoints[0].evidence.current_live_state_verified,false);
  s.endpoints[0].health.checked_at='2099-01-01T00:00:00.000Z';
  const future=await store.source(id,date); assert.notEqual(future.endpoints[0].classification,'stale_content_evidence');
  assert.equal(future.endpoints[0].health.checked_at,null); assert.equal(future.endpoints[0].health.evidence_is_future,true);
});

test('country source list is bounded at 500 and explicitly partial; invalid requests make no network calls', async () => {
  let calls=0;
  const store=new RemoteQualityStore(async(name,args)=>{
    calls++;
    if(name==='get_country_source_inventory') return {items:[inventory()],total:1,next_offset:null};
    if(name==='get_country_article_activity') return activity([day(date)]);
    return {items:Array.from({length:50},(_,index)=>({...source(),id:`${args.offset+index}`})),total:600,next_offset:args.offset+50};
  });
  const got=await store.country('US',date); assert.equal(got.sources.length,500); assert.equal(got.source_list_state,'partial'); assert.equal(got.source_total,600);
  assert.equal(calls,12);
  await assert.rejects(()=>store.source('bad',date),/Invalid source_id/); await assert.rejects(()=>store.overview('2026-02-30'),/Invalid/);
  await assert.rejects(()=>store.country('../../',date),/Invalid country/); assert.equal(calls,12);
  await assert.rejects(()=>readRemoteNewsTool('update_source',{}),/Unsupported remote/);
});

test('read-only calls share one lazy handshake and reconnect only after a failed read', async () => {
  let created = 0, connected = 0, closed = 0, calls = 0, fail = false;
  const reader = createRemoteNewsReader(() => {
    created++;
    return { connect: async (_transport, options) => { connected++; assert.equal(options.timeout, 15000); await new Promise(resolve => setTimeout(resolve, 2)); },
      close: async () => { closed++; }, callTool: async (params, options) => { calls++; assert.equal(options.timeout, 15000); assert.ok(options.signal instanceof AbortSignal);
        if (fail) { fail = false; throw Error('SESSION_DISCONNECTED'); } return { content: [], structuredContent: { tool: params.name } }; } };
  });
  assert.equal(created, 0);
  const result = await Promise.all([reader('list_countries', {}), reader('search_sources', {}), reader('get_country_source_inventory', {})]);
  assert.equal(result.length, 3); assert.equal(created, 1); assert.equal(connected, 1); assert.equal(calls, 3); assert.equal(closed, 0);
  await assert.rejects(() => reader('delete_source', {}), /Unsupported/); assert.equal(calls, 3); assert.equal(created, 1);
  fail = true; await assert.rejects(() => reader('list_countries', {}), /SESSION_DISCONNECTED/);
  assert.equal(closed, 1); await reader('list_countries', {}); assert.equal(created, 2); assert.equal(connected, 2);
  await reader.close(); assert.equal(closed, 2);
});

test('global overview deadline returns saved successes and truthful partial rows without querying remaining countries', async () => {
  let activityCalls = 0, canceled = 0;
  const store = new RemoteQualityStore(async (name, args, signal) => {
    if (name === 'get_country_source_inventory') return { items: Array.from({ length: 9 }, (_, i) => inventory(`C${i}`)), total: 9, next_offset: null };
    activityCalls++;
    if (args.country === 'C0') return activity([day(date)]);
    return new Promise((_, reject) => { signal.addEventListener('abort', () => { canceled++; reject(Error('READ_ABORTED')); }, { once: true }); });
  }, { overviewTimeoutMs: 40 });
  const started = Date.now();
  // AbortSignal.timeout is intentionally unref'ed by Node; the test's waiting timer keeps this artificial transport alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await store.overview(date); assert.ok(Date.now() - started < 200);
    assert.equal(result.items.length, 9); assert.equal(result.runtime.overview_timed_out, true); assert.equal(result.runtime.unqueried_country_count, 4);
    assert.equal(activityCalls, 5); assert.equal(canceled, 4); assert.equal(result.common_collector_signal.checked_country_count, 1);
    assert.equal(result.common_collector_signal.assessment_scope, 'bounded_country_sample');
    assert.equal(result.items[0].metrics.success_rate.value, 75);
    for (const row of result.items.slice(1)) { assert.equal(row.period.state, 'lookup_failed'); assert.equal(row.metrics.success_rate.value, null); assert.equal(row.metrics.attempt_coverage.value, null); assert.equal(row.lookup_error, 'REMOTE_QUALITY_OVERVIEW_DEADLINE'); }
  } finally { clearTimeout(keepAlive); }
});

test('reader cancellation ends waiting promptly, disposes the old client, and permits the next read', async () => {
  let created = 0, closed = 0;
  const reader = createRemoteNewsReader(() => {
    const which = ++created;
    return { connect: async () => {}, close: async () => { closed++; }, callTool: async (_params, options) => which === 1
      ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('REQUEST_ABORTED')), { once: true }))
      : { content: [], structuredContent: { ok: true } } };
  });
  const controller = new AbortController(), waiting = reader('list_countries', {}, controller.signal);
  setTimeout(() => controller.abort(Error('OVERVIEW_DEADLINE')), 10);
  await assert.rejects(() => waiting, /OVERVIEW_DEADLINE/); assert.equal(closed, 1);
  assert.equal((await reader('list_countries', {})).ok, true); assert.equal(created, 2); await reader.close();
});
