import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse } from 'promptfoo';
import { BudgetLedger } from './budget.js';
import type { Task, Tariff } from './schema.js';
import type { CallRecord, Scenario } from './types.js';
import { modeledCost, normalizeMockUsage, upperBound } from './usage.js';
import type { MockUsage } from './usage.js';
import { appendJsonl } from './storage.js';

export const modelId = 'mock-practical-v1';
export const responsesSchema = z.record(z.string(), z.strictObject({ correct: z.string().min(1), incorrect: z.string().min(1) }));
export type Responses = z.infer<typeof responsesSchema>;
export type ProviderAttemptMetadata = { status: 'ok' | 'budget_exhausted' | 'technical_error' | 'limit_exceeded'; reason: string; callIds: string[] };

export function useCorrectResponse(taskId: string, scenario: Scenario, index: number): boolean {
  if (scenario === 'current') return !(taskId === 'faq-disclosure' && index === 2);
  return !['contact-form', 'pagination', 'maintenance-notice', 'translation-en'].includes(taskId)
    && !(index === 2 && ['translation-ru', 'dashboard-layout'].includes(taskId));
}

export function mockUsage(taskId: string, index: number): { raw: MockUsage; delivery: 'fresh' | 'local_cache' } {
  const raw: MockUsage = { inputTokens: 180, outputTokens: 120, reasoningTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (taskId === 'faq-disclosure') raw.cacheReadTokens = 80;
  if (taskId === 'maintenance-notice' && index === 2) raw.cacheWriteTokens = 50;
  if (taskId === 'translation-ru' && index === 1) raw.outputTokens = null;
  if (taskId === 'dashboard-layout' && index === 2) return { raw: {}, delivery: 'fresh' };
  if (taskId === 'pricing-layout' && index === 2) return {
    raw: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, delivery: 'fresh',
  };
  return { raw, delivery: taskId === 'release-notes' && index === 2 ? 'local_cache' : 'fresh' };
}

export class MockProvider implements ApiProvider {
  readonly calls: CallRecord[] = [];
  wireCallCount = 0;
  private readonly visited = new Set<string>();
  constructor(
    private readonly runId: string,
    private readonly scenario: Scenario,
    private readonly tasks: Task[],
    private readonly responses: Responses,
    private readonly tariff: Tariff,
    private readonly ledger: BudgetLedger,
    private readonly dir: string,
  ) {}
  id(): string { return 'local-mock'; }
  toJSON(): { id: string; label: string } { return { id: this.id(), label: modelId }; }

  async callApi(prompt: string, context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    const taskId = String(context?.vars.taskId ?? '');
    const index = Number(context?.vars.attemptIndex);
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || !Number.isInteger(index) || index < 1 || index > task.limits.attempts) throw new Error('Неверный контекст mock provider');
    const attemptId = `${task.id}-a${index}`;
    if (this.visited.has(attemptId)) throw new Error('Движок повторно отправил ту же попытку');
    this.visited.add(attemptId);
    const response = this.responses[taskId];
    if (!response) throw new Error(`Нет mock-ответа: ${taskId}`);
    const metadata: ProviderAttemptMetadata = { status: 'ok', reason: '', callIds: [] };
    if (options?.abortSignal?.aborted || Buffer.byteLength(prompt, 'utf8') > task.limits.maxInputTokens) {
      metadata.status = 'limit_exceeded'; metadata.reason = 'Остановка или консервативная оценка входа превышает лимит';
      return { error: metadata.reason, metadata };
    }
    const fixture = mockUsage(taskId, index);
    const bound = fixture.delivery === 'local_cache' ? { perCallUsd: 0, attemptUsd: 0 } : upperBound(task, this.tariff);
    const decision = this.ledger.reserve(this.runId, taskId, bound, new Date());
    if (!decision.allowed) {
      metadata.status = 'budget_exhausted'; metadata.reason = decision.reason;
      return { error: `budget_exhausted: ${decision.reason}`, metadata };
    }
    const started = performance.now();
    try {
      for (let retryIndex = 0; retryIndex <= task.limits.maxRetries; retryIndex++) {
        const callStarted = performance.now();
        const callStartedAt = new Date().toISOString();
        if (retryIndex >= task.limits.maxCalls || retryIndex >= task.limits.maxSteps || options?.abortSignal?.aborted || performance.now() - started > task.limits.timeoutMs) {
          metadata.status = 'limit_exceeded'; metadata.reason = 'Лимит вызовов/шагов/времени или отмена';
          return { error: metadata.reason, metadata };
        }
        // Единственная разрешённая техническая ошибка в сценарии: временная недоступность.
        const technicalError = taskId === 'validation-error' && index === 1 && retryIndex === 0;
        const raw = technicalError ? { inputTokens: 30, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : fixture.raw;
        const delivery = technicalError ? 'fresh' : fixture.delivery;
        const usage = normalizeMockUsage(raw, delivery);
        const limited = (usage.inputTotal ?? 0) > task.limits.maxInputTokens || (usage.outputTotal ?? 0) > task.limits.maxOutputTokens;
        const output = technicalError ? 'mock_temporary_unavailable' : useCorrectResponse(taskId, this.scenario, index) ? response.correct : response.incorrect;
        if (delivery === 'fresh') this.wireCallCount++;
        const artifact = `responses/${attemptId}-call-${retryIndex + 1}.txt`;
        writeFileSync(join(this.dir, artifact), output, { flag: 'wx' });
        const record: CallRecord = {
          runId: this.runId, taskId, attemptId, callId: `${this.runId}/${attemptId}/call-${retryIndex + 1}`,
          primaryCategory: task.primaryCategory, role: 'candidate', provider: 'local-mock',
          requestedModel: modelId, returnedModel: technicalError ? null : `${modelId}/fixture-1`, retryIndex,
          status: technicalError ? 'technical_error' : limited ? 'limit_exceeded' : 'ok',
          error: technicalError ? 'mock_temporary_unavailable' : limited ? 'token_limit' : null,
          rawUsage: raw, usage, historicalUsage: delivery === 'local_cache' ? normalizeMockUsage(raw) : null,
          delivery, tariff: this.tariff, modeledCostUsd: modeledCost(usage, this.tariff, delivery), incurredCostUsd: 0,
          costMethod: delivery === 'local_cache' ? 'local-cache' : 'synthetic-token-tariff',
          startedAt: callStartedAt, elapsedMs: Math.max(0, performance.now() - callStarted),
          apiRequests: 0, simulatedRequests: delivery === 'fresh' ? 1 : 0, parameters: task.limits, artifacts: [artifact],
        };
        appendJsonl(join(this.dir, 'calls.jsonl'), record);
        this.calls.push(record);
        metadata.callIds.push(record.callId);
        this.ledger.charge(decision.reservationId, record.modeledCostUsd);
        if (technicalError) {
          if (retryIndex < task.limits.maxRetries) continue;
          metadata.status = 'technical_error'; metadata.reason = record.error!;
          return { error: record.error!, metadata };
        }
        if (limited) {
          metadata.status = 'limit_exceeded'; metadata.reason = 'Лимит токенов';
          return { error: metadata.reason, metadata };
        }
        // promptfoo получает только известные счётчики; наш calls.jsonl — источник учёта.
        const attemptCalls = this.calls.filter((c) => c.attemptId === attemptId);
        const sum = (key: 'inputTotal' | 'outputTotal' | 'total') => attemptCalls.every((c) => c.usage[key] !== null)
          ? attemptCalls.reduce((s, c) => s + c.usage[key]!, 0) : undefined;
        return { output, cost: 0, cached: delivery === 'local_cache', metadata,
          tokenUsage: { prompt: sum('inputTotal'), completion: sum('outputTotal'), total: sum('total') } };
      }
      throw new Error('Не достигнуто завершение попытки');
    } catch (error) {
      this.ledger.charge(decision.reservationId, null);
      throw error;
    } finally { this.ledger.finish(decision.reservationId); }
  }
}
