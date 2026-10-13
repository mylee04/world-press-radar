import { Agent, Runner, setSensitiveDataLoggingEnabled, type Model, type ModelRequest } from '@openai/agents';
import { type OpenAIPolicy, OpenAISessionBudget } from './openai-runtime.js';
import { classificationCriteria, classificationInstructions, confirmationInstructions, qualityDecisionSchema } from './quality-decision.js';
type Row = Record<string, any>;
type Budget = Pick<OpenAISessionBudget, 'reserve' | 'settle' | 'summary'>;
export type OpenAIEvaluationObservation = { type: string; status: string; at: string; model: string;
  duration_ms?: number; usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number | null };
  estimated_cost_usd?: number | null; http_status?: number | null; error?: string };

/** One schema-constrained classification call per fixed case, using the same raw facts/rubric as Jev. */
export class OpenAIQualityEvaluator {
  private calls = 0; private heldRunUsd = 0;
  constructor(readonly policy: OpenAIPolicy, private model: Model, readonly budget: Budget,
    private onModel?: (event: OpenAIEvaluationObservation) => void) {}
  async classify(evidence: unknown, options: { signal?: AbortSignal; onModel?: (event: OpenAIEvaluationObservation) => void } = {}) {
    const signal = options.signal ?? AbortSignal.timeout(25000), start = performance.now();
    let observed: { usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number | null }; estimate: number } | undefined;
    const emit = (event: Omit<OpenAIEvaluationObservation, 'at' | 'model'>) => {
      const value = { ...event, at: new Date().toISOString(), model: this.policy.model ?? 'unknown' };
      this.onModel?.(value); options.onModel?.(value);
    };
    const guarded: Model = {
      getResponse: async (request: ModelRequest) => {
        if (signal.aborted) throw Error('OPENAI_RUN_CANCELLED');
        if (this.calls >= this.policy.maxModelCalls) throw Error('OPENAI_MODEL_CALL_LIMIT');
        if (request.previousResponseId || request.conversationId) throw Error('OPENAI_UNBOUNDED_SERVER_CONTEXT');
        if (this.policy.inputUsdPerMillion === null || this.policy.outputUsdPerMillion === null) throw Error('OPENAI_PRICING_REQUIRED');
        const bytes = Buffer.byteLength(JSON.stringify({ input: request.input, instructions: request.systemInstructions,
          output: request.outputType }));
        if (bytes > this.policy.maxInputBytes) throw Error('OPENAI_CONTEXT_LIMIT');
        const upper = ((bytes + 4096) * this.policy.inputUsdPerMillion * 2
          + this.policy.maxOutputTokens * this.policy.outputUsdPerMillion * 1.5) / 1e6;
        if (this.heldRunUsd + upper > this.policy.perRunBudgetUsd + 1e-12) throw Error('OPENAI_RUN_BUDGET_LIMIT');
        const reservation = this.budget.reserve(upper); this.heldRunUsd += upper; this.calls++;
        emit({ type: 'model_started', status: 'running' });
        const requestStart = performance.now();
        try {
          const response = await this.model.getResponse({ ...request, signal, tracing: false,
            modelSettings: { ...request.modelSettings, store: false, preserveRawUsage: true,
              maxTokens: this.policy.maxOutputTokens, parallelToolCalls: false, retry: { maxRetries: 0 } } });
          const raw = response.rawUsage, served = response.providerData?.model;
          if (served && served !== this.policy.model && !String(served).startsWith(`${this.policy.model}-`)) throw Error('OPENAI_PRICED_MODEL_MISMATCH');
          if (!raw || !Number.isSafeInteger(raw.input_tokens) || !Number.isSafeInteger(raw.output_tokens)
            || Number(raw.input_tokens) < 0 || Number(raw.output_tokens) < 0) throw Error('OPENAI_USAGE_MISSING');
          const usage = { input_tokens: Number(raw.input_tokens), output_tokens: Number(raw.output_tokens),
            cached_input_tokens: typeof (raw.input_tokens_details as Row)?.cached_tokens === 'number'
              ? (raw.input_tokens_details as Row).cached_tokens : null };
          const estimate = (usage.input_tokens * this.policy.inputUsdPerMillion + usage.output_tokens * this.policy.outputUsdPerMillion) / 1e6;
          this.budget.settle(reservation, estimate); this.heldRunUsd += estimate - upper; observed = { usage, estimate };
          emit({ type: 'model_completed', status: 'completed', duration_ms: Math.round(performance.now() - requestStart),
            usage, estimated_cost_usd: estimate });
          return { ...response, responseId: undefined };
        } catch (error) {
          const code = error instanceof Error && /^OPENAI_[A-Z_]+$/.test(error.message) ? error.message : 'OPENAI_MODEL_REQUEST_FAILED';
          emit({ type: 'model_failed', status: 'failed', duration_ms: Math.round(performance.now() - requestStart),
            error: code, estimated_cost_usd: null, http_status: typeof (error as Row)?.status === 'number' ? (error as Row).status : null });
          throw Error(code);
        }
      }, async *getStreamedResponse() { throw Error('OPENAI_STREAMING_NOT_ENABLED'); },
    };
    const agent = new Agent({ name: 'Fixed Case Quality Classifier', model: guarded, tools: [], outputType: qualityDecisionSchema,
      instructions: `${classificationInstructions}\nRubric: ${JSON.stringify(classificationCriteria)}\n${confirmationInstructions}\nReturn only the two schema fields. No explanation or private reasoning.` });
    setSensitiveDataLoggingEnabled(false);
    const runner = new Runner({ model: guarded, tracingDisabled: true, traceIncludeSensitiveData: false,
      modelSettings: { store: false, maxTokens: this.policy.maxOutputTokens, preserveRawUsage: true,
        reasoning: { effort: 'low', summary: null }, retry: { maxRetries: 0 } } });
    const run = await runner.run(agent, JSON.stringify(evidence), { maxTurns: 1, signal });
    const decision = qualityDecisionSchema.parse(run.finalOutput);
    if (!observed) throw Error('OPENAI_USAGE_MISSING');
    return { decision, model: this.policy.model, usage: observed.usage, estimated_cost_usd: observed.estimate,
      duration_ms: Math.round(performance.now() - start), billing_cost_usd: null,
      cost_basis: 'reported_usage_times_configured_uncached_rates; not_billing_receipt' };
  }
}
