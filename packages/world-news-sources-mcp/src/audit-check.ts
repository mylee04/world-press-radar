import type { Endpoint } from './catalog.js';
import type { Observation } from './health.js';
import { fetchXml, type RequestGate } from './validate.js';
import { inspectXml } from './inspect.js';

export async function auditEndpoint(endpoint: Endpoint, gate?: RequestGate): Promise<Observation> {
  const started = Date.now(); let status: number | null = null;
  let reason: string | null = null; let summary: ReturnType<typeof inspectXml> | undefined; let finalUrl: string | undefined;
  let auditStatus: Observation['auditStatus'] = 'network_error';
  try {
    // Larger bounded sitemap bodies are common; never fetch referenced children/articles.
    const maxBytes = endpoint.type === 'sitemap' ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    const response = await fetchXml(endpoint.url, 8000, maxBytes, gate); status = response.status; finalUrl = response.finalUrl;
    if (status < 200 || status >= 300) throw new Error(`HTTP_${status}`);
    summary = inspectXml(response.body, endpoint.type, Date.now(), maxBytes);
    auditStatus = summary.entryCount ? 'working_nonempty' : 'valid_empty';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    const finite = /^(HTTP_\d{3}|TIMEOUT|POLITENESS_WAIT_LIMIT|BODY_TOO_LARGE|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|UNSUPPORTED_ENCODING|DTD_NOT_ALLOWED|INVALID_XML|INVALID_ENTRY_URL|WRONG_ENDPOINT_FORMAT)$/.test(message);
    reason = finite ? message : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : 'NETWORK_OR_PARSE_ERROR';
    if (reason === 'TIMEOUT' || reason === 'ETIMEDOUT') auditStatus = 'timeout';
    else if (status === 401 || status === 403 || status === 429) auditStatus = 'blocked';
    else if (status !== null && (status < 200 || status >= 300)) auditStatus = 'http_error';
    else if (['INVALID_XML', 'INVALID_ENTRY_URL', 'WRONG_ENDPOINT_FORMAT', 'DTD_NOT_ALLOWED'].includes(reason) || error instanceof TypeError) auditStatus = 'malformed';
    else if (['POLITENESS_WAIT_LIMIT', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'PRIVATE_ADDRESS', 'UNSAFE_PORT', 'TOO_MANY_REDIRECTS'].includes(reason) || code === 'ERR_BUFFER_TOO_LARGE') auditStatus = 'incomplete';
  }
  return { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: new Date().toISOString(),
    outcome: summary ? 'healthy' : 'unhealthy', httpStatus: status, reason, format: summary?.format ?? null,
    auditStatus, ...(summary ?? {}), ...(finalUrl ? { finalUrl } : {}), durationMs: Date.now() - started, attempts: 1, validatorVersion: '2' };
}

export function isTransient(result: Observation): boolean {
  return result.auditStatus === 'timeout' || ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(result.reason ?? '') ||
    [500, 502, 503, 504].includes(result.httpStatus ?? 0);
}
