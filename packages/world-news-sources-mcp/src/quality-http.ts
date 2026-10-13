import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Catalog } from './catalog.js';
import type { ActivityStore } from './activity.js';
import type { HealthStore } from './health.js';
import { getCountryQualityOverview, getAllCountryQualityOverview, getSourceQualityDetail, countryQualitySchema } from './quality.js';
import { getInventoryChanges } from './quality-inventory.js';
import { InvestigationStore, investigationSchema } from './investigation.js';
import { RemoteQualityStore } from './quality-remote.js';
import { estimateGlobalPublisherInventory } from './publisher-inventory.js';
import type { QualityHistoryStore } from './quality-history.js';
import { repairApprovalSchema, repairApplySchema, type RepairPrincipal, type RepairWorkflowStore } from './repair-workflow.js';
import { publicInvestigation, type CloudQualityAccess } from './quality-cloud-auth.js';

const staticFiles: Record<string, [string, string]> = {
  '/quality': ['index.html', 'text/html; charset=utf-8'],
  '/quality/': ['index.html', 'text/html; charset=utf-8'],
  '/quality/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/quality/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
export type QualityRuntimeOptions = {
  investigations?: ConstructorParameters<typeof InvestigationStore>[4];
  history?: QualityHistoryStore; repair?: RepairWorkflowStore; localOwner?: boolean;
  cloudAccess?: CloudQualityAccess;
  savedRemoteOverview?: (date?: string) => Record<string, any> | undefined;
};
const ADMIN_COOKIE = 'wns_quality_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
function sameOrigin(request: Request, url: URL) {
  const origin = request.headers.get('origin');
  return (!origin || origin === url.origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
}
function loopback(url: URL) { return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()); }

async function readSmallJson(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('JSON_CONTENT_TYPE_REQUIRED');
  const reader = request.body?.getReader(); if (!reader) throw Error('JSON_BODY_REQUIRED');
  const parts: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > 8192) throw Error('REQUEST_TOO_LARGE');
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = new Uint8Array(total); let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

export function createQualityHandler(catalog: Catalog, health: HealthStore, activity: ActivityStore,
  rawRegistry?: unknown, allowInvestigations = false, remote = false, options: QualityRuntimeOptions = {}) {
  const investigations = new InvestigationStore(catalog, health, activity, remote, options.investigations);
  const remoteQuality = remote ? new RemoteQualityStore() : null;
  const sessions = new Map<string, { origin: string; expires: number }>();
  const repair = options.localOwner || options.cloudAccess ? options.repair : undefined;
  function session(request: Request, url: URL): RepairPrincipal | null {
    if (options.cloudAccess) return options.cloudAccess.authenticate(request, url);
    if (!options.localOwner || !loopback(url) || !sameOrigin(request, url)) return null;
    const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${ADMIN_COOKIE}=`));
    const id = cookie?.slice(ADMIN_COOKIE.length + 1);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const saved = sessions.get(id);
    if (!saved || saved.expires <= Date.now()) { sessions.delete(id); return null; }
    if (saved.origin !== url.origin) return null;
    // Audit records use a one-way session reference, never the authentication cookie.
    const reference = createHash('sha256').update(`world-news-quality-owner-session\0${id}`).digest('base64url');
    return { actor_id: 'local_owner', session_id: reference };
  }
  function authenticated(request: Request, url: URL) {
    const principal = session(request, url); if (!principal) throw Error(options.cloudAccess ? 'QUALITY_ADMIN_AUTH_REQUIRED' : 'WORKFLOW_AUTH_REQUIRED'); return principal;
  }
  function runtime(principal: RepairPrincipal | null = null) {
    const persisted = Boolean(options.investigations && 'store' in options.investigations && options.investigations.store);
    const openai = investigations.modelReadiness();
    const jev = investigations.jevReadiness();
    const publicCloud = Boolean(options.cloudAccess && !principal);
    return { investigations_enabled: allowInvestigations && !publicCloud, model_provider: 'rules', model_api_configured: !publicCloud && (openai.available || jev.available),
      ...(options.cloudAccess ? { public_access: 'read_only', admin_auth_required: true, admin_login_enabled: options.cloudAccess.adminAvailable() } : {}),
      openai: publicCloud ? { available: false, reason: 'administrator_access_required' } : openai,
      jev: publicCloud ? { available: false, reason: 'administrator_access_required' } : jev, event_retention: persisted ? 'SQLite; saved across server restarts. Interrupted runs are not automatically restarted.'
        : 'In-memory, at most 20 runs for one hour; cleared on server restart.',
      sources_read_only: true, publisher_fetches: false,
      repair_workflow: { enabled: Boolean(repair) && !publicCloud, scope: options.cloudAccess ? 'cloud_registry' : 'local_registry', approval_required: true,
        publisher_fetches: 'explicit_review_only', deployed: false } };
  }
  function decorate(payload: Record<string, any>) {
    if (!options.history) return payload;
    options.history.observeOverview(payload);
    return options.history.decorateOverview(payload);
  }
  return async function fetchQuality(request: Request): Promise<Response | null> {
    let url = new URL(request.url);
    if (!url.pathname.startsWith('/quality')) return null;
    try {
      if (options.cloudAccess) url = options.cloudAccess.publicUrl(request);
      const staticFile = staticFiles[url.pathname];
      if (staticFile) {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
        const body = readFileSync(new URL(`../dashboard/${staticFile[0]}`, import.meta.url));
        return new Response(body, { headers: { 'content-type': staticFile[1], 'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" } });
      }
      if (url.pathname === '/quality/api/admin/session' && request.method === 'GET') {
        if (options.cloudAccess) return await options.cloudAccess.sessionResponse(request, url);
        if (!options.localOwner || !loopback(url) || !sameOrigin(request, url)) return json({ error: 'Local owner access required' }, 403);
        const current = session(request, url);
        if (current) return json({ authenticated: true, actor: 'local_owner', scope: 'local_registry' });
        for (const [id, saved] of sessions) if (saved.expires <= Date.now()) sessions.delete(id);
        if (sessions.size >= 100) return json({ error: 'WORKFLOW_SESSION_LIMIT' }, 429);
        const id = randomBytes(32).toString('base64url'); sessions.set(id, { origin: url.origin, expires: Date.now() + SESSION_MS });
        const response = json({ authenticated: true, actor: 'local_owner', scope: 'local_registry' });
        response.headers.set('set-cookie', `${ADMIN_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/quality/api/; Max-Age=${SESSION_MS / 1000}${url.protocol === 'https:' ? '; Secure' : ''}`);
        return response;
      }
      if (url.pathname === '/quality/api/admin/session' && options.cloudAccess && ['POST', 'DELETE'].includes(request.method))
        return await options.cloudAccess.sessionResponse(request, url);
      const principal = session(request, url);
      const publicCloud = Boolean(options.cloudAccess && !principal);
      const date = url.searchParams.get('date') ?? (options.cloudAccess ? new Date(Date.now() - 86400000).toISOString().slice(0, 10) : undefined);
      if (url.pathname === '/quality/api/overview' && request.method === 'GET') {
        if (remoteQuality) {
          const overview = options.savedRemoteOverview?.(date) ?? await remoteQuality.overview(date);
          return json({ ...decorate(overview), runtime: { ...overview.runtime, ...runtime(principal) } });
        }
        const first = getAllCountryQualityOverview(catalog, activity, health, { date });
        const active = catalog.sources.filter(s => s.enabled);
        const distinct = (type: 'rss' | 'sitemap') => new Set(active.flatMap(s => s.endpoints.filter(e => e.type === type).map(e => e.id))).size;
        return json(decorate({ ...first, next_offset: null,
          global_inventory: { active_countries: new Set(active.map(s => s.countryCode)).size,
            active_source_registrations: active.reduce((sum, s) => sum + s.activeRegistrationCount, 0),
            unique_active_rss_endpoints: distinct('rss'), unique_active_sitemap_endpoints: distinct('sitemap'), ...estimateGlobalPublisherInventory(active) },
          inventory_changes: getInventoryChanges(catalog, rawRegistry, first.date, health),
          runtime: runtime(principal) }));
      }
      if (url.pathname === '/quality/api/country' && request.method === 'GET') {
        if (remoteQuality) return json(await remoteQuality.country(url.searchParams.get('country') ?? '', date));
        const input = countryQualitySchema.parse({ country: url.searchParams.get('country') ?? '', date });
        const overview = getCountryQualityOverview(catalog, activity, health, input);
        const country = overview.items[0];
        return json({ country, date: overview.date, snapshot_at: overview.snapshot_at,
          sources: catalog.sources.filter(s => s.enabled && s.countryCode === input.country!.toUpperCase()),
          inventory_changes: getInventoryChanges(catalog, rawRegistry, overview.date, health) });
      }
      if (url.pathname === '/quality/api/source' && request.method === 'GET') return json(remoteQuality
        ? await remoteQuality.source(url.searchParams.get('source_id') ?? '', date)
        : getSourceQualityDetail(catalog, activity, health, { source_id: url.searchParams.get('source_id'), date }));
      if (url.pathname === '/quality/api/investigations' && request.method === 'GET') {
        const runs = investigations.list(20);
        return json({ items: publicCloud ? runs.filter(run => run.status !== 'running').map(publicInvestigation) : runs });
      }
      if (url.pathname === '/quality/api/investigations' && request.method === 'POST') {
        if (!allowInvestigations) return json({ error: 'Investigation runs are disabled here. Use the local dashboard runtime.' }, 503);
        if (!(options.cloudAccess ? options.cloudAccess.sameOrigin(request, url) : sameOrigin(request, url))) return json({ error: 'Same-origin request required' }, 403);
        if (options.cloudAccess) authenticated(request, url);
        const input = investigationSchema.parse(await readSmallJson(request));
        // Preserve idempotent request conflict detection before the paid execution gate.
        // This branch never starts a run or makes a model request.
        const previous = input.request_id ? investigations.getByRequestId(input.request_id) : undefined;
        if (previous && (previous.country !== input.country || previous.cost.provider !== input.engine || input.date && input.date !== previous.date))
          throw Error('INVESTIGATION_REQUEST_ID_CONFLICT');
        if (input.engine !== 'rules') authenticated(request, url);
        return json(investigations.start(input), 202);
      }
      if (url.pathname === '/quality/api/proposals' && ['GET', 'POST'].includes(request.method)) {
        if (options.cloudAccess) authenticated(request, url);
        if (!repair) return json({ error: 'Local repair workflow is unavailable' }, 503);
        if (request.method === 'GET') return json(repair.list());
        authenticated(request, url);
        const result = await repair.discover(await readSmallJson(request));
        return json(result, result.proposal ? 201 : 200);
      }
      const proposalMatch = /^\/quality\/api\/proposals\/([a-f0-9-]{36})(?:\/(approve|apply|verify|rollback))?$/.exec(url.pathname);
      if (proposalMatch) {
        if (options.cloudAccess) authenticated(request, url);
        if (!repair) return json({ error: 'Local repair workflow is unavailable' }, 503);
        const proposalId = z.string().uuid().parse(proposalMatch[1]);
        const action = proposalMatch[2];
        if (!action && request.method === 'GET') {
          const proposal = repair.get(proposalId); return proposal ? json({ proposal }) : json({ error: 'WORKFLOW_PROPOSAL_NOT_FOUND' }, 404);
        }
        if (action && request.method === 'POST') {
          const principal = authenticated(request, url);
          const body = await readSmallJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || 'proposal_id' in body) throw Error('WORKFLOW_INVALID_REQUEST');
          if (action === 'approve') return json(repair.approve(repairApprovalSchema.parse({ ...body, proposal_id: proposalId }), principal));
          if (action === 'apply') return json(repair.apply(repairApplySchema.parse({ ...body, proposal_id: proposalId }), principal));
          if (action === 'rollback') return json(repair.rollback(repairApplySchema.parse({ ...body, proposal_id: proposalId }), principal));
          z.object({}).strict().parse(body);
          return json({ proposal: await repair.verify(proposalId) });
        }
      }
      const requestMatch = /^\/quality\/api\/investigations\/requests\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (requestMatch && request.method === 'GET') {
        const requestId = z.string().uuid().parse(requestMatch[1]);
        const run = investigations.getByRequestId(requestId);
        if (publicCloud) return json({ error: 'QUALITY_ADMIN_AUTH_REQUIRED' }, 403);
        return run ? json(run) : json({ error: 'Investigation request not found or no longer retained' }, 404);
      }
      const match = /^\/quality\/api\/investigations\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        const run = investigations.get(match[1]);
        if (publicCloud && run?.status === 'running') return json({ error: 'Run not found or no longer retained' }, 404);
        return run ? json(publicCloud ? publicInvestigation(run) : run) : json({ error: 'Run not found or no longer retained' }, 404);
      }
      if (url.pathname.startsWith('/quality/api/')) return json({ error: 'Route not found or method not allowed' }, 404);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const message = error instanceof z.ZodError ? 'Invalid request' : /^(?:WORKFLOW|INVESTIGATION|OPENAI|JEV|QUALITY|ACTIVITY|JSON|REQUEST)_[A-Z0-9_]{1,110}$/.test(raw)
        ? raw : ['Unknown country', 'Invalid investigation date'].includes(raw) ? raw : 'Quality request failed';
      const status = ['OPENAI_EXECUTION_NOT_AUTHORIZED', 'JEV_EXECUTION_NOT_AUTHORIZED', 'WORKFLOW_AUTH_REQUIRED', 'QUALITY_GATEWAY_AUTH_REQUIRED', 'QUALITY_ADMIN_AUTH_REQUIRED', 'QUALITY_PUBLIC_ORIGIN_INVALID'].includes(message) ? 403
        : ['INVESTIGATION_BUSY', 'WORKFLOW_BUSY', 'WORKFLOW_DISCOVERY_BUSY'].includes(message) ? 429 : message === 'REQUEST_TOO_LARGE' ? 413
          : message === 'WORKFLOW_PROPOSAL_NOT_FOUND' ? 404 : ['WORKFLOW_REGISTRY_CHANGED', 'WORKFLOW_PROPOSAL_CHANGED', 'WORKFLOW_STATE_CHANGED', 'WORKFLOW_ALREADY_APPLIED', 'WORKFLOW_VALIDATION_EXPIRED'].includes(message) ? 409
            : message.startsWith('ACTIVITY_HISTORY_') ? 503 : 400;
      return json({ error: message }, status);
    }
  };
}
