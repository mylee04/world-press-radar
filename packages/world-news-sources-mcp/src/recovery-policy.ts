import type { Observation } from './health.js';
const HOUR=3600000,DAY=24*HOUR;
export const POLICY_VERSION='cause-aware-1';
export function parseRetryAfter(value: unknown,now=Date.now()):string|null {
  if(typeof value!=='string')return null;
  const text=value.trim();let at:number;
  if(/^\d{1,9}$/.test(text))at=now+Number(text)*1000;
  else if(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text))at=Date.parse(text);
  else return null;
  return Number.isFinite(at)?new Date(Math.max(now,at)).toISOString():null;
}
export function classifyRecovery(o:Pick<Observation,'httpStatus'|'reason'|'auditStatus'|'diagnostics'>) {
  const status=o.httpStatus??(/^HTTP_\d{3}$/.test(o.reason??'')?Number(o.reason!.slice(5)):null),reason=o.reason;
  if(['working_nonempty','valid_empty'].includes(o.auditStatus??''))return {category:'healthy',action:'normal_cadence',review:false};
  if(status===429)return {category:'rate_limited',action:'wait_retry_after',review:false};
  if([401,403,402,451].includes(status??0))return {category:'access_restricted',action:'review_official_alternative',review:true};
  if([404,410].includes(status??0))return {category:'missing_endpoint',action:'review_relocation_or_removal',review:true};
  if(reason==='HOST_COOLDOWN')return {category:'host_cooldown',action:'wait_host_cooldown',review:false};
  // 5xx is a retry candidate; its underlying cause or transience is not proven.
  if(status!==null&&status>=500&&status<=599)return {category:'server_error_retry_candidate',action:'bounded_backoff',review:false};
  if(['TIMEOUT','ETIMEDOUT','EAI_AGAIN','ECONNRESET','ECONNREFUSED'].includes(reason??''))return {category:'transient_transport',action:'bounded_backoff',review:false};
  if(['ENOTFOUND','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(reason??''))return {category:'dns_or_tls_configuration',action:'review_dns_or_tls',review:true};
  if(o.diagnostics?.bodyKind==='html')return {category:'html_response',action:'review_official_endpoint',review:true};
  if(reason==='WRONG_ENDPOINT_FORMAT')return {category:'wrong_endpoint_format',action:'review_official_endpoint',review:true};
  if(['INVALID_XML','INVALID_ENTRY_URL','INVALID_UTF8','DTD_NOT_ALLOWED'].includes(reason??''))return {category:'document_validation',action:'review_document_or_parser_fixture',review:true};
  if(reason==='PARSER_STAGE_ERROR')return {category:'parser_investigation',action:'investigate_parser_without_claiming_defect',review:true};
  if(['POLITENESS_WAIT_LIMIT'].includes(reason??''))return {category:'local_governor',action:'defer_without_extra_pressure',review:false};
  if(['BODY_TOO_LARGE','UNSUPPORTED_ENCODING','INVALID_COMPRESSION','TOO_MANY_REDIRECTS','PRIVATE_ADDRESS','UNSAFE_PORT'].includes(reason??''))return {category:'bounded_or_safety_limit',action:'review_limits_or_endpoint',review:true};
  if(status!==null)return {category:'other_http',action:'review_http_response',review:true};
  return {category:'unresolved',action:'retain_diagnostics_and_review',review:true};
}
export function recoveryPlan(o:Observation,failedChecks:number) {
  const classification=classifyRecovery(o),at=Date.parse(o.checkedAt),backoff=Math.min(7*DAY,HOUR*2**Math.min(Math.max(1,failedChecks),8));
  const healthy=classification.category==='healthy';let delay=healthy?(o.format==='sitemapindex'?7*DAY:DAY):backoff;
  if(classification.review)delay=['parser_investigation','unresolved','dns_or_tls_configuration'].includes(classification.category)?DAY:7*DAY;
  if(classification.category==='local_governor')delay=HOUR;
  if(classification.category==='rate_limited')delay=o.diagnostics?.retryAfterAt?Math.max(60000,Date.parse(o.diagnostics.retryAfterAt)-at):6*HOUR;
  if(classification.category==='host_cooldown'&&o.diagnostics?.cooldownUntil)delay=Math.max(60000,Date.parse(o.diagnostics.cooldownUntil)-at);
  const next=healthy?Date.parse(o.checkedAt.slice(0,10))+delay:at+delay;
  return {...classification,nextEligibleAt:new Date(next).toISOString(),failedChecks:healthy?0:failedChecks,policyVersion:POLICY_VERSION};
}
export class HostCooldownError extends Error {
  constructor(readonly hostname:string,readonly until:string){super('HOST_COOLDOWN');}
}
