import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepairWorkflowStore, officialDeclarations } from '../dist/repair-workflow.js';
import { normalizeRegistry } from '../dist/catalog.js';

const principal = { actor_id: 'operator', session_id: 'verified-session' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function feed(date = '2026-10-13T11:30:00Z') {
  return Buffer.from(`<rss version="2.0"><channel><title>News</title><link>https://publisher.example</link><description>Publisher</description><item><link>https://publisher.example/articles/one</link><pubDate>${date}</pubDate></item></channel></rss>`);
}
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'news-quality-repair-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registryPath = join(root, 'registry.json');
  const registry = { countries: [{ code: 'KR', name: 'Korea', feeds: [
    { name: 'Publisher', url: 'https://publisher.example/old.xml', row: 1, registry_added_at: '2026-01-01T00:00:00Z' },
    { name: 'Publisher', url: 'https://publisher.example/old.xml', row: 2, registry_added_at: '2026-01-01T00:00:00Z' },
  ] }] };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  const source = normalizeRegistry(registry).sources[0];
  const state = { now: new Date('2026-10-13T12:00:00Z'), calls: [], collector: null,
    responses: new Map([
      ['https://publisher.example/', { status: 200, body: Buffer.from('<html><link rel="alternate" type="application/rss+xml" href="/new.xml"></html>'), finalUrl: 'https://publisher.example/' }],
      ['https://publisher.example/robots.txt', { status: 200, body: Buffer.from('Sitemap: https://publisher.example/sitemap.xml'), finalUrl: 'https://publisher.example/robots.txt' }],
      ['https://publisher.example/new.xml', { status: 200, body: feed(), finalUrl: 'https://publisher.example/new.xml' }],
    ]) };
  const settings = { directory: join(root, 'workflow'), registryPath, allowedRegistryRoot: root,
    authorizeMutation: actor => actor.actor_id === principal.actor_id && actor.session_id === principal.session_id,
    now: () => state.now,
    fetchDocument: async (url, timeoutMs, maxBytes) => {
      state.calls.push({ url, timeoutMs, maxBytes });
      const response = state.responses.get(url); if (!response) throw Error('UNEXPECTED_NETWORK_REQUEST'); return response;
    },
    readCollectorEvidence: async () => state.collector,
    ...options,
  };
  const store = new RepairWorkflowStore(settings);
  const request = { source_id: source.id, endpoint_id: source.endpoints[0].id, official_url: 'https://publisher.example/' };
  return { root, registryPath, source, state, store, settings, request };
}
function approvalRequest(proposal, action = 'apply') {
  return { proposal_id: proposal.content.proposal_id, proposal_digest: proposal.proposal_digest,
    expected_registry_hash: action === 'apply' ? proposal.content.registry_hash : proposal.applied_registry_hash, action };
}
function applyRequest(proposal, approval) {
  return { proposal_id: proposal.content.proposal_id, approval_id: approval.approval_id, expected_registry_hash: approval.registry_hash };
}
async function appliedFixture(t) {
  const f = fixture(t);
  const { proposal } = await f.store.discover(f.request);
  const { approval } = f.store.approve(approvalRequest(proposal), principal);
  const result = f.store.apply(applyRequest(proposal, approval), principal);
  return { ...f, proposal: result.proposal, approval };
}

test('official discovery uses bounded explicit declarations, ignores scripts and private addresses', () => {
  const html = Buffer.from(`<html><script>const fake='<link rel="alternate" type="application/rss+xml" href="https://evil.example/feed">'</script>
    <!-- <link rel="alternate" type="application/rss+xml" href="https://comment.example/feed"> -->
    <link rel="alternate" type="application/rss+xml" href="/rss.xml?a=1&amp;b=2">
    <link rel="alternate" type="application/atom+xml" href="http://127.0.0.1/feed">
    <a href="/guessed-feed">RSS</a></html>`);
  const result = officialDeclarations(html, 'https://publisher.example/', 'html');
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://publisher.example/rss.xml?a=1&b=2');
  assert.equal(result[0].document_sha256, digest(html));
  assert.equal(result[0].declaration, 'html_feed_link');
  assert.deepEqual(officialDeclarations(Buffer.from('User-agent: *\nSitemap: http://169.254.169.254/map\nSitemap: https://maps.publisher.example/map.xml\nDisallow: /'), 'https://publisher.example/robots.txt', 'robots').map(item => item.url),
    ['https://maps.publisher.example/map.xml']);
});

