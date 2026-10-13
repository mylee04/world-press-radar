import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_INPUT_USD_PER_MILLION = .042;
export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export type JevPolicy = { authorized: boolean; model: string; keyFile: string | null;
  totalBudgetUsd: number; perRunBudgetUsd: number; inputUsdPerMillion: number;
  maxModelCalls: number; maxInputBytes: number; timeoutMs: number };
const nonnegative = (value?: string) => value && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function jevPolicy(env: NodeJS.ProcessEnv = process.env): JevPolicy {
  return { authorized: env.WNS_JEV_PAID_APPROVED === '1', model: env.WNS_JEV_MODEL || JEV_MODEL,
    keyFile: env.WNS_JEV_KEY_FILE || null,
    totalBudgetUsd: nonnegative(env.WNS_JEV_TOTAL_BUDGET_USD) ?? 0,
    perRunBudgetUsd: nonnegative(env.WNS_JEV_RUN_BUDGET_USD) ?? 0,
    inputUsdPerMillion: nonnegative(env.WNS_JEV_INPUT_USD_PER_MILLION) ?? JEV_INPUT_USD_PER_MILLION,
    maxModelCalls: 12, maxInputBytes: 24000, timeoutMs: 20000 };
}
export function jevReadiness(policy: JevPolicy, env: NodeJS.ProcessEnv = process.env) {
  const present = policy.keyFile ? existsSync(policy.keyFile) : !!env.TYPESAFE_API_KEY;
  const ready = policy.authorized && present && policy.model === JEV_MODEL && policy.totalBudgetUsd > 0
    && policy.perRunBudgetUsd > 0 && policy.inputUsdPerMillion > 0;
  return { available: ready, model: policy.model, key_source_present: present, key_validity_verified: false,
    paid_execution_approved: policy.authorized, total_budget_usd: policy.totalBudgetUsd, per_run_budget_usd: policy.perRunBudgetUsd,
    reason: !policy.authorized || policy.totalBudgetUsd <= 0 || policy.perRunBudgetUsd <= 0 ? 'paid_test_budget_not_approved'
      : !present ? 'typesafe_key_not_configured' : policy.model !== JEV_MODEL ? 'priced_model_not_supported' : !ready ? 'pricing_not_configured' : null,
    billing_cost_available: false, price_basis: 'TypeSafe published input-token rate; output free; estimate is not a billing receipt.',
    limits: { model_calls: policy.maxModelCalls, input_bytes: policy.maxInputBytes, retries: 0 },
    role: 'structured_evidence_classifier', language_validation: 'English primary; evaluate Korean/Japanese separately before routing.' };
}
function validKey(value: string) {
  return value.length >= 10 && value.length <= 4096 && /^[A-Za-z0-9._-]+$/.test(value)
    && !/placeholder|your[_-]?(api)?[_-]?key|changeme/i.test(value);
}
export function readJevKey(policy: JevPolicy, env: NodeJS.ProcessEnv = process.env) {
  if (!jevReadiness(policy, env).available) throw Error('JEV_EXECUTION_NOT_AUTHORIZED');
  let value: string | undefined;
  if (policy.keyFile) {
    try {
      const info = lstatSync(policy.keyFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error();
      const values = readFileSync(policy.keyFile, 'utf8').split(/\r?\n/).flatMap(line => {
        const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
        return match ? [match[1].replace(/^(['"])(.*)\1$/, '$2').trim()] : [];
      });
      if (values.length !== 1) throw Error(); value = values[0];
    } catch { throw Error('JEV_KEY_SOURCE_UNAVAILABLE'); }
  } else value = env.TYPESAFE_API_KEY;
  if (!value || !validKey(value)) throw Error('JEV_KEY_SOURCE_INVALID');
  return value;
}
export class JevSessionBudget {
  private heldUsd = 0;
  constructor(readonly limitUsd: number) {}
  reserve(upperBoundUsd: number) {
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0 || this.heldUsd + upperBoundUsd > this.limitUsd + 1e-12)
      throw Error('JEV_SESSION_BUDGET_LIMIT');
    this.heldUsd += upperBoundUsd; return { upperBoundUsd, settled: false };
  }
  settle(reservation: { upperBoundUsd: number; settled: boolean }, estimate: number) {
    if (reservation.settled || !Number.isFinite(estimate) || estimate < 0) throw Error('JEV_USAGE_COST_UNKNOWN');
    reservation.settled = true; this.heldUsd += estimate - reservation.upperBoundUsd;
    if (estimate > reservation.upperBoundUsd + 1e-12) throw Error('JEV_COST_BOUND_EXCEEDED');
  }
  summary() { return { authorization_limit_usd: this.limitUsd, estimated_or_reserved_usd: this.heldUsd,
    remaining_usd: Math.max(0, this.limitUsd - this.heldUsd), persistence: 'current_process_only' }; }
}
export type JevBudget = Pick<JevSessionBudget, 'reserve' | 'settle' | 'summary'>;
export type JevChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type JevChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type JevObservation = { type: string; status: string; at: string; model: string; duration_ms?: number;
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: null };
  estimated_cost_usd?: number | null; error?: string; http_status?: number | null; cost_basis?: string };
const responseSchema = z.object({ model: z.string(), answers: z.record(z.string(), z.object({
  type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
})), usage: z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() }) });
export class JevClient {
  private calls = 0; private heldRunUsd = 0;
  constructor(readonly policy: JevPolicy, private apiKey: string, readonly budget: JevBudget,
    private fetcher: typeof fetch = fetch) {}
  async evaluate(state: unknown, questions: Record<string, JevChoiceQuestion>, options: {
    signal?: AbortSignal; onModel?: (event: JevObservation) => void } = {}) {
    const emit = (event: Omit<JevObservation, 'at' | 'model'>) => options.onModel?.({ ...event, at: new Date().toISOString(), model: this.policy.model });
    if (options.signal?.aborted) throw Error('JEV_RUN_CANCELLED');
    if (this.policy.model !== JEV_MODEL || !(this.policy.inputUsdPerMillion > 0)) throw Error('JEV_PRICED_MODEL_REQUIRED');
    if (this.calls >= this.policy.maxModelCalls) throw Error('JEV_MODEL_CALL_LIMIT');
    if (!Object.keys(questions).length || Object.keys(questions).length > 40 || Object.values(questions).some(question =>
      question.type !== 'choice' || !question.instructions || !Object.keys(question.criteria).length || Object.keys(question.criteria).length > 255))
      throw Error('JEV_QUESTION_INVALID');
    const body = JSON.stringify({ model: this.policy.model, state, questions }), bytes = Buffer.byteLength(body);
    if (bytes > this.policy.maxInputBytes) throw Error('JEV_CONTEXT_LIMIT');
    // A conservative UTF-8 byte/token bound plus protocol overhead; no SDK retry can duplicate spend.
    const upperBoundUsd = (bytes + 4096) * 2 * this.policy.inputUsdPerMillion / 1e6;
    if (this.heldRunUsd + upperBoundUsd > this.policy.perRunBudgetUsd + 1e-12) throw Error('JEV_RUN_BUDGET_LIMIT');
    const reservation = this.budget.reserve(upperBoundUsd); this.heldRunUsd += upperBoundUsd; this.calls++;
    const started = performance.now(); emit({ type: 'model_started', status: 'running' });
    let settled = false, usage: { input_tokens: number; output_tokens: number; cached_input_tokens: null } | undefined;
    let estimate: number | undefined;
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.policy.timeoutMs)]) : AbortSignal.timeout(this.policy.timeoutMs);
      const response = await this.fetcher(JEV_API_URL, { method: 'POST', headers: {
        Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error' });
      if (!response.ok) { const failure = Error('JEV_MODEL_REQUEST_FAILED') as Error & { status?: number }; failure.status = response.status; throw failure; }
      const text = await response.text(); if (Buffer.byteLength(text) > 262144) throw Error('JEV_RESPONSE_LIMIT');
      let parsed;
      try { parsed = responseSchema.parse(JSON.parse(text)); } catch { throw Error('JEV_RESPONSE_INVALID_OR_USAGE_MISSING'); }
      if (parsed.model !== this.policy.model) throw Error('JEV_PRICED_MODEL_MISMATCH');
      usage = { ...parsed.usage, cached_input_tokens: null };
      estimate = usage.input_tokens * this.policy.inputUsdPerMillion / 1e6;
      this.budget.settle(reservation, estimate); this.heldRunUsd += estimate - upperBoundUsd; settled = true;
      if (Object.keys(parsed.answers).length !== Object.keys(questions).length) throw Error('JEV_ANSWER_SET_MISMATCH');
      for (const [id, question] of Object.entries(questions)) {
        const answer = parsed.answers[id], keys = Object.keys(question.criteria);
        if (!answer || !keys.includes(answer.choice) || Object.keys(answer.probabilities).length !== keys.length
          || keys.some(key => !Object.hasOwn(answer.probabilities, key))
          // Jev returns probabilities rounded to two decimal places. Preserve them as reported.
          || Math.abs(Object.values(answer.probabilities).reduce((n, value) => n + value, 0) - 1) > .005 * keys.length + 1e-8
          || Object.values(answer.probabilities).some(value => value > answer.probabilities[answer.choice] + 1e-8))
          throw Error('JEV_PROBABILITY_CONTRACT_INVALID');
      }
      const duration = Math.round(performance.now() - started);
      emit({ type: 'model_completed', status: 'completed', duration_ms: duration, usage, estimated_cost_usd: estimate,
        cost_basis: 'reported_input_usage_times_configured_rate; output_free; not_billing_receipt' });
      return { model: parsed.model, answers: parsed.answers, usage, duration_ms: duration, estimated_cost_usd: estimate,
        billing_cost_usd: null, cost_basis: 'reported_input_usage_times_configured_rate; output_free; not_billing_receipt' };
    } catch (error) {
      const code = error instanceof Error && /^JEV_[A-Z_]+$/.test(error.message) ? error.message : 'JEV_MODEL_REQUEST_FAILED';
      emit({ type: 'model_failed', status: 'failed', duration_ms: Math.round(performance.now() - started), error: code,
        http_status: typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : null,
        ...(usage ? { usage } : {}), estimated_cost_usd: settled ? estimate : null,
        cost_basis: settled ? 'reported_usage; invalid_decision; not_billing_receipt' : 'unknown; conservative_reservation_retained' });
      throw Error(code);
    }
  }
}
export function createPaidJevClient(policy: JevPolicy, budget: JevBudget = new JevSessionBudget(policy.totalBudgetUsd)) {
  return new JevClient(policy, readJevKey(policy), budget);
}
