import type { Endpoint } from './catalog.js';
import type { Observation } from './health.js';
import { fetchXml, type RequestGate } from './validate.js';
import { inspectXml } from './inspect.js';
import { parseRetryAfter } from './collection-schedule.js';

export type AuditObservation = Observation & { observedUrls?: string[]; requestedHops?: number; stopReason?: 'DAILY_REQUEST_BUDGET_EXHAUSTED';
  serverDeferral?: { until: string; httpStatus: number | null; hostname?: string }; requestDeferred?: { until: string; httpStatus: number | null; hostname?: string } };

export async function auditEndpoint(endpoint: Endpoint, gate?: RequestGate, fullUrls = false): Promise<AuditObservation> {
  const started = Date.now(); let status: number | null = null;
  let reason: string | null = null; let summary: ReturnType<typeof inspectXml> | undefined; let finalUrl: string | undefined;
  let auditStatus: Observation['auditStatus'] = 'network_error';
  let retryAfter: ReturnType<typeof parseRetryAfter> = null, requestDeferred: AuditObservation['requestDeferred'];
  let requestedHops = 0, serverDeferral: AuditObservation['serverDeferral'], stopReason: AuditObservation['stopReason'];
  try {
    // Larger bounded sitemap bodies are common; never fetch referenced children/articles.
    const maxBytes = endpoint.type === 'sitemap' ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    const response = await fetchXml(endpoint.url, 8000, maxBytes, gate); status = response.status; finalUrl = response.finalUrl;
    requestedHops = response.requestedHops;
    if (status >= 400) retryAfter = parseRetryAfter(response.retryAfter);
    if (status < 200 || status >= 300) throw new Error(`HTTP_${status}`);
    summary = inspectXml(response.body, endpoint.type, Date.now(), maxBytes, fullUrls);
    auditStatus = summary.entryCount ? 'working_nonempty' : 'valid_empty';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const transport = error as Error & { requestedHops?: number; lastHttpStatus?: number | null; lastUrl?: string; retryAfterAt?: string; httpStatus?: number | null };
    requestedHops = transport.requestedHops ?? requestedHops;
    if (message === 'DAILY_REQUEST_BUDGET_EXHAUSTED' && requestedHops) stopReason = 'DAILY_REQUEST_BUDGET_EXHAUSTED';
    else if (['DAILY_REQUEST_BUDGET_EXHAUSTED', 'COLLECTOR_LEASE_LOST', 'SQLITE_STORAGE_BUDGET_EXHAUSTED'].includes(message)) throw error;
    if (message === 'SERVER_RETRY_AFTER_WAIT') {
      const deferred = error as Error & { retryAfterAt: string; httpStatus: number | null; hostname?: string };
      if (requestedHops) serverDeferral = { until: deferred.retryAfterAt, httpStatus: deferred.httpStatus, ...(deferred.hostname ? { hostname: deferred.hostname } : {}) };
      else requestDeferred = { until: deferred.retryAfterAt, httpStatus: deferred.httpStatus, ...(deferred.hostname ? { hostname: deferred.hostname } : {}) };
    }
    if (requestedHops) { if (transport.lastHttpStatus !== undefined) status = transport.lastHttpStatus; finalUrl = transport.lastUrl ?? finalUrl; }
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    const finite = /^(HTTP_\d{3}|TIMEOUT|POLITENESS_WAIT_LIMIT|BODY_TOO_LARGE|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|UNSUPPORTED_ENCODING|DTD_NOT_ALLOWED|INVALID_XML|INVALID_ENTRY_URL|WRONG_ENDPOINT_FORMAT)$/.test(message);
    reason = finite ? message : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : 'NETWORK_OR_PARSE_ERROR';
    if (reason === 'TIMEOUT' || reason === 'ETIMEDOUT') auditStatus = 'timeout';
    else if (status === 401 || status === 403 || status === 429) auditStatus = 'blocked';
    else if (status !== null && (status < 200 || status >= 300)) auditStatus = 'http_error';
    else if (['INVALID_XML', 'INVALID_ENTRY_URL', 'WRONG_ENDPOINT_FORMAT', 'DTD_NOT_ALLOWED'].includes(reason) || error instanceof TypeError) auditStatus = 'malformed';
    else if (['POLITENESS_WAIT_LIMIT', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'PRIVATE_ADDRESS', 'UNSAFE_PORT', 'TOO_MANY_REDIRECTS'].includes(reason) || code === 'ERR_BUFFER_TOO_LARGE') auditStatus = 'incomplete';
    if (serverDeferral || stopReason) { auditStatus = 'incomplete'; reason = serverDeferral ? 'REDIRECT_SERVER_RETRY_AFTER_WAIT' : 'REQUEST_BUDGET_DURING_REDIRECT'; }
  }
  return { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: new Date().toISOString(),
    outcome: summary ? 'healthy' : 'unhealthy', httpStatus: status, reason, format: summary?.format ?? null,
    auditStatus, ...(summary ?? {}), ...(finalUrl ? { finalUrl } : {}), retryAfterAt: retryAfter?.at ?? null, retryAfterSource: retryAfter?.source ?? null,
    requestedHops, ...(requestDeferred ? { requestDeferred } : {}), ...(serverDeferral ? { serverDeferral } : {}), ...(stopReason ? { stopReason } : {}), durationMs: Date.now() - started, attempts: 1, validatorVersion: '2' };
}

export function isTransient(result: Observation): boolean {
  if (result.httpStatus === 429 || result.retryAfterAt && Date.parse(result.retryAfterAt) > Date.now()) return false;
  return result.auditStatus === 'timeout' || ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(result.reason ?? '') ||
    [500, 502, 503, 504].includes(result.httpStatus ?? 0);
}
