import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Catalog } from './catalog.js';
import type { ActivityStore } from './activity.js';
import type { HealthStore } from './health.js';
import { createServer } from './server.js';
import { RemoteQualityStore } from './quality-remote.js';
import { runModelInvestigation } from './openai-investigation.js';
import { createPaidOpenAIModel, openAIPolicy, openAIReadiness, OpenAISessionBudget, type OpenAIPolicy } from './openai-runtime.js';
import type { Model } from '@openai/agents';
import { createPaidJevClient, jevPolicy, jevReadiness as readJevReadiness, type JevClient, type JevPolicy, type JevObservation } from './jev-runtime.js';
import { runJevInvestigation } from './jev-investigation.js';
import type { QualityRunStore } from './quality-runtime-storage.js';
import type { ModelObservation } from './openai-investigation.js';

export const investigationSchema = z.object({
  country: z.string().regex(/^[A-Za-z]{2,8}$/).transform(s => s.toUpperCase()),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  engine: z.enum(['rules', 'openai', 'jev']).default('rules'),
  request_id: z.string().uuid().optional(),
}).strict();
export type InvestigationEvent = {
  id: string; run_id: string; at: string; type: string; status: string;
  tool: string | null; args: Record<string, unknown> | null; result: unknown;
  duration_ms: number | null; error: string | null; model_cost_usd: number | null;
  parent_id: null; result_truncated?: boolean;
};
export type InvestigationRun = {
  id: string; country: string; date: string; status: 'running' | 'completed' | 'failed';
  request_id?: string;
  started_at: string; finished_at: string | null; events: InvestigationEvent[];
  findings: Array<Record<string, unknown>>; summary: string | null;
  mode: 'rules_only_cached_mcp' | 'rules_only_remote_cached_mcp' | 'openai_cached_mcp' | 'openai_remote_cached_mcp' | 'jev_cached_mcp' | 'jev_remote_cached_mcp'; truncated: boolean; tool_calls: number;
  limit_reached: boolean;
  inspected_sources: number; available_sources: number | null;
  cost: { provider: 'rules' | 'openai' | 'jev'; model_calls: number; model_cost_usd: number | null; server_cost_usd: null;
    estimated_model_cost_usd?: number | null; billing_cost_usd?: null; input_tokens?: number; output_tokens?: number; cost_basis?: string };
  model_assessment?: Record<string, unknown>;
  limits: { max_tool_calls: number; max_sources: number; max_duration_ms: number };
};
export type InvestigationOptions = { policy?: OpenAIPolicy; createModel?: () => Model;
  budget?: OpenAISessionBudget; store?: QualityRunStore;
  jevPolicy?: JevPolicy; createJevClient?: (budget: OpenAISessionBudget) => JevClient };

// Every displayed collection read passes through the real MCP SDK client/server.
// Optional providers inspect cached evidence only; neither can write publisher/registry state.
export class InvestigationStore {
  readonly runs = new Map<string, InvestigationRun>();
  private readonly modelPolicy: OpenAIPolicy;
  private readonly modelBudget: OpenAISessionBudget;
  private readonly jevModelPolicy: JevPolicy;
  constructor(private readonly catalog: Catalog, private readonly health: HealthStore,
    private readonly activity: ActivityStore, private readonly remote = false,
    private readonly modelOptions?: InvestigationOptions) {
    this.modelPolicy = modelOptions?.policy ?? openAIPolicy();
    this.jevModelPolicy = modelOptions?.jevPolicy ?? jevPolicy();
    const limits = [this.modelPolicy.totalBudgetUsd, this.jevModelPolicy.totalBudgetUsd].filter(value => value > 0);
    this.modelBudget = modelOptions?.budget ?? new OpenAISessionBudget(limits.length ? Math.min(...limits) : 0);
  }

