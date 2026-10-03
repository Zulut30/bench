import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from './budget.js';
import type { Task } from './schema.js';
import type { AttemptStatus, CallRecord } from './types.js';
import { appendJsonl, writeJson } from './storage.js';
import { billingMode, effectiveGeneration } from './connections/config.js';
import type { RunConfig } from './connections/config.js';
import type { ConnectionRequest, ConnectionResult, Diagnostic, ModelConnection } from './connections/types.js';
import { modeledCost } from './usage.js';
import { emptyResult } from './connections/parsers.js';
import { redact } from './connections/process.js';

export interface Execution { status: 'ok' | Exclude<AttemptStatus, 'passed' | 'failed' | 'pending'>; reason: string; callIds: string[]; output: string | null; }
export class CallExecutor {
  readonly calls: CallRecord[] = [];
  private halt: Execution | null = null;
  constructor(readonly runId: string, readonly dir: string, readonly config: RunConfig,
    readonly connection: ModelConnection, readonly diagnostic: Diagnostic, readonly ledger: BudgetLedger | null,
    readonly role: 'candidate' | 'judge' = 'candidate', readonly sourceRunId?: string) {}
  async execute(task: Task, attemptId: string, index: number, prompt: string, images: ConnectionRequest['images'] = [], signal?: AbortSignal): Promise<Execution> {
    if (this.halt) return { ...this.halt, callIds: [], output: null };
    if (this.diagnostic.status !== 'ok') return { status: this.diagnostic.status, reason: this.diagnostic.reason, callIds: [], output: null };
    if (signal?.aborted) return { status: 'timeout', reason: 'Отмена до отправки', callIds: [], output: null };
    if (Buffer.byteLength(prompt) > task.limits.maxInputTokens) return { status: 'limit_exceeded', reason: 'Вход превышает консервативный локальный предел', callIds: [], output: null };
    const maxOutputTokens = Math.min(task.limits.maxOutputTokens, this.config.limits.maxOutputTokens);
    const maxAgentTurns = Math.min(task.limits.maxSteps, task.limits.maxCalls, this.config.limits.maxAgentTurns);
    const maxRetries = Math.min(task.limits.maxRetries, this.config.limits.maxRetries, task.limits.maxCalls - 1);
    const timeoutMs = Math.min(task.limits.timeoutMs, this.config.limits.timeoutMs);
    const mode = billingMode(this.connection.config.provider);
    const callBound = this.connection.upperBound(maxOutputTokens, images.length);
    const decision = this.ledger?.reserve(this.runId, task.id,
      callBound ? { ...callBound, attemptUsd: callBound.perCallUsd * (1 + maxRetries) } : null, new Date());
    if (decision && !decision.allowed) return { status: 'budget_exhausted', reason: decision.reason, callIds: [], output: null };
    const reservationId = decision?.allowed ? decision.reservationId : null;
    const callIds: string[] = [];
    const totalStarted = performance.now();
    try {
      for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex++) {
        const remainingMs = timeoutMs - (performance.now() - totalStarted);
        if (remainingMs <= 0) return { status: 'timeout', reason: 'Лимит времени попытки', callIds, output: null };
        // Эталоны, критерии и код проверок в эту папку не попадают.
        const workspace = mkdtempSync(join(tmpdir(), 'bench-attempt-'));
        for (const material of task.materials) writeFileSync(join(workspace, `${material.id}.txt`), material.content, { flag: 'wx' });
        const startedAt = new Date().toISOString(), started = performance.now();
        let result: ConnectionResult;
        try {
          result = await this.connection.execute({ prompt, workspace, taskId: task.id, attemptIndex: index,
            maxOutputTokens, maxAgentTurns,
            timeoutMs: Math.max(1, Math.floor(remainingMs)), temperature: this.config.generation.temperature, reasoning: this.config.generation.reasoning, images,
            ...(signal ? { signal } : {}) });
        } catch (error) { result = { ...emptyResult(), status: 'technical_error', reason: String(redact(error instanceof Error ? error.message : String(error))), incurredCostUsd: mode === 'api' ? null : 0 }; }
        finally { rmSync(workspace, { recursive: true, force: true }); }
        if (!result.sent) return { status: result.status === 'ok' ? 'technical_error' : result.status, reason: result.reason, callIds, output: null };
        const callId = `${this.runId}/${attemptId}/${this.role}-${retryIndex + 1}-${randomUUID().slice(0, 8)}`;
        const artifactStem = `${attemptId}-${this.role}-${retryIndex + 1}-${randomUUID().slice(0, 8)}`;
        const responsePath = `responses/${artifactStem}.txt`, rawPath = `responses/${artifactStem}.json`;
        writeFileSync(join(this.dir, responsePath), String(redact(result.output ?? result.reason)), { flag: 'wx' });
        writeJson(join(this.dir, rawPath), redact({ response: result.raw, reason: result.reason, usageScope: result.usageScope }));
        const limited = (result.usage.outputTotal ?? 0) > maxOutputTokens || (result.usage.inputTotal ?? 0) > task.limits.maxInputTokens
          || (result.agentSteps ?? 0) > maxAgentTurns;
        if (limited && result.status === 'ok') { result.status = 'limit_exceeded'; result.reason = 'Наблюдаемые токены/ходы превысили лимиты'; }
        const record: CallRecord = { runId: this.runId, taskId: task.id, attemptId, callId, primaryCategory: task.primaryCategory,
          role: this.role, provider: this.connection.config.provider, requestedModel: this.connection.config.model ?? 'mock-practical-v1',
          returnedModel: result.returnedModel, returnedProvider: result.returnedProvider, generationId: result.generationId,
          retryIndex, status: result.status, error: result.status === 'ok' ? null : String(redact(result.reason)),
          rawUsage: redact(result.rawUsage) as Record<string, unknown>, usage: result.usage, historicalUsage: null, delivery: 'fresh',
          tariff: this.connection.tariff(), modeledCostUsd: mode === 'mock' && this.connection.tariff() ? modeledCost(result.usage, this.connection.tariff()!) : result.estimatedCostUsd,
          incurredCostUsd: result.incurredCostUsd, billingMode: mode,
          costMethod: mode === 'api' ? 'api-token-estimate' : mode === 'subscription' ? 'client-api-equivalent-estimate' : mode === 'mock' ? 'synthetic-token-tariff' : 'unknown',
          agentSteps: result.agentSteps, internalRetries: result.internalRetries, usageScope: result.usageScope,
          accountingIncomplete: !result.usage.complete || result.internalRetries === null, clientVersion: this.diagnostic.version,
          subscriptionRun: mode === 'subscription', startedAt, elapsedMs: performance.now() - started,
          ...(this.sourceRunId ? { sourceRunId: this.sourceRunId } : {}),
          elapsedKind: mode === 'manual' ? 'import-processing' : 'generation', generationElapsedMs: mode === 'manual'
            ? typeof (result.raw as Record<string, unknown>).elapsedMs === 'number' ? Number((result.raw as Record<string, unknown>).elapsedMs) : null : performance.now() - started,
          apiRequests: mode === 'api' ? 1 : 0, simulatedRequests: mode === 'mock' ? 1 : 0,
          parameters: { ...task.limits, maxOutputTokens, maxSteps: maxAgentTurns, maxRetries, timeoutMs },
          generationParameters: { requested: this.config.generation, applied: effectiveGeneration(this.connection.config.provider, this.config.generation),
            outputLimit: String(this.diagnostic.config.outputTokenLimit ?? (mode === 'api' ? 'API max_tokens' : 'fixture-or-declared')) },
          artifacts: [responsePath, rawPath] };
        appendJsonl(join(this.dir, 'calls.jsonl'), record); this.calls.push(record); callIds.push(callId);
        if (reservationId && this.ledger) {
          try { this.ledger.charge(reservationId, record.incurredCostUsd); }
          catch {
            this.ledger.charge(reservationId, null); this.ledger.freeze('Начисление превысило резерв; сопоставьте calls.jsonl с биллингом');
            this.halt = { status: 'budget_exhausted', reason: 'Начисление выше резерва; журнал заморожен до сверки', callIds: [], output: null };
            return { ...this.halt, callIds };
          }
        }
        if (['quota_exhausted', 'auth_missing', 'auth_incompatible', 'model_unavailable', 'route_changed'].includes(result.status)) {
          this.halt = { status: result.status === 'ok' ? 'technical_error' : result.status, reason: result.reason, callIds: [], output: null };
        }
        if (result.status === 'technical_error' && /HTTP 503|HTTP 502|temporar.*unavailable/i.test(result.reason) && retryIndex < maxRetries) continue;
        return { status: result.status, reason: result.reason, callIds, output: result.output };
      }
      return { status: 'technical_error', reason: 'Повторы исчерпаны', callIds, output: null };
    } finally { if (reservationId && this.ledger) this.ledger.finish(reservationId); }
  }
}
