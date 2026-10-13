import { classificationCriteria, classificationInstructions, confirmationInstructions, decisionEvidence, qualityDecisionSchema } from './quality-decision.js';
import { type JevClient, type JevPolicy, type JevObservation } from './jev-runtime.js';
type Row = Record<string, any>;
export const qualityChoiceQuestions = {
  classification: { type: 'choice' as const, instructions: classificationInstructions, criteria: classificationCriteria },
  confirmation: { type: 'choice' as const, instructions: confirmationInstructions,
    criteria: { yes: 'A bounded live check is needed for a saved failure/access failure/stale-content finding.',
      no: 'Successful/recovered/index-only evidence or unavailable tracking/date/attempt does not establish a failure finding.' } },
};
export async function classifyWithJev(client: JevClient, evidence: unknown, options: {
  signal?: AbortSignal; onModel?: (event: JevObservation) => void } = {}) {
  const result = await client.evaluate(evidence, qualityChoiceQuestions, options);
  const decision = qualityDecisionSchema.parse({ classification: result.answers.classification.choice,
    requires_live_confirmation: result.answers.confirmation.choice === 'yes' });
  return { decision, confidence: result.answers.classification.confidence,
    probabilities: result.answers.classification.probabilities, confirmation_confidence: result.answers.confirmation.confidence,
    model: result.model, usage: result.usage, duration_ms: result.duration_ms,
    estimated_cost_usd: result.estimated_cost_usd, billing_cost_usd: null, cost_basis: result.cost_basis };
}
const actionFor = (state: string) => state === 'failure_after_prior_success' || state === 'access_failure_without_normal_baseline'
  ? 'investigate_failure' : state === 'stale_content_evidence' ? 'check_official_alternative'
  : state === 'recovered_after_failure' ? 'observe_recovery'
  : ['untracked_or_no_available_checks', 'not_attempted_in_period', 'insufficient_evidence'].includes(state)
    ? 'initialize_tracking' : 'no_change';
const reasonFor: Record<string, string> = { investigate_failure: '검사 실패와 이전 정상 기록을 대조한 뒤 현재 접근 상태를 확인합니다.',
  check_official_alternative: '저장된 콘텐츠 날짜와 공식 대체 주소를 확인합니다.', observe_recovery: '더 최근 성공 기록 이후에도 회복이 유지되는지 확인합니다.',
  initialize_tracking: '추적·검사 이력을 확보한 뒤 판단합니다.', no_change: '저장된 근거에서 수정이 필요한 장애를 확인하지 못했습니다.' };

/** Jev is a narrow decision stage after actual MCP reads; it neither fakes tools nor overrides code evidence. */
export async function runJevInvestigation(options: { country: string; date: string; sources: Row[];
  policy: JevPolicy; client: JevClient; signal: AbortSignal; onModel: (event: JevObservation) => void }) {
  const decisions: Row[] = [], proposed = new Map<string, Row>();
  let estimate = 0, input = 0, output = 0, calls = 0;
  const selected = options.sources.slice(0, 12);
  const inspectedSources = new Set<string>();
  const priority: Record<string, number> = { investigate_failure: 1, check_official_alternative: 2,
    confirm_freshness: 3, initialize_tracking: 4, observe_recovery: 5, no_change: 6 };
  for (const detail of selected) {
    if (detail.source?.country !== options.country || detail.date !== options.date) throw Error('JEV_SOURCE_SCOPE_MISMATCH');
    for (const endpoint of detail.endpoints ?? []) {
    if (calls >= Math.min(12, options.policy.maxModelCalls)) break;
    const result = await classifyWithJev(options.client, { ...decisionEvidence(detail, endpoint),
      endpoint_attribution: detail.endpoints.length === 1 ? 'single_endpoint_source' : 'multiple_endpoints; source_discoveries_not_attributable',
      multiple_endpoint_source: detail.endpoints.length !== 1 }, { signal: options.signal, onModel: options.onModel });
    calls++; estimate += result.estimated_cost_usd; input += result.usage.input_tokens; output += result.usage.output_tokens;
    const evidenceClass = endpoint.classification ?? 'insufficient_evidence';
    const classificationAgrees = result.decision.classification === evidenceClass
      || result.decision.classification === 'insufficient_evidence' && evidenceClass === 'insufficient_endpoint_history';
    const agrees = classificationAgrees && (typeof endpoint.requires_live_confirmation !== 'boolean'
      || result.decision.requires_live_confirmation === endpoint.requires_live_confirmation);
    const confidenceSufficient = result.confidence >= .8 && result.confirmation_confidence >= .8;
    inspectedSources.add(detail.source.id);
    decisions.push({ source_id: detail.source.id, endpoint_id: endpoint.endpoint_id ?? endpoint.id,
      ...result.decision, confidence: result.confidence, confirmation_confidence: result.confirmation_confidence, probabilities: result.probabilities,
      agrees_with_code_evidence: agrees, requires_review: !agrees || !confidenceSufficient,
      verification: 'saved_evidence_only; current_live_state_not_verified' });
    // Conflicting/low-confidence model choices are review observations, never operational actions.
    const action = agrees && confidenceSufficient ? actionFor(evidenceClass) : 'confirm_freshness';
    if (!proposed.has(detail.source.id) || priority[action] < priority[proposed.get(detail.source.id)!.action]) {
      proposed.set(detail.source.id, { source_id: detail.source.id, action,
        reason: agrees && confidenceSufficient ? reasonFor[action] : '모델 판정과 코드 근거가 다르거나 확신이 낮아 추가 근거를 확인합니다.' });
    }
    }
  }
  return { assessment: { summary: `${inspectedSources.size}개 소스, ${decisions.length}개 주소의 저장된 근거를 Jev로 판정했습니다. 운영 변경은 적용하지 않았습니다.`,
    proposed_steps: [...proposed.values()] }, decisions, model_calls: calls, inspected_sources: inspectedSources.size,
    input_tokens: input, output_tokens: output, estimated_cost_usd: estimate, billing_cost_usd: null,
    cost_basis: 'reported_input_usage_times_configured_rate; output_free; not_billing_receipt',
    scope: { selected_sources: selected.length, available_sources: options.sources.length,
      assessed_endpoints: decisions.length, available_endpoints: options.sources.reduce((n, source) => n + (source.endpoints?.length ?? 0), 0),
      endpoint_scope: 'at most twelve observed endpoints; additional endpoints remain unassessed' } };
}
