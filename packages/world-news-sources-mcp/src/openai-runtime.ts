import { readFileSync, lstatSync, existsSync } from 'node:fs';
import OpenAI from 'openai';
import { OpenAIResponsesModel, type Model } from '@openai/agents';

export type OpenAIPolicy = {
  authorized: boolean; model: string | null; keyFile: string | null;
  totalBudgetUsd: number; perRunBudgetUsd: number; inputUsdPerMillion: number | null; outputUsdPerMillion: number | null;
  maxModelCalls: number; maxInputBytes: number; maxOutputTokens: number;
};
const nonnegative = (value?: string) => value && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function openAIPolicy(env: NodeJS.ProcessEnv = process.env): OpenAIPolicy {
  return { authorized: env.WNS_OPENAI_PAID_APPROVED === '1',
    model: env.WNS_OPENAI_MODEL?.trim() || null, keyFile: env.WNS_OPENAI_KEY_FILE || null,
    totalBudgetUsd: nonnegative(env.WNS_OPENAI_TOTAL_BUDGET_USD) ?? 0,
    perRunBudgetUsd: nonnegative(env.WNS_OPENAI_RUN_BUDGET_USD) ?? 0,
    inputUsdPerMillion: nonnegative(env.WNS_OPENAI_INPUT_USD_PER_MILLION),
    outputUsdPerMillion: nonnegative(env.WNS_OPENAI_OUTPUT_USD_PER_MILLION),
    maxModelCalls: 4, maxInputBytes: 48000, maxOutputTokens: 800 };
}
export function openAIReadiness(policy: OpenAIPolicy) {
  // Presence only. A preview does not read a key, validate it, or contact OpenAI.
  const keySourcePresent = !!policy.keyFile && existsSync(policy.keyFile);
  const ready = policy.authorized && keySourcePresent && !!policy.model && policy.totalBudgetUsd > 0
    && policy.perRunBudgetUsd > 0 && policy.inputUsdPerMillion !== null && policy.outputUsdPerMillion !== null;
  return { available: ready, key_source_present: keySourcePresent, key_validity_verified: false,
    paid_execution_approved: policy.authorized, model: policy.model,
    reason: !policy.authorized || policy.totalBudgetUsd <= 0 || policy.perRunBudgetUsd <= 0 ? 'paid_test_budget_not_approved'
      : !keySourcePresent ? 'reused_key_source_not_configured' : !policy.model ? 'model_not_selected'
      : !ready ? 'pricing_not_configured' : null,
    total_budget_usd: policy.totalBudgetUsd, per_run_budget_usd: policy.perRunBudgetUsd,
    limits: { model_calls: policy.maxModelCalls, input_bytes: policy.maxInputBytes, output_tokens_per_call: policy.maxOutputTokens },
    billing_cost_available: false, price_basis: 'Operator-approved rates; reported token usage yields an estimate, not a billing receipt.' };
}
export function readReusedKey(path: string): string {
  let text: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error();
    text = readFileSync(path, 'utf8');
  } catch { throw Error('OPENAI_KEY_SOURCE_UNAVAILABLE'); }
  const values = text.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    return match ? [match[1].replace(/^(['"])(.*)\1$/, '$2').trim()] : [];
  });
  if (values.length !== 1 || !/^sk-[A-Za-z0-9_-]{10,}$/.test(values[0])) throw Error('OPENAI_KEY_SOURCE_INVALID');
  return values[0];
}
export function createPaidOpenAIModel(policy: OpenAIPolicy): Model {
  if (!openAIReadiness(policy).available) throw Error('OPENAI_EXECUTION_NOT_AUTHORIZED');
  // Explicit client: no global environment mutation, no tracing key, no saved secret.
  const client = new OpenAI({ apiKey: readReusedKey(policy.keyFile!), baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    timeout: 20000 });
  return new OpenAIResponsesModel(client, policy.model!);
}

/** Process-local authorization budget shared across runs, including concurrent requests. */
export class OpenAISessionBudget {
  private heldOrEstimatedUsd = 0;
  constructor(readonly limitUsd: number) {}
  reserve(upperBoundUsd: number) {
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0
      || this.heldOrEstimatedUsd + upperBoundUsd > this.limitUsd + 1e-12) throw Error('OPENAI_SESSION_BUDGET_LIMIT');
    this.heldOrEstimatedUsd += upperBoundUsd;
    return { upperBoundUsd, settled: false };
  }
  settle(reservation: { upperBoundUsd: number; settled: boolean }, usageEstimateUsd: number) {
    if (reservation.settled) throw Error('OPENAI_BUDGET_ALREADY_SETTLED');
    if (!Number.isFinite(usageEstimateUsd) || usageEstimateUsd < 0) throw Error('OPENAI_USAGE_COST_UNKNOWN');
    reservation.settled = true;
    this.heldOrEstimatedUsd += usageEstimateUsd - reservation.upperBoundUsd;
    if (usageEstimateUsd > reservation.upperBoundUsd + 1e-12) throw Error('OPENAI_COST_BOUND_EXCEEDED');
  }
  summary() { return { authorization_limit_usd: this.limitUsd, estimated_or_reserved_usd: this.heldOrEstimatedUsd,
    remaining_usd: Math.max(0, this.limitUsd - this.heldOrEstimatedUsd), persistence: 'current_process_only' }; }
}
