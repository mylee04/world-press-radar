import type { Endpoint } from './catalog.js';
import type { Observation } from './health.js';
import { fetchXml, type RequestGate } from './validate.js';
import { inspectXml } from './inspect.js';
import {HostCooldownError,classifyRecovery} from './recovery-policy.js';

export async function auditEndpoint(endpoint: Endpoint, gate?: RequestGate, fullUrls = false): Promise<Observation & { observedUrls?: string[] }> {
  const started = Date.now(); let status: number | null = null;
  let reason: string | null = null; let summary: ReturnType<typeof inspectXml> | undefined; let finalUrl: string | undefined;
  let auditStatus: Observation['auditStatus'] = 'network_error';
  const diagnostics:NonNullable<Observation['diagnostics']>={phase:'fetch',contentType:null,bodyKind:'not_received',retryAfterAt:null};
  try {
    // Larger bounded sitemap bodies are common; never fetch referenced children/articles.
    const maxBytes = endpoint.type === 'sitemap' ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    const response = await fetchXml(endpoint.url, 8000, maxBytes, gate); status = response.status; finalUrl = response.finalUrl;
    diagnostics.contentType=response.contentType;diagnostics.retryAfterAt=response.retryAfterAt;diagnostics.requestHost=new URL(response.finalUrl).hostname;
    if (status < 200 || status >= 300) throw new Error(`HTTP_${status}`);
    diagnostics.phase='inspect';
    const prefix=response.body.subarray(0,512).toString('utf8').trimStart();
    diagnostics.bodyKind=/^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html\b|<html\b)/i.test(prefix)?'html':'other_or_unknown';
    summary = inspectXml(response.body, endpoint.type, Date.now(), maxBytes, fullUrls);
    auditStatus = summary.entryCount ? 'working_nonempty' : 'valid_empty';diagnostics.phase='complete';
  } catch (error) {
    const evidence=(error as {responseEvidence?:{httpStatus:number|null,contentType:string|null,retryAfterAt:string|null,requestHost:string}})?.responseEvidence;
    if(evidence){status=evidence.httpStatus;Object.assign(diagnostics,{contentType:evidence.contentType,retryAfterAt:evidence.retryAfterAt,requestHost:evidence.requestHost});}
    const message = error instanceof Error ? error.message : '';
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    const finite = /^(HTTP_\d{3}|TIMEOUT|POLITENESS_WAIT_LIMIT|BODY_TOO_LARGE|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|UNSUPPORTED_ENCODING|INVALID_COMPRESSION|DTD_NOT_ALLOWED|INVALID_XML|INVALID_UTF8|INVALID_ENTRY_URL|WRONG_ENDPOINT_FORMAT|HOST_COOLDOWN)$/.test(message);
    reason = finite ? message : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : diagnostics.phase==='inspect'?'PARSER_STAGE_ERROR':'NETWORK_OR_PARSE_ERROR';
    if(error instanceof HostCooldownError){diagnostics.requestHost=error.hostname;diagnostics.cooldownUntil=error.until;}
    if (reason === 'TIMEOUT' || reason === 'ETIMEDOUT') auditStatus = 'timeout';
    else if (status === 401 || status === 403 || status === 429) auditStatus = 'blocked';
    else if (status !== null && (status < 200 || status >= 300)) auditStatus = 'http_error';
    else if (['INVALID_XML', 'INVALID_UTF8', 'INVALID_ENTRY_URL', 'WRONG_ENDPOINT_FORMAT', 'DTD_NOT_ALLOWED','PARSER_STAGE_ERROR'].includes(reason)) auditStatus = 'malformed';
    else if (['HOST_COOLDOWN','POLITENESS_WAIT_LIMIT', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING','INVALID_COMPRESSION', 'PRIVATE_ADDRESS', 'UNSAFE_PORT', 'TOO_MANY_REDIRECTS'].includes(reason) || code === 'ERR_BUFFER_TOO_LARGE') auditStatus = 'incomplete';
  }
  return { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: new Date().toISOString(),
    outcome: summary ? 'healthy' : 'unhealthy', httpStatus: status, reason, format: summary?.format ?? null,
    auditStatus, ...(summary ?? {}), ...(finalUrl ? { finalUrl } : {}), durationMs: Date.now() - started, attempts: 1, validatorVersion: '3',diagnostics };
}

export function isTransient(result: Observation): boolean {
  return classifyRecovery(result).action==='bounded_backoff';
}