test('discovery records provenance and actual XML/date evidence without modifying registry', async t => {
  const f = fixture(t), original = readFileSync(f.registryPath);
  const result = await f.store.discover(f.request);
  assert.equal(result.state, 'proposal_ready');
  assert.equal(result.official_website_confirmed, false);
  assert.equal(result.proposal.content.affected_registration_rows, 2);
  assert.equal(result.proposal.content.old_url, 'https://publisher.example/old.xml');
  assert.equal(result.proposal.content.new_url, 'https://publisher.example/new.xml');
  assert.equal(result.proposal.content.candidate.validation.entries_with_url, 1);
  assert.equal(result.proposal.content.candidate.validation.content_freshness, 'recent');
  assert.deepEqual(readFileSync(f.registryPath), original);
  assert.equal(f.state.calls.length, 3);
  assert.ok(f.state.calls.every(call => call.timeoutMs === 8000 && call.maxBytes <= 2 * 1024 * 1024));
  const reloaded = new RepairWorkflowStore(f.settings);
  assert.deepEqual(reloaded.get(result.proposal.content.proposal_id), result.proposal);
  assert.equal(reloaded.list().total, 1);
});

test('official and candidate cross-host redirects do not become approved replacements', async t => {
  const f = fixture(t);
  f.state.responses.set('https://publisher.example/', { status: 200, body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="/new.xml">'), finalUrl: 'https://unrelated.example/' });
  let result = await f.store.discover(f.request);
  assert.equal(result.proposal, null);
  assert.equal(result.documents[0].reason, 'OFFICIAL_REDIRECT_NOT_ALLOWED');
  assert.equal(f.state.calls.length, 2);
  f.state.responses.set('https://publisher.example/', { status: 200, body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="/new.xml">'), finalUrl: 'https://publisher.example/' });
  f.state.responses.set('https://publisher.example/new.xml', { status: 200, body: feed(), finalUrl: 'https://unrelated.example/feed' });
  result = await f.store.discover(f.request);
  assert.equal(result.proposal, null);
  assert.equal(result.candidates[0].validation.reason, 'CANDIDATE_REDIRECT_NOT_DECLARED');
  await assert.rejects(f.store.discover({ ...f.request, candidate_url: 'https://unrelated.example/guessed' }), /WORKFLOW_CANDIDATE_NOT_OFFICIALLY_DECLARED/);
});

test('publisher-declared cross-host endpoint is allowed but empty, malformed and stale candidates stay unapproved', async t => {
  const f = fixture(t);
  f.state.responses.set('https://publisher.example/', { status: 200, body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="https://rss.publisher.example/new.xml">'), finalUrl: 'https://publisher.example/' });
  f.state.responses.set('https://rss.publisher.example/new.xml', { status: 200, body: feed(), finalUrl: 'https://rss.publisher.example/new.xml' });
  const declared = await f.store.discover(f.request);
  assert.equal(declared.proposal.content.new_url, 'https://rss.publisher.example/new.xml');
  for (const body of [Buffer.from('<rss><channel><title>News</title><link>https://publisher.example</link><description>Empty</description></channel></rss>'),
    Buffer.from('<html>200 but no feed</html>'), feed('2026-08-01T00:00:00Z')]) {
    f.state.responses.set('https://rss.publisher.example/new.xml', { status: 200, body, finalUrl: 'https://rss.publisher.example/new.xml' });
    assert.equal((await f.store.discover(f.request)).proposal, null);
  }
});

test('exact authenticated approval is necessary and approval cannot be transferred between sessions', async t => {
  const f = fixture(t), { proposal } = await f.store.discover(f.request);
  const unauthenticated = new RepairWorkflowStore({ ...f.settings, authorizeMutation: undefined });
  assert.throws(() => unauthenticated.approve(approvalRequest(proposal), principal), /WORKFLOW_AUTH_REQUIRED/);
  assert.throws(() => f.store.approve({ ...approvalRequest(proposal), proposal_digest: 'b'.repeat(64) }, principal), /WORKFLOW_PROPOSAL_CHANGED/);
  assert.throws(() => f.store.apply({ proposal_id: proposal.content.proposal_id, approval_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expected_registry_hash: proposal.content.registry_hash }, principal), /WORKFLOW_EXACT_APPROVAL_REQUIRED/);
  const { approval } = f.store.approve(approvalRequest(proposal), principal);
  const permissiveStore = new RepairWorkflowStore({ ...f.settings, authorizeMutation: () => true });
  assert.throws(() => permissiveStore.apply(applyRequest(proposal, approval), { ...principal, session_id: 'different-verified-session' }), /WORKFLOW_EXACT_APPROVAL_REQUIRED/);
  assert.equal(f.store.get(proposal.content.proposal_id).state, 'approved');
});

test('registry compare-and-swap and validation expiration prevent stale approved changes', async t => {
  const f = fixture(t), { proposal } = await f.store.discover(f.request);
  const { approval } = f.store.approve(approvalRequest(proposal), principal);
  writeFileSync(f.registryPath, readFileSync(f.registryPath, 'utf8') + '\n');
  const externallyChanged = readFileSync(f.registryPath);
  assert.throws(() => f.store.apply(applyRequest(proposal, approval), principal), /WORKFLOW_REGISTRY_CHANGED/);
  assert.deepEqual(readFileSync(f.registryPath), externallyChanged);
  const expired = fixture(t), discovery = await expired.store.discover(expired.request);
  const consent = expired.store.approve(approvalRequest(discovery.proposal), principal);
  expired.state.now = new Date('2026-10-15T12:00:00Z');
  assert.throws(() => expired.store.apply(applyRequest(discovery.proposal, consent.approval), principal), /WORKFLOW_VALIDATION_EXPIRED/);
});

test('approved transaction replaces all duplicate rows and separate rollback consent restores exact bytes', async t => {
  const f = fixture(t), original = readFileSync(f.registryPath), { proposal } = await f.store.discover(f.request);
  const { approval } = f.store.approve(approvalRequest(proposal), principal);
  const result = f.store.apply(applyRequest(proposal, approval), principal);
  const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
  assert.ok(registry.countries[0].feeds.every(row => row.url === proposal.content.new_url));
  assert.ok(registry.countries[0].feeds.every(row => row.registry_added_at === '2026-01-01T00:00:00Z'));
  assert.equal(result.deployed, false);
  assert.equal(result.registry_reload_required, true);
  assert.equal(result.proposal.applied_registry_hash, digest(readFileSync(f.registryPath)));
  assert.throws(() => f.store.apply(applyRequest(proposal, approval), principal), /WORKFLOW_ALREADY_APPLIED/);
  assert.throws(() => f.store.rollback({ ...applyRequest(proposal, approval), expected_registry_hash: result.proposal.applied_registry_hash }, principal), /WORKFLOW_EXACT_APPROVAL_REQUIRED/);
  const rollback = f.store.approve(approvalRequest(result.proposal, 'rollback'), principal);
  assert.equal(f.store.rollback(applyRequest(result.proposal, rollback.approval), principal).proposal.state, 'rolled_back');
  assert.deepEqual(readFileSync(f.registryPath), original);
});

test('recovery requires successful non-baseline collector and content renewed after application', async t => {
  const f = await appliedFixture(t);
  let check = await f.store.verify(f.proposal.content.proposal_id);
  assert.equal(check.recovery.status, 'validation_passed_waiting_for_collector');
  assert.equal(check.state, 'applied');
  f.state.now = new Date('2026-10-13T13:00:00Z');
  f.state.collector = { run_id: 'collector-1', completed_at: '2026-10-13T12:30:00Z', successful: true, baseline: true,
    first_discovered_urls: 1, newest_content_at: '2026-10-13T12:15:00Z' };
  assert.equal((await f.store.verify(f.proposal.content.proposal_id)).recovery.status, 'validation_passed_waiting_for_collector');
  f.state.collector.baseline = false;
  assert.equal((await f.store.verify(f.proposal.content.proposal_id)).recovery.status, 'collector_success_confirmed');
  f.state.responses.set('https://publisher.example/new.xml', { status: 200, body: feed('2026-10-13T12:15:00Z'), finalUrl: 'https://publisher.example/new.xml' });
  f.state.collector.first_discovered_urls = 0;
  check = await f.store.verify(f.proposal.content.proposal_id);
  assert.equal(check.recovery.status, 'recovered');
  assert.equal(check.state, 'recovered');
  assert.equal(check.recovery.collector.first_discovered_urls, 0);
  f.state.responses.set('https://publisher.example/new.xml', { status: 429, body: Buffer.alloc(0), finalUrl: 'https://publisher.example/new.xml' });
  check = await f.store.verify(f.proposal.content.proposal_id);
  assert.equal(check.recovery.status, 'still_failing');
  assert.equal(check.state, 'applied');
});

test('sitemap discovery uses robots declarations and rejects index-only replacement', async t => {
  const f = fixture(t);
  const raw = JSON.parse(readFileSync(f.registryPath, 'utf8'));
  raw.countries[0].feeds = [{ name: 'Publisher', sitemapUrl: 'https://publisher.example/old-map.xml' }];
  writeFileSync(f.registryPath, JSON.stringify(raw) + '\n');
  const source = normalizeRegistry(raw).sources[0];
  const request = { ...f.request, source_id: source.id, endpoint_id: source.endpoints[0].id };
  f.state.responses.set('https://publisher.example/sitemap.xml', { status: 200, finalUrl: 'https://publisher.example/sitemap.xml',
    body: Buffer.from('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://publisher.example/child.xml</loc></sitemap></sitemapindex>') });
  assert.equal((await f.store.discover(request)).proposal, null);
  assert.ok(!f.state.calls.some(call => call.url.includes('child.xml')));
  f.state.responses.set('https://publisher.example/sitemap.xml', { status: 200, finalUrl: 'https://publisher.example/sitemap.xml',
    body: Buffer.from('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://publisher.example/article</loc><lastmod>2026-10-13T11:30:00Z</lastmod></url></urlset>') });
  const discovered = await f.store.discover(request);
  assert.equal(discovered.proposal.content.endpoint_type, 'sitemap');
  assert.equal(discovered.proposal.content.candidate.declaration, 'robots_sitemap');
});

test('paths outside allowed checkout, symlinks and tampered proposal contents fail closed', async t => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'news-quality-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => new RepairWorkflowStore({ ...f.settings, directory: join(outside, 'state') }), /WORKFLOW_PATH_OUTSIDE_APPROVED_ROOT/);
  const link = join(f.root, 'link.json'); symlinkSync(f.registryPath, link);
  assert.throws(() => new RepairWorkflowStore({ ...f.settings, registryPath: link }), /WORKFLOW_SYMLINK_NOT_ALLOWED/);
  const { proposal } = await f.store.discover(f.request);
  const path = join(f.settings.directory, `${proposal.content.proposal_id}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8')); record.content.new_url = 'https://unapproved.example/feed';
  writeFileSync(path, JSON.stringify(record));
  assert.throws(() => f.store.get(proposal.content.proposal_id), /WORKFLOW_RECORD_INTEGRITY_FAILED/);
});

test('durable interrupted swap journal restores applied audit state without applying twice', async t => {
  const f = fixture(t), { proposal } = await f.store.discover(f.request);
  const consent = f.store.approve(approvalRequest(proposal), principal);
  const recordPath = join(f.settings.directory, `${proposal.content.proposal_id}.json`);
  const approvedRecord = readFileSync(recordPath);
  const result = f.store.apply(applyRequest(proposal, consent.approval), principal);
  const appliedBytes = readFileSync(f.registryPath);
  // Simulate a process exit after the registry rename but before writing the committed proposal.
  writeFileSync(recordPath, approvedRecord);
  writeFileSync(join(f.settings.directory, `${proposal.content.proposal_id}.transaction.json`), JSON.stringify({ version: 1,
    proposal_id: proposal.content.proposal_id, operation: 'apply', before: proposal.content.registry_hash,
    after: result.proposal.applied_registry_hash, at: result.proposal.applied_at, approval_id: consent.approval.approval_id, ...principal }));
  const restarted = new RepairWorkflowStore(f.settings), recovered = restarted.get(proposal.content.proposal_id);
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.audit.at(-1).action, 'interrupted_transaction_reconciled');
  assert.deepEqual(readFileSync(f.registryPath), appliedBytes);
  assert.throws(() => restarted.apply(applyRequest(proposal, consent.approval), principal), /WORKFLOW_ALREADY_APPLIED/);
});

test('a live mutation lock blocks approval and an exited owner lock can be safely resumed', async t => {
  const f = fixture(t), { proposal } = await f.store.discover(f.request);
  const lock = join(f.settings.directory, '.mutation.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => f.store.approve(approvalRequest(proposal), principal), /WORKFLOW_BUSY/);
  assert.equal(f.store.get(proposal.content.proposal_id).state, 'proposed');
  writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
  assert.equal(f.store.approve(approvalRequest(proposal), principal).proposal.state, 'approved');
});

test('a failed chosen candidate is not silently replaced by another candidate', async t => {
  const f = fixture(t);
  f.state.responses.set('https://publisher.example/', { status: 200, finalUrl: 'https://publisher.example/',
    body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="/broken.xml"><link rel="alternate" type="application/rss+xml" href="/new.xml">') });
  f.state.responses.set('https://publisher.example/broken.xml', { status: 404, finalUrl: 'https://publisher.example/broken.xml', body: Buffer.alloc(0) });
  const result = await f.store.discover({ ...f.request, candidate_url: 'https://publisher.example/broken.xml' });
  assert.equal(result.proposal, null);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].validation.reason, 'HTTP_404');
  assert.equal(result.candidates[1].validation.status, 'valid');
});

test('replacement identity preserves other endpoint bindings when publisher names repeat', async t => {
  const f = fixture(t);
  const raw = JSON.parse(readFileSync(f.registryPath, 'utf8'));
  raw.countries[0].feeds = [
    { name: 'Publisher', url: 'https://publisher.example/old.xml', sitemapUrl: 'https://publisher.example/original-map.xml' },
    { name: 'Publisher', url: 'https://publisher.example/new.xml', sitemapUrl: 'https://publisher.example/other-map.xml' },
  ];
  writeFileSync(f.registryPath, JSON.stringify(raw) + '\n');
  const source = normalizeRegistry(raw).sources.find(item => item.endpoints.some(ep => ep.url.endsWith('/old.xml')));
  const request = { ...f.request, source_id: source.id, endpoint_id: source.endpoints.find(ep => ep.type === 'rss').id };
  const { proposal } = await f.store.discover(request);
  const { approval } = f.store.approve(approvalRequest(proposal), principal);
  f.store.apply(applyRequest(proposal, approval), principal);
  const next = normalizeRegistry(JSON.parse(readFileSync(f.registryPath, 'utf8')));
  const changedSource = next.sources.find(item => item.id === proposal.content.new_source_id);
  assert.equal(changedSource.endpoints.find(ep => ep.type === 'sitemap').url, 'https://publisher.example/original-map.xml');
  assert.equal(next.sources.length, 2);
});