  modelReadiness() {
    const ready = openAIReadiness(this.modelPolicy), budget = this.modelBudget.summary();
    return { ...ready, available: ready.available && budget.remaining_usd > 0,
      reason: ready.reason ?? (budget.remaining_usd <= 0 ? 'approved_budget_exhausted' : null), session_budget: budget };
  }
  jevReadiness() {
    const ready = readJevReadiness(this.jevModelPolicy), budget = this.modelBudget.summary();
    return { ...ready, available: ready.available && budget.remaining_usd > 0,
      reason: ready.reason ?? (budget.remaining_usd <= 0 ? 'approved_budget_exhausted' : null), session_budget: budget };
  }

  get(id: string) {
    const run = this.runs.get(id);
    if (run && run.status !== 'running' && Date.now() - Date.parse(run.started_at) > 3600000) {
      this.runs.delete(id); return this.modelOptions?.store?.get(id);
    }
    return run ?? this.modelOptions?.store?.get(id);
  }

  getByRequestId(requestId: string) {
    const run = [...this.runs.values()].find(value => value.request_id === requestId);
    return run ? this.get(run.id) : this.modelOptions?.store?.getByRequestId(requestId);
  }

  list(limit = 20) {
    const count = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.floor(limit))) : 20;
    const merged = new Map((this.modelOptions?.store?.list(count) ?? []).map(run => [run.id, run]));
    for (const run of this.runs.values()) merged.set(run.id, run);
    return [...merged.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, count);
  }
  private persist(run: InvestigationRun) {
    try { this.modelOptions?.store?.save(run); }
    catch { throw Error('QUALITY_RUN_PERSISTENCE_FAILED'); }
  }

  start(raw: unknown): InvestigationRun {
    const input = investigationSchema.parse(raw);
    if (!this.catalog.countries.some(c => c.code === input.country)) throw new Error('Unknown country');
    const date = input.date ?? (this.remote ? new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      : this.activity.snapshot?.generated_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
    if (!Number.isFinite(Date.parse(date)) || new Date(Date.parse(date)).toISOString().slice(0, 10) !== date
      || date > new Date().toISOString().slice(0, 10)) throw new Error('Invalid investigation date');
    const previous = input.request_id ? this.getByRequestId(input.request_id) : undefined;
    if (previous) {
      if (previous.country !== input.country || previous.date !== date
        || previous.cost.provider !== input.engine) throw Error('INVESTIGATION_REQUEST_ID_CONFLICT');
      return previous;
    }
    if (input.engine === 'openai' && !this.modelOptions?.createModel && !this.modelReadiness().available)
      throw Error('OPENAI_EXECUTION_NOT_AUTHORIZED');
    if (input.engine === 'jev' && !this.modelOptions?.createJevClient && !this.jevReadiness().available)
      throw Error('JEV_EXECUTION_NOT_AUTHORIZED');
    for (const [id, run] of this.runs) if (run.status !== 'running' && Date.now() - Date.parse(run.started_at) > 3600000) this.runs.delete(id);
    if ([...this.runs.values()].filter(r => r.status === 'running').length >= 2) throw new Error('INVESTIGATION_BUSY');
    if (this.runs.size >= 20) {
      const oldest = [...this.runs.values()].find(r => r.status !== 'running');
      if (oldest) this.runs.delete(oldest.id);
    }
    const run: InvestigationRun = {
      id: randomUUID(), country: input.country, date, status: 'running', started_at: new Date().toISOString(),
      finished_at: null, events: [], findings: [], summary: null, mode: this.remote ? 'rules_only_remote_cached_mcp' : 'rules_only_cached_mcp',
      truncated: false, limit_reached: false, tool_calls: 0, inspected_sources: 0, available_sources: null,
      cost: { provider: 'rules', model_calls: 0, model_cost_usd: 0, server_cost_usd: null },
      limits: { max_tool_calls: 48, max_sources: 12, max_duration_ms: 45000 },
      ...(input.request_id ? { request_id: input.request_id } : {}),
    };
    if (input.engine !== 'rules') {
      run.mode = input.engine === 'openai' ? this.remote ? 'openai_remote_cached_mcp' : 'openai_cached_mcp'
        : this.remote ? 'jev_remote_cached_mcp' : 'jev_cached_mcp';
      run.cost = { provider: input.engine, model_calls: 0, model_cost_usd: null, server_cost_usd: null,
        estimated_model_cost_usd: 0, billing_cost_usd: null, cost_basis: 'reported_usage_times_configured_rates; not_billing_receipt' };
      run.limits.max_duration_ms = 120000;
    }
    this.persist(run); this.runs.set(run.id, run);
    void this.execute(run).catch(error => {
      // Storage failure prevents further work. Keep the in-memory failure visible even if disk is unavailable.
      run.status = 'failed'; run.finished_at = new Date().toISOString();
      run.summary = error instanceof Error && /^[A-Z_]{5,100}$/.test(error.message) ? error.message : 'INVESTIGATION_RUN_FAILED';
    });
    return run;
  }

  private event(run: InvestigationRun, fields: Partial<InvestigationEvent>) {
    const event: InvestigationEvent = {
      id: randomUUID(), run_id: run.id, at: new Date().toISOString(), type: 'status', status: run.status,
      tool: null, args: null, result: null, duration_ms: null, error: null, model_cost_usd: 0,
      parent_id: null, ...fields,
    };
    run.events.push(event); this.persist(run); return event;
  }

  private modelObservation(run: InvestigationRun, observation: ModelObservation | JevObservation) {
    if (observation.type === 'model_started') run.cost.model_calls++;
    if (observation.type === 'model_failed' && observation.estimated_cost_usd == null) {
      run.cost.estimated_model_cost_usd = null;
      run.cost.cost_basis = 'incomplete_usage; uncertain_request_reservation_retained';
    } else if (observation.estimated_cost_usd != null && run.cost.estimated_model_cost_usd !== null)
      run.cost.estimated_model_cost_usd = (run.cost.estimated_model_cost_usd ?? 0) + observation.estimated_cost_usd;
    if (observation.usage) {
      run.cost.input_tokens = (run.cost.input_tokens ?? 0) + observation.usage.input_tokens;
      run.cost.output_tokens = (run.cost.output_tokens ?? 0) + observation.usage.output_tokens;
    }
    this.event(run, { type: observation.type, status: observation.status,
      duration_ms: observation.duration_ms ?? null, error: observation.error ?? null,
      model_cost_usd: null, result: observation });
  }

  private async execute(run: InvestigationRun) {
    const client = new Client({ name: 'news-quality-rules-investigator', version: '0.1.0' });
    const server = createServer(this.catalog, this.health, this.activity);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), run.limits.max_duration_ms);
    const call = async (tool: string, args: Record<string, unknown>) => {
      if (run.tool_calls >= run.limits.max_tool_calls || performance.now() - started >= run.limits.max_duration_ms) {
        run.truncated = true; run.limit_reached = true; throw new Error('INVESTIGATION_LIMIT');
      }
      run.tool_calls++;
      const event = this.event(run, { type: 'tool_started', status: 'running', tool, args });
      const before = performance.now();
      try {
        const remaining = Math.max(1, run.limits.max_duration_ms - (performance.now() - started));
        const response = await client.callTool({ name: tool, arguments: args }, { timeout: Math.min(10000, remaining), signal: deadline.signal });
        if (response.isError) throw new Error(response.content.filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0, 512));
        const value = response.structuredContent as Record<string, any>;
        if (!value) throw new Error('MCP result has no structured content');
        const json = JSON.stringify(value);
        // Full results guide the runner; only the event display is bounded.
        Object.assign(event, { type: 'tool_completed', status: 'completed',
          duration_ms: Math.round(performance.now() - before),
          result: json.length > 16000 ? { preview: json.slice(0, 16000), truncated: true } : value,
          result_truncated: json.length > 16000 });
        return value;
      } catch (error) {
        Object.assign(event, { type: 'tool_failed', status: 'failed', duration_ms: Math.round(performance.now() - before),
          error: error instanceof Error ? error.message.slice(0, 512) : 'Tool failed' });
        throw error;
      } finally { this.persist(run); }
    };
    try {
      if (this.remote) await client.connect(new StreamableHTTPClientTransport(new URL('https://news.bymyleslee.com/mcp'), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers); headers.set('x-world-news-traffic', 'inspection');
          return fetch(input, { ...init, headers, signal: deadline.signal });
        },
      }), { timeout: 10000, signal: deadline.signal });
      else { await server.connect(serverTransport); await client.connect(clientTransport, { timeout: 10000, signal: deadline.signal }); }
      this.event(run, { result: { message: run.cost.provider === 'rules'
        ? '저장 기록을 조회하는 규칙 기반 조사. 운영 변경과 모델 호출은 하지 않습니다.'
        : run.cost.provider === 'openai' ? 'OpenAI가 읽기 도구를 선택하는 저장 기록 조사. 통계와 분류는 코드로 검증하며 운영 변경은 제안만 합니다.'
          : '실제 MCP 조회 이후 Jev가 저장된 근거를 구조화 판정합니다. 코드 분류와 모델 판단을 구분하고 운영 변경은 제안만 합니다.' } });
      const remoteQuality = this.remote ? new RemoteQualityStore(call) : null;
      const overview = remoteQuality ? await remoteQuality.overview(run.date, run.country)
        : await call('get_country_collection_quality', { country: run.country, date: run.date, limit: 50 });
      const country = overview.items?.[0];
      const peerEvidence = [];
      if (this.remote) for (const country of ['US', 'KR', 'JP'].filter(c => c !== run.country)) {
        peerEvidence.push(await call('get_country_article_activity', { country, start_date: run.date, end_date: run.date, timezone: 'UTC', limit: 50 }));
      }
      this.event(run, { type: 'common_check', status: 'completed', result: {
        signal: overview.common_collector_signal ?? overview.common_signal ?? null,
        snapshot_at: overview.snapshot_at ?? null,
        peer_country_evidence: peerEvidence,
        assessment_scope: this.remote ? { countries: [run.country, ...peerEvidence.map(p => p.scope_id)], all_countries_checked: false } : 'all_catalog_countries',
        note: '여러 국가의 동시 하락 여부를 먼저 확인합니다. 완료 회차 증거가 없으면 공통 장애를 확정하지 않습니다.',
      } });
      const inventory = await call('get_country_source_inventory', { country: run.country, include_disabled: true, limit: 50 });
      if (run.cost.provider === 'openai') {
        const result = await runModelInvestigation({ country: run.country, date: run.date,
          overview: { ...overview, peer_country_evidence: peerEvidence }, inventory,
          policy: this.modelPolicy, sessionBudget: this.modelBudget, signal: deadline.signal,
          model: this.modelOptions?.createModel?.() ?? createPaidOpenAIModel(this.modelPolicy), call,
          readSource: id => remoteQuality ? remoteQuality.source(id, run.date)
            : call('get_source_collection_quality', { source_id: id, date: run.date }),
          onSource: detail => {
            run.inspected_sources++;
            for (const endpoint of detail.endpoints ?? []) run.findings.push({ source_id: detail.source.id,
              source_name: detail.source.name, endpoint_id: endpoint.endpoint_id, url: endpoint.url,
              classification: endpoint.classification, assessment: endpoint, cached_health: endpoint.health,
              evidence_scope: 'stored_records', live_failure_confirmed: false,
              proposed_action: this.recommendation(endpoint.classification), approval_required_for_changes: true });
          },
          onModel: observation => this.modelObservation(run, observation) }).catch(error => {
            const safe = error instanceof Error && /^[A-Z_]{5,80}$/.test(error.message) ? error.message : 'OPENAI_AGENT_RUN_FAILED';
            throw Error(safe);
          });
        run.model_assessment = { ...result.assessment, kind: 'model_proposal', independently_verified: false,
          proposal_validation: result.proposal_validation };
        this.event(run, { type: 'proposal_validation', status: result.proposal_validation.status,
          result: result.proposal_validation });
        run.available_sources = inventory.items?.[0]?.active_normalized_sources ?? null;
        run.truncated = (run.available_sources ?? 0) > run.inspected_sources;
        run.summary = `${run.country}: OpenAI가 저장 결과에 따라 다음 조회를 선택했습니다. 소스 ${run.inspected_sources}개를 확인했으며 모델 제안은 별도 검토가 필요합니다.`;
        if (result.proposal_validation.rejected_count) run.summary += ` 근거와 충돌한 제안 ${result.proposal_validation.rejected_count}개를 제외했으며 상세 기록 검토가 필요합니다.`;
        run.status = 'completed'; return;
      }
      const sources: Array<Record<string, any>> = [];
      let offset: number | null = 0;
      while (offset !== null && sources.length < 150) {
        const page = await call('search_sources', { country: run.country, enabled: true, offset, limit: 50 });
        sources.push(...page.items); run.available_sources = page.total; offset = page.next_offset;
      }
      const candidates: Array<Record<string, any>> = (country?.investigation_candidates ?? []).slice(0, run.limits.max_sources);
      const preferred = new Set(candidates.map(c => c.source_id));
      const candidateRank = new Map<string, number>();
      for (const [rank, candidate] of candidates.entries()) if (!candidateRank.has(candidate.source_id)) candidateRank.set(candidate.source_id, rank);
      const healthByEndpoint = new Map<string, Record<string, any>>();
      if (this.remote) {
        const ids = [...new Set(sources.flatMap(source => source.endpoints.map((e: any) => e.id)))].slice(0, 200);
        for (let i = 0; i < ids.length; i += 20) {
          let remaining = ids.slice(i, i + 20);
          while (remaining.length) {
            const result = await call('get_endpoint_health', { endpoint_ids: remaining });
            for (const endpoint of result.endpoints) healthByEndpoint.set(endpoint.endpoint_id, endpoint);
            const next: string[] = result.remaining_endpoint_ids ?? [];
            if (next.length >= remaining.length) { run.truncated = true; break; }
            remaining = next;
          }
        }
      }
      const risk = (source: Record<string, any>) => Math.max(0, ...source.endpoints.map((endpoint: any) => {
        const saved = healthByEndpoint.get(endpoint.id);
        return saved?.content_freshness === 'stale' ? 3 : saved?.last_outcome === 'unhealthy' ? 2 : saved?.status === 'unknown' ? 1 : 0;
      }));
      // A suggested source may lie beyond the bounded search page. Resolve its
      // ID with get_source rather than silently dropping the highest priority.
      for (const id of preferred) {
        if (sources.some(s => s.id === id)) continue;
        const detail = await call('get_source', { source_id: id });
        sources.push(detail);
      }
      const selected = [...sources].sort((a, b) => (candidateRank.get(a.id) ?? 1000) - (candidateRank.get(b.id) ?? 1000)
        || risk(b) - risk(a) || a.name.localeCompare(b.name)).slice(0, run.limits.max_sources);
      const inspectedDetails: Array<Record<string, any>> = [];
      for (const source of selected) {
        const detail = remoteQuality ? await remoteQuality.source(source.id, run.date)
          : await call('get_source_collection_quality', { source_id: source.id, date: run.date });
        run.inspected_sources++;
        inspectedDetails.push(detail);
        const endpointIds = source.endpoints.map((e: any) => e.id);
        const health = this.remote ? { endpoints: detail.endpoints.map((e: any) => e.health) }
          : endpointIds.length ? await call('get_endpoint_health', { endpoint_ids: endpointIds.slice(0, 20) }) : { endpoints: [] };
        for (const endpoint of detail.endpoints ?? []) {
          const classification = endpoint.classification ?? endpoint.assessment?.classification ?? 'insufficient_evidence';
          const cached = health.endpoints.find((e: any) => e.endpoint_id === (endpoint.endpoint_id ?? endpoint.id));
          run.findings.push({ source_id: source.id, source_name: source.name,
            endpoint_id: endpoint.endpoint_id ?? endpoint.id, url: endpoint.url, classification,
            assessment: endpoint.assessment ?? endpoint, cached_health: cached ?? null,
            evidence_scope: 'stored_records', live_failure_confirmed: false,
            proposed_action: this.recommendation(classification), approval_required_for_changes: true });
        }
      }
      if (run.cost.provider === 'jev') {
        const result = await runJevInvestigation({ country: run.country, date: run.date, sources: inspectedDetails,
          policy: this.jevModelPolicy, client: this.modelOptions?.createJevClient?.(this.modelBudget)
            ?? createPaidJevClient(this.jevModelPolicy, this.modelBudget), signal: deadline.signal,
          onModel: observation => this.modelObservation(run, observation) }).catch(error => {
            const safe = error instanceof Error && /^[A-Z_]{5,100}$/.test(error.message) ? error.message : 'JEV_CLASSIFIER_RUN_FAILED';
            throw Error(safe);
          });
        run.model_assessment = { ...result.assessment, decisions: result.decisions, scope: result.scope,
          kind: 'structured_evidence_classifier', independently_verified: false };
        if (result.scope.assessed_endpoints < result.scope.available_endpoints) {
          run.truncated = true; run.limit_reached = true;
        }
      }
      run.truncated ||= offset !== null || (run.available_sources ?? 0) > run.inspected_sources;
      run.summary = `${run.country}: 활성 소스 ${run.available_sources ?? inventory.items?.[0]?.active_normalized_sources ?? '?'}개 중 ${run.inspected_sources}개를 조사했습니다. 저장 기록 기반이며 현재 장애와 회복은 별도 실시간 확인이 필요합니다.`;
      run.status = 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Investigation failed';
      if (message === 'INVESTIGATION_LIMIT' || deadline.signal.aborted) {
        run.truncated = true; run.limit_reached = true;
        run.status = 'completed'; run.summary = '조사 한도에 도달했습니다. 조회한 범위의 근거만 제공하며 나머지 소스는 미조사 상태입니다.';
      } else {
        run.status = 'failed'; run.summary = message;
        this.event(run, { type: 'error', status: 'failed', error: message });
      }
    } finally {
      clearTimeout(timer);
      run.finished_at = new Date().toISOString();
      this.event(run, { type: 'finished', status: run.status, result: { summary: run.summary, cost: run.cost,
        duration_ms: Math.round(performance.now() - started), inspected_sources: run.inspected_sources, truncated: run.truncated } });
      await client.close().catch(() => {}); await server.close().catch(() => {});
    }
  }

  private recommendation(classification: string) {
    if (/regression|failure_after|interruption/.test(classification)) return '이전 정상 기록과 최근 실패를 대조하고, 승인된 제한 내 재검사로 현재 상태와 원인을 확인하세요.';
    if (/stale|old_content/.test(classification)) return '최신 콘텐츠 날짜와 공식 피드 안내를 확인하고, 공식 대체 주소를 검증한 뒤 변경안을 제안하세요.';
    if (/recover/.test(classification)) return '이후 성공 기록이 있으므로 이전 오류만으로 장애를 확정하지 말고 다음 수집에서 회복을 확인하세요.';
    if (/untracked|uninitialized|insufficient|unknown|gap/.test(classification)) return '추적 초기화와 검사 성공 여부를 확인하세요. 과거 정상 증거 없이 수집 중단으로 분류하지 마세요.';
    return '검사 성공과 신규 URL 수를 구분해 관찰하세요. 0건만으로 변경을 제안하지 않습니다.';
  }
}
