import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalUrl, normalizeRegistry, stableId, type Endpoint, type EndpointType } from './catalog.js';
import { inspectXml } from './inspect.js';
import { createHostGate } from './host-gate.js';
import { fetchXml, safeUrl } from './validate.js';

// This module is an operator workflow, never an automatic registry-writing MCP tool.
// Authenticated principals must come from the HTTP layer, not a JSON request body.
export type RepairPrincipal = { actor_id: string; session_id: string };
export type CollectorRecoveryEvidence = {
  run_id: string; completed_at: string; successful: boolean; baseline: boolean;
  first_discovered_urls: number | null; newest_content_at: string | null;
};
export type RepairFetch = (url: string, timeoutMs: number, maxBytes: number) => Promise<{ status: number; body: Buffer; finalUrl: string }>;
export type RepairWorkflowOptions = {
  directory: string; registryPath: string; allowedRegistryRoot: string;
  authorizeMutation?: (principal: RepairPrincipal) => boolean;
  fetchDocument?: RepairFetch; now?: () => Date;
  readCollectorEvidence?: (endpointId: string, sourceId: string, after: string) => Promise<CollectorRecoveryEvidence | null>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const objectHash = (value: unknown) => hash(JSON.stringify(value));
const idSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.string().regex(/^src_[a-f0-9]{24}$/);
const endpointIdSchema = z.string().regex(/^ep_[a-f0-9]{24}$/);
const urlSchema = z.string().max(2048);
const iso = z.string().datetime({ offset: true });
const declarationSchema = z.object({ url: urlSchema, type: z.enum(['rss', 'sitemap']), official_document_url: urlSchema,
  document_sha256: digestSchema, declaration: z.enum(['html_feed_link', 'robots_sitemap']) }).strict();
const validationSchema = z.object({ checked_at: iso, status: z.enum(['valid', 'invalid']), http_status: z.number().int().nullable(),
  final_url: urlSchema.nullable(), reason: z.string().max(80).nullable(), format: z.string().nullable(),
  entries_with_url: z.number().int().nonnegative().nullable(), newest_content_at: iso.nullable(),
  content_freshness: z.enum(['recent', 'stale', 'missing', 'unreliable']).nullable(), duration_ms: z.number().nonnegative() }).strict();
const candidateSchema = declarationSchema.extend({ endpoint_id: endpointIdSchema, validation: validationSchema }).strict();
export type RepairCandidate = z.infer<typeof candidateSchema>;
const contentSchema = z.object({ proposal_id: idSchema, created_at: iso, source_id: sourceIdSchema, source_name: z.string().max(512),
  country: z.string().max(8), endpoint_id: endpointIdSchema, endpoint_type: z.enum(['rss', 'sitemap']), old_url: urlSchema,
  new_url: urlSchema, new_endpoint_id: endpointIdSchema, new_source_id: sourceIdSchema, official_url: urlSchema,
  registry_hash: digestSchema, candidate: candidateSchema, affected_registration_rows: z.number().int().positive(),
  scope: z.literal('local_registry'), operation: z.literal('replace_endpoint') }).strict();
const auditSchema = z.object({ at: iso, action: z.string().max(80), actor_id: z.string().max(128).nullable(),
  session_id: z.string().max(128).nullable(), previous_hash: digestSchema.nullable(), event_hash: digestSchema,
  details: z.record(z.string(), z.unknown()) }).strict();
const approvalSchema = z.object({ approval_id: idSchema, proposal_digest: digestSchema, registry_hash: digestSchema,
  action: z.enum(['apply', 'rollback']), approved_at: iso, actor_id: z.string().max(128), session_id: z.string().max(128) }).strict();
const collectorSchema = z.object({ run_id: z.string().min(1).max(128), completed_at: iso, successful: z.boolean(), baseline: z.boolean(),
  first_discovered_urls: z.number().int().nonnegative().nullable(), newest_content_at: iso.nullable() }).strict();
const journalSchema = z.object({ version: z.literal(1), proposal_id: idSchema, operation: z.enum(['apply', 'rollback']),
  before: digestSchema, after: digestSchema, at: iso, approval_id: idSchema,
  actor_id: z.string().min(1).max(128), session_id: z.string().min(1).max(128) }).strict();
const recoverySchema = z.object({ checked_at: iso,
  status: z.enum(['candidate_only', 'still_failing', 'stale_content', 'valid_empty_pending', 'validation_passed_waiting_for_collector',
    'collector_success_confirmed', 'recovered', 'registry_changed', 'rolled_back']),
  validation: validationSchema.nullable(), collector: collectorSchema.nullable(),
  fresh_content_after_apply: z.boolean(), reason: z.string().max(256) }).strict();
const proposalSchema = z.object({ version: z.literal(1), content: contentSchema, proposal_digest: digestSchema,
  state: z.enum(['proposed', 'approved', 'applied', 'recovered', 'rolled_back']), approvals: z.array(approvalSchema).max(30),
  applied_at: iso.nullable(), applied_registry_hash: digestSchema.nullable(),
  recovery: recoverySchema.nullable(), audit: z.array(auditSchema).max(200) }).strict();
export type RepairProposal = z.infer<typeof proposalSchema>;
export const repairDiscoverySchema = z.object({ source_id: sourceIdSchema, endpoint_id: endpointIdSchema,
  official_url: urlSchema, candidate_url: urlSchema.optional() }).strict();
export const repairApprovalSchema = z.object({ proposal_id: idSchema, proposal_digest: digestSchema,
  expected_registry_hash: digestSchema, action: z.enum(['apply', 'rollback']).default('apply') }).strict();
export const repairApplySchema = z.object({ proposal_id: idSchema, approval_id: idSchema,
  expected_registry_hash: digestSchema }).strict();

function contained(path: string, root: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}
function assertNoSymlink(path: string, root: string) {
  if (!contained(resolve(path), resolve(root))) throw Error('WORKFLOW_PATH_OUTSIDE_APPROVED_ROOT');
  let current = resolve(path);
  while (contained(current, resolve(root))) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('WORKFLOW_SYMLINK_NOT_ALLOWED');
    if (current === resolve(root)) break;
    current = dirname(current);
  }
}
function atomicWrite(path: string, body: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function finiteReason(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^(HTTP_\d{3}|TIMEOUT|BODY_TOO_LARGE|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|UNSUPPORTED_ENCODING|DTD_NOT_ALLOWED|INVALID_XML|INVALID_ENTRY_URL|WRONG_ENDPOINT_FORMAT|OFFICIAL_REDIRECT_NOT_ALLOWED|CANDIDATE_REDIRECT_NOT_DECLARED)$/.test(message)
    ? message : 'NETWORK_OR_PARSE_ERROR';
}
function decodeHtml(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[a-f0-9]+);/gi, token => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const code = token.startsWith('&#x') || token.startsWith('&#X') ? parseInt(token.slice(3, -1), 16) : parseInt(token.slice(2, -1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function declarationUrl(value: string, base: string) {
  try { return safeUrl(new URL(decodeHtml(value.trim()), base).href).href; } catch { return null; }
}
// Only explicit machine-readable declarations count as official candidates. Page text,
// scripts, search results and guessed /feed paths never become repair evidence.
export function officialDeclarations(body: Buffer, documentUrl: string, kind: 'html' | 'robots') {
  if (body.length > 1024 * 1024) throw Error('BODY_TOO_LARGE');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const declarations: z.infer<typeof declarationSchema>[] = [];
  const add = (raw: string, type: EndpointType, declaration: 'html_feed_link' | 'robots_sitemap') => {
    const url = declarationUrl(raw, documentUrl);
    if (url && !declarations.some(item => item.url === url && item.type === type)) declarations.push({ url, type,
      official_document_url: documentUrl, document_sha256: hash(body), declaration });
  };
  if (kind === 'robots') {
    for (const line of text.split(/\r?\n/).slice(0, 10000)) {
      const match = /^\s*Sitemap\s*:\s*(\S+)\s*$/i.exec(line);
      if (match) add(match[1], 'sitemap', 'robots_sitemap');
    }
  } else {
    const inertStripped = text.replace(/<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    for (const match of inertStripped.matchAll(/<link\b[^>]{0,8192}>/gi)) {
      const attrs = new Map<string, string>();
      for (const attribute of match[0].matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
        attrs.set(attribute[1].toLowerCase(), decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4]));
      const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? [];
      const type = attrs.get('type')?.toLowerCase().split(';')[0].trim();
      if (rel.includes('alternate') && ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml'].includes(type ?? '') && attrs.get('href'))
        add(attrs.get('href')!, 'rss', 'html_feed_link');
      if (declarations.length >= 30) break;
    }
  }
  return declarations.slice(0, 30);
}

export class RepairWorkflowStore {
  private readonly directory: string;
  private readonly registryPath: string;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly fetchDocument: RepairFetch;
  private busyDiscovery = false;
  constructor(private readonly options: RepairWorkflowOptions) {
    this.root = realpathSync(options.allowedRegistryRoot);
    this.registryPath = resolve(options.registryPath);
    this.directory = resolve(options.directory);
    assertNoSymlink(this.registryPath, this.root);
    assertNoSymlink(this.directory, this.root);
    if (!contained(realpathSync(dirname(this.registryPath)), this.root)) throw Error('WORKFLOW_PATH_OUTSIDE_APPROVED_ROOT');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.now = options.now ?? (() => new Date());
    const gate = createHostGate(1500);
    this.fetchDocument = options.fetchDocument ?? ((url, timeout, bytes) => fetchXml(url, timeout, bytes, gate));
    this.readRegistry();
    this.reconcileTransactions();
  }
  private readRegistry() {
    assertNoSymlink(this.registryPath, this.root);
    const stat = lstatSync(this.registryPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error('WORKFLOW_INVALID_REGISTRY_FILE');
    const bytes = readFileSync(this.registryPath);
    const registry: unknown = JSON.parse(bytes.toString('utf8'));
    const catalog = normalizeRegistry(registry);
    return { registry, catalog, bytes, registryHash: hash(bytes) };
  }
  registryHash() { return this.readRegistry().registryHash; }
  private path(id: string) { idSchema.parse(id); return resolve(this.directory, `${id}.json`); }
  private authorize(principal: RepairPrincipal) {
    if (!principal || !/^[^\u0000-\u001f]{1,128}$/.test(principal.actor_id) || !/^[^\u0000-\u001f]{1,128}$/.test(principal.session_id) ||
      !this.options.authorizeMutation?.(principal)) throw Error('WORKFLOW_AUTH_REQUIRED');
  }
  private lock<T>(operation: () => T): T {
    assertNoSymlink(this.directory, this.root);
    const path = resolve(this.directory, '.mutation.lock');
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); } catch {
      assertNoSymlink(path, this.root);
      let owner: number;
      try {
        if (lstatSync(path).size > 256) throw Error();
        const lock = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
        if (!Number.isInteger(lock.pid) || (lock.pid as number) < 1) throw Error();
        owner = lock.pid as number;
      } catch { throw Error('WORKFLOW_BUSY'); }
      try { process.kill(owner, 0); throw Error('WORKFLOW_BUSY'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw Error('WORKFLOW_BUSY');
      }
      rmSync(path);
      try { fd = openSync(path, 'wx', 0o600); } catch { throw Error('WORKFLOW_BUSY'); }
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: this.now().toISOString() })); fsyncSync(fd);
    try { return operation(); } finally { closeSync(fd); rmSync(path, { force: true }); }
  }
  private audit(proposal: RepairProposal, action: string, principal: RepairPrincipal | null, details: Record<string, unknown>) {
    if (proposal.audit.length >= 200) throw Error('WORKFLOW_AUDIT_LIMIT');
    const event = { at: this.now().toISOString(), action, actor_id: principal?.actor_id ?? null,
      session_id: principal?.session_id ?? null, previous_hash: proposal.audit.at(-1)?.event_hash ?? null, details };
    proposal.audit.push({ ...event, event_hash: objectHash(event) });
  }
  private save(proposal: RepairProposal) {
    proposalSchema.parse(proposal);
    const path = this.path(proposal.content.proposal_id);
    assertNoSymlink(path, this.root);
    atomicWrite(path, JSON.stringify(proposal, null, 2) + '\n');
  }
  get(id: string): RepairProposal | null {
    const path = this.path(id); assertNoSymlink(path, this.root);
    if (!existsSync(path)) return null;
    if (lstatSync(path).size > 256 * 1024) throw Error('WORKFLOW_INVALID_RECORD');
    const proposal = proposalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (proposal.content.proposal_id !== id || objectHash(proposal.content) !== proposal.proposal_digest) throw Error('WORKFLOW_RECORD_INTEGRITY_FAILED');
    let prior: string | null = null;
    for (const event of proposal.audit) {
      const { event_hash, ...fields } = event;
      if (fields.previous_hash !== prior || objectHash(fields) !== event_hash) throw Error('WORKFLOW_RECORD_INTEGRITY_FAILED');
      prior = event_hash;
    }
    return structuredClone(proposal);
  }
  list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('WORKFLOW_INVALID_LIMIT');
    const names = readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    if (names.length > 5000) throw Error('WORKFLOW_RECORD_LIMIT');
    const records = names.map(name => this.required(name.slice(0, -5))).sort((a, b) => b.content.created_at.localeCompare(a.content.created_at));
    return { items: records.slice(0, limit), total: records.length, registry_hash: this.registryHash() };
  }
  // A durable journal distinguishes a completed file swap from an uncommitted proposal
  // after a process interruption. It never blindly overwrites a drifted registry.
  private reconcileTransactions() {
    const names = readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.transaction\.json$/.test(name));
    if (names.length > 100) throw Error('WORKFLOW_PENDING_TRANSACTION_LIMIT');
    if (!names.length) return;
    this.lock(() => {
      for (const name of names) {
        const path = resolve(this.directory, name); assertNoSymlink(path, this.root);
        if (lstatSync(path).size > 8192) throw Error('WORKFLOW_INVALID_TRANSACTION');
        const journal = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        if (name !== `${journal.proposal_id}.transaction.json`) throw Error('WORKFLOW_INVALID_TRANSACTION');
        const proposal = this.required(journal.proposal_id);
        const approval = proposal.approvals.find(item => item.approval_id === journal.approval_id && item.action === journal.operation &&
          item.actor_id === journal.actor_id && item.session_id === journal.session_id && item.proposal_digest === proposal.proposal_digest);
        if (!approval || approval.registry_hash !== journal.before) throw Error('WORKFLOW_INVALID_TRANSACTION');
        const current = this.readRegistry().registryHash;
        if (current !== journal.before && current !== journal.after) throw Error('WORKFLOW_INTERRUPTED_TRANSACTION_REQUIRES_REVIEW');
        if (current === journal.after) {
          if (journal.operation === 'apply') {
            if (journal.before !== proposal.content.registry_hash) throw Error('WORKFLOW_INVALID_TRANSACTION');
            proposal.state = 'applied'; proposal.applied_at = journal.at; proposal.applied_registry_hash = journal.after;
          } else {
            if (journal.after !== proposal.content.registry_hash) throw Error('WORKFLOW_INVALID_TRANSACTION');
            proposal.state = 'rolled_back';
          }
          this.audit(proposal, 'interrupted_transaction_reconciled', { actor_id: journal.actor_id, session_id: journal.session_id },
            { operation: journal.operation, approval_id: journal.approval_id, before: journal.before, after: journal.after });
          this.save(proposal);
        }
        rmSync(path);
      }
    });
  }
  private required(id: string) {
    const record = this.get(id); if (!record) throw Error('WORKFLOW_PROPOSAL_NOT_FOUND'); return record;
  }
  private async validateCandidate(candidate: z.infer<typeof declarationSchema>): Promise<RepairCandidate> {
    const started = Date.now();
    let status: number | null = null; let final: string | null = null;
    try {
      const response = await this.fetchDocument(candidate.url, 8000, 2 * 1024 * 1024);
      status = response.status; final = safeUrl(response.finalUrl).href;
      // Publisher-declared cross-host feeds are allowed. Undeclared cross-host redirects
      // remain candidates for human investigation, never an approved replacement.
      if (new URL(final).hostname !== new URL(candidate.url).hostname) throw Error('CANDIDATE_REDIRECT_NOT_DECLARED');
      if (status < 200 || status >= 300) throw Error(`HTTP_${status}`);
      const summary = inspectXml(response.body, candidate.type, this.now().getTime());
      return { ...candidate, endpoint_id: stableId('ep', [candidate.type, candidate.url]), validation: {
        checked_at: this.now().toISOString(), status: 'valid', http_status: status, final_url: final, reason: null,
        format: summary.format, entries_with_url: summary.entriesWithUrl, newest_content_at: summary.newestContentAt,
        content_freshness: summary.contentFreshness, duration_ms: Date.now() - started } };
    } catch (error) {
      return { ...candidate, endpoint_id: stableId('ep', [candidate.type, candidate.url]), validation: {
        checked_at: this.now().toISOString(), status: 'invalid', http_status: status, final_url: final, reason: finiteReason(error),
        format: null, entries_with_url: null, newest_content_at: null, content_freshness: null, duration_ms: Date.now() - started } };
    }
  }
  async discover(raw: unknown) {
    const input = repairDiscoverySchema.parse(raw);
    if (this.busyDiscovery) throw Error('WORKFLOW_DISCOVERY_BUSY');
    this.busyDiscovery = true;
    try {
      const initial = this.readRegistry();
      const source = initial.catalog.sources.find(item => item.id === input.source_id);
      const endpoint = source?.endpoints.find(item => item.id === input.endpoint_id);
      if (!source || !endpoint) throw Error('WORKFLOW_SOURCE_ENDPOINT_NOT_FOUND');
      if (!source.enabled) throw Error('WORKFLOW_SOURCE_DISABLED');
      const official = safeUrl(input.official_url).href;
      const officialHost = new URL(official).hostname;
      const declarations: z.infer<typeof declarationSchema>[] = [];
      const documents: { url: string; status: number | null; reason: string | null }[] = [];
      // Exactly two primary documents at most. No search engine, article or sitemap-child crawl.
      for (const [url, kind] of [[official, 'html'], [new URL('/robots.txt', official).href, 'robots']] as const) {
        let status: number | null = null;
        try {
          const response = await this.fetchDocument(url, 8000, 1024 * 1024); status = response.status;
          const final = safeUrl(response.finalUrl).href;
          if (new URL(final).hostname !== officialHost) throw Error('OFFICIAL_REDIRECT_NOT_ALLOWED');
          if (status < 200 || status >= 300) throw Error(`HTTP_${status}`);
          declarations.push(...officialDeclarations(response.body, final, kind));
          documents.push({ url, status, reason: null });
        } catch (error) { documents.push({ url, status, reason: finiteReason(error) }); }
      }
      const deduplicated = [...new Map(declarations.filter(item => item.type === endpoint.type && item.url !== endpoint.url)
        .map(item => [`${item.type}:${item.url}`, item])).values()];
      const requestedCandidate = input.candidate_url ? canonicalUrl(input.candidate_url) : null;
      if (requestedCandidate && !deduplicated.some(item => item.url === requestedCandidate)) throw Error('WORKFLOW_CANDIDATE_NOT_OFFICIALLY_DECLARED');
      // A requested candidate is checked first. The bounded list remains transparent.
      deduplicated.sort((a, b) => Number(b.url === requestedCandidate) - Number(a.url === requestedCandidate));
      const candidates: RepairCandidate[] = [];
      for (const declaration of deduplicated.slice(0, 5)) candidates.push(await this.validateCandidate(declaration));
      const eligible = candidates.filter(item => (!requestedCandidate || item.url === requestedCandidate) && item.validation.status === 'valid' && (item.validation.entries_with_url ?? 0) > 0 &&
        item.validation.format !== 'sitemapindex' && item.validation.content_freshness !== 'stale' && item.validation.content_freshness !== 'unreliable');
      eligible.sort((a, b) => Number(b.url === requestedCandidate) - Number(a.url === requestedCandidate) ||
        Number(b.validation.content_freshness === 'recent') - Number(a.validation.content_freshness === 'recent'));
      const selected = eligible[0];
      if (!selected) return { proposal: null, candidates, documents, state: 'no_verified_alternative' as const,
        checked_at: this.now().toISOString(), official_website_confirmed: false,
        semantics: 'The selected website must be confirmed by the operator as the publisher official website. Declarations are not proof of ownership. HTTP/XML validation does not establish collector recovery.' };
      const nextRegistry = this.replace(initial.registry, source.id, endpoint, selected.url);
      const expectedNewSourceId = stableId('src', [source.countryCode, source.name.normalize('NFKC').toLowerCase(),
        ...source.endpoints.map(item => item.id === endpoint.id ? selected.endpoint_id : item.id).sort()]);
      const newSource = normalizeRegistry(nextRegistry).sources.find(item => item.id === expectedNewSourceId);
      if (!newSource) throw Error('WORKFLOW_REPLACEMENT_IDENTITY_FAILED');
      const content = contentSchema.parse({ proposal_id: randomUUID(), created_at: this.now().toISOString(), source_id: source.id,
        source_name: source.name, country: source.countryCode, endpoint_id: endpoint.id, endpoint_type: endpoint.type,
        old_url: endpoint.url, new_url: selected.url, new_endpoint_id: selected.endpoint_id, new_source_id: newSource.id,
        official_url: official, registry_hash: initial.registryHash, candidate: selected,
        affected_registration_rows: source.registrationCount, scope: 'local_registry', operation: 'replace_endpoint' });
      const proposal: RepairProposal = { version: 1, content, proposal_digest: objectHash(content), state: 'proposed',
        approvals: [], applied_at: null, applied_registry_hash: null, recovery: null, audit: [] };
      this.audit(proposal, 'proposal_created', null, { official_website_confirmation_required: true,
        request_count: documents.length + candidates.length, omitted_candidate_count: Math.max(0, deduplicated.length - candidates.length) });
      this.lock(() => {
        if (this.readRegistry().registryHash !== initial.registryHash) throw Error('WORKFLOW_REGISTRY_CHANGED');
        this.save(proposal);
      });
      return { proposal, candidates, documents, state: 'proposal_ready' as const, official_website_confirmed: false,
        semantics: 'Approval confirms the selected publisher website and the exact replacement. The proposal applies only to this local registry; it does not deploy or prove recovery.' };
    } finally { this.busyDiscovery = false; }
  }
  private replace(raw: unknown, sourceId: string, oldEndpoint: Endpoint, newUrl: string) {
    const copy = structuredClone(raw) as { countries: { code: string; name: string; feeds: Record<string, unknown>[] }[] };
    let changed = 0;
    for (const country of copy.countries) for (const feed of country.feeds) {
      const singleton = normalizeRegistry({ countries: [{ ...country, feeds: [feed] }] }).sources[0];
      if (singleton.id !== sourceId) continue;
      const key = oldEndpoint.type === 'rss' ? 'url' : 'sitemapUrl';
      if (typeof feed[key] !== 'string' || canonicalUrl(feed[key] as string) !== oldEndpoint.url) throw Error('WORKFLOW_REGISTRY_CHANGED');
      feed[key] = newUrl; changed++;
    }
    if (!changed) throw Error('WORKFLOW_SOURCE_ENDPOINT_NOT_FOUND');
    normalizeRegistry(copy);
    return copy;
  }
  approve(raw: unknown, principal: RepairPrincipal) {
    this.authorize(principal);
    const input = repairApprovalSchema.parse(raw);
    return this.lock(() => {
      const proposal = this.required(input.proposal_id);
      if (proposal.proposal_digest !== input.proposal_digest) throw Error('WORKFLOW_PROPOSAL_CHANGED');
      const currentHash = this.readRegistry().registryHash;
      const expected = input.action === 'apply' ? proposal.content.registry_hash : proposal.applied_registry_hash;
      if (!expected || input.expected_registry_hash !== expected || currentHash !== expected) throw Error('WORKFLOW_REGISTRY_CHANGED');
      if (input.action === 'apply' && !['proposed', 'approved'].includes(proposal.state)) throw Error('WORKFLOW_ALREADY_APPLIED');
      if (input.action === 'rollback' && !['applied', 'recovered'].includes(proposal.state)) throw Error('WORKFLOW_NOT_APPLIED');
      if (proposal.approvals.length >= 30) throw Error('WORKFLOW_APPROVAL_LIMIT');
      const approval = { approval_id: randomUUID(), proposal_digest: proposal.proposal_digest, registry_hash: expected,
        action: input.action, approved_at: this.now().toISOString(), actor_id: principal.actor_id, session_id: principal.session_id };
      proposal.approvals.push(approval);
      if (input.action === 'apply') proposal.state = 'approved';
      this.audit(proposal, 'explicit_approval', principal, { ...approval, official_website_confirmed: true });
      this.save(proposal);
      return { proposal, approval };
    });
  }
  apply(raw: unknown, principal: RepairPrincipal) {
    this.authorize(principal);
    const input = repairApplySchema.parse(raw);
    return this.lock(() => {
      const proposal = this.required(input.proposal_id);
      const approval = proposal.approvals.find(item => item.approval_id === input.approval_id && item.action === 'apply');
      if (!approval || approval.proposal_digest !== proposal.proposal_digest || approval.actor_id !== principal.actor_id || approval.session_id !== principal.session_id)
        throw Error('WORKFLOW_EXACT_APPROVAL_REQUIRED');
      if (proposal.state !== 'approved') throw Error('WORKFLOW_ALREADY_APPLIED');
      const initial = this.readRegistry();
      if (input.expected_registry_hash !== proposal.content.registry_hash || initial.registryHash !== input.expected_registry_hash || approval.registry_hash !== input.expected_registry_hash)
        throw Error('WORKFLOW_REGISTRY_CHANGED');
      if (this.now().getTime() - Date.parse(proposal.content.candidate.validation.checked_at) > 24 * 60 * 60 * 1000) throw Error('WORKFLOW_VALIDATION_EXPIRED');
      const endpoint = initial.catalog.endpoints.get(proposal.content.endpoint_id);
      if (!endpoint || endpoint.url !== proposal.content.old_url) throw Error('WORKFLOW_REGISTRY_CHANGED');
      const next = this.replace(initial.registry, proposal.content.source_id, endpoint, proposal.content.new_url);
      const bytes = JSON.stringify(next, null, 2) + '\n';
      const backup = resolve(this.directory, `${input.proposal_id}.registry-before.json`);
      assertNoSymlink(backup, this.root);
      if (existsSync(backup)) {
        if (lstatSync(backup).size > 16 * 1024 * 1024 || hash(readFileSync(backup)) !== initial.registryHash) throw Error('WORKFLOW_BACKUP_INTEGRITY_FAILED');
      } else atomicWrite(backup, initial.bytes.toString('utf8'));
      const journalPath = resolve(this.directory, `${input.proposal_id}.transaction.json`);
      const appliedAt = this.now().toISOString();
      const journal = { version: 1, proposal_id: input.proposal_id, operation: 'apply', before: initial.registryHash,
        after: hash(bytes), at: appliedAt, approval_id: approval.approval_id, actor_id: principal.actor_id, session_id: principal.session_id };
      atomicWrite(journalPath, JSON.stringify(journal) + '\n');
      atomicWrite(this.registryPath, bytes);
      proposal.state = 'applied'; proposal.applied_at = appliedAt; proposal.applied_registry_hash = journal.after;
      this.audit(proposal, 'local_registry_applied', principal, { approval_id: approval.approval_id, before: journal.before, after: journal.after,
        old_endpoint_id: proposal.content.endpoint_id, new_endpoint_id: proposal.content.new_endpoint_id });
      this.save(proposal);
      rmSync(journalPath);
      return { proposal, registry_reload_required: true, deployed: false };
    });
  }
  rollback(raw: unknown, principal: RepairPrincipal) {
    this.authorize(principal);
    const input = repairApplySchema.parse(raw);
    return this.lock(() => {
      const proposal = this.required(input.proposal_id);
      const approval = proposal.approvals.find(item => item.approval_id === input.approval_id && item.action === 'rollback');
      if (!approval || approval.proposal_digest !== proposal.proposal_digest || approval.actor_id !== principal.actor_id || approval.session_id !== principal.session_id)
        throw Error('WORKFLOW_EXACT_APPROVAL_REQUIRED');
      if (!['applied', 'recovered'].includes(proposal.state) || input.expected_registry_hash !== proposal.applied_registry_hash || this.readRegistry().registryHash !== input.expected_registry_hash)
        throw Error('WORKFLOW_REGISTRY_CHANGED');
      const backup = resolve(this.directory, `${input.proposal_id}.registry-before.json`); assertNoSymlink(backup, this.root);
      if (!existsSync(backup) || lstatSync(backup).size > 16 * 1024 * 1024) throw Error('WORKFLOW_BACKUP_MISSING');
      const original = readFileSync(backup);
      if (hash(original) !== proposal.content.registry_hash) throw Error('WORKFLOW_BACKUP_INTEGRITY_FAILED');
      normalizeRegistry(JSON.parse(original.toString('utf8')));
      const journalPath = resolve(this.directory, `${input.proposal_id}.transaction.json`);
      atomicWrite(journalPath, JSON.stringify({ version: 1, proposal_id: input.proposal_id, operation: 'rollback',
        before: proposal.applied_registry_hash, after: proposal.content.registry_hash, at: this.now().toISOString(),
        approval_id: approval.approval_id, actor_id: principal.actor_id, session_id: principal.session_id }) + '\n');
      atomicWrite(this.registryPath, original.toString('utf8'));
      proposal.state = 'rolled_back';
      proposal.recovery = { checked_at: this.now().toISOString(), status: 'rolled_back', validation: null,
        collector: null, fresh_content_after_apply: false, reason: 'Explicitly approved rollback restored the original local snapshot.' };
      this.audit(proposal, 'local_registry_rolled_back', principal, { approval_id: approval.approval_id, registry_hash: proposal.content.registry_hash });
      this.save(proposal); rmSync(journalPath);
      return { proposal, registry_reload_required: true, deployed: false };
    });
  }
  async verify(proposalId: string) {
    const proposal = this.required(proposalId);
    if (proposal.state === 'rolled_back') return proposal;
    const validation = (await this.validateCandidate(proposal.content.candidate)).validation;
    let collector: CollectorRecoveryEvidence | null = null;
    if (proposal.applied_at && this.options.readCollectorEvidence)
      collector = collectorSchema.nullable().parse(await this.options.readCollectorEvidence(proposal.content.new_endpoint_id, proposal.content.new_source_id, proposal.applied_at));
    let status: z.infer<typeof recoverySchema>['status'];
    let reason: string;
    const applied = proposal.applied_at !== null && ['applied', 'recovered'].includes(proposal.state);
    const current = this.readRegistry();
    const bound = current.catalog.sources.find(item => item.id === proposal.content.new_source_id)?.endpoints.some(item => item.id === proposal.content.new_endpoint_id);
    const fresh = applied && validation.newest_content_at !== null && Date.parse(validation.newest_content_at) >= Date.parse(proposal.applied_at!) &&
      Date.parse(validation.newest_content_at) <= this.now().getTime() + 5 * 60 * 1000;
    const collectorPassed = applied && collector?.successful === true && !collector.baseline && Date.parse(collector.completed_at) > Date.parse(proposal.applied_at!) &&
      Date.parse(collector.completed_at) <= this.now().getTime() + 5 * 60 * 1000;
    if (applied && !bound) { status = 'registry_changed'; reason = 'The approved endpoint is no longer bound to the source.'; }
    else if (validation.status === 'invalid') { status = 'still_failing'; reason = 'The selected endpoint did not pass the bounded XML validation.'; }
    else if (validation.content_freshness === 'stale' || validation.content_freshness === 'unreliable') { status = 'stale_content'; reason = 'A response succeeded but its content dates do not establish fresh collection.'; }
    else if (!validation.entries_with_url || validation.format === 'sitemapindex') { status = 'valid_empty_pending'; reason = 'Valid empty output or a sitemap index does not establish article collection recovery.'; }
    else if (!applied) { status = 'candidate_only'; reason = 'A valid candidate was checked; the registry change has not been applied.'; }
    else if (!collectorPassed) { status = 'validation_passed_waiting_for_collector'; reason = 'Endpoint validation passed. A completed successful non-baseline collection after application is still required.'; }
    else if (!fresh) { status = 'collector_success_confirmed'; reason = 'The collector succeeded; no reliable content date after application is available to confirm renewed updates.'; }
    else { status = 'recovered'; reason = 'A successful non-baseline collector run after application and newer dated article URLs confirm recovery.'; }
    return this.lock(() => {
      const latest = this.required(proposalId);
      if (latest.state !== proposal.state || latest.applied_at !== proposal.applied_at) throw Error('WORKFLOW_STATE_CHANGED');
      latest.recovery = { checked_at: this.now().toISOString(), status, validation, collector,
        fresh_content_after_apply: fresh, reason };
      if (status === 'recovered') latest.state = 'recovered';
      // Keep applied lifecycle if a later verification fails, while exposing its current recovery status.
      if (latest.state === 'recovered' && status !== 'recovered') latest.state = 'applied';
      this.audit(latest, 'recovery_checked', null, { status, collector_run_id: collector?.run_id ?? null,
        collector_baseline: collector?.baseline ?? null, live_http_success_alone_is_recovery: false });
      this.save(latest); return latest;
    });
  }
}
