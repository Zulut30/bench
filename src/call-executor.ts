import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { BudgetAccess } from './budget.js';
import type { CallIntent, StateStore } from './state.js';
import type { Task } from './schema.js';
import type { AttemptStatus, CallRecord } from './types.js';
import { appendJsonl, hash, immutableWrite, readJsonl } from './storage.js';
import { billingMode, effectiveGeneration } from './connections/config.js';
import type { RunConfig } from './connections/config.js';
import type { ConnectionRequest, ConnectionResult, Diagnostic, ModelConnection } from './connections/types.js';
import { modeledCost } from './usage.js';
import { emptyResult } from './connections/parsers.js';
import { redact } from './connections/process.js';

export interface Execution { status: 'ok' | Exclude<AttemptStatus, 'passed' | 'failed' | 'pending'>; reason: string; callIds: string[]; output: string | null; }
export class CallExecutor {
  readonly calls: CallRecord[] = [];
  private readonly pending = new Set<Promise<Execution>>();
  private halt: Execution | null = null;
  constructor(readonly runId: string, readonly dir: string, readonly config: RunConfig,
    readonly connection: ModelConnection, readonly diagnostic: Diagnostic, readonly ledger: BudgetAccess | null,
    readonly role: 'candidate' | 'judge' = 'candidate', readonly sourceRunId?: string,
    readonly durable?: { store: StateStore; fault?: (point: string) => void; log?: (event: Record<string, unknown>) => void }) {
    for (const intent of durable?.store.intents(runId) ?? []) if (intent.record && intent.result) this.publish(intent.record, intent.result);
  }
  private phase(intent: CallIntent, point: string) {
    this.durable?.log?.({ event: 'call_state', runId: this.runId, callId: intent.id, state: intent.state, phase: point });
    this.durable?.fault?.(point);
  }
  private publish(record: CallRecord, result: ConnectionResult) {
    const contents = [String(redact(result.output ?? result.reason)), JSON.stringify(redact({ response: result.raw, reason: result.reason, usageScope: result.usageScope }), null, 2) + '\n'];
    for (let i = 0; i < record.artifacts.length; i++) {
      const path = join(this.dir, record.artifacts[i]!);
      if (existsSync(path) && readFileSync(path, 'utf8') !== contents[i]) {
        const partial = readFileSync(path, 'utf8');
        if (!this.durable || existsSync(join(this.dir, 'integrity.json')) || !contents[i]!.startsWith(partial)) throw new Error(`Сохранённый ответ изменён: ${record.artifacts[i]}`);
        renameSync(path, `${path}.interrupted-${randomUUID()}`);
        this.durable.log?.({ event: 'artifact_recovered', callId: record.callId, path: record.artifacts[i] });
      }
      if (!existsSync(path)) immutableWrite(path, contents[i]!);
    }
    if (!this.calls.some((c) => c.callId === record.callId)) this.calls.push(record);
    const path = join(this.dir, 'calls.jsonl');
    let journal: CallRecord[];
    try { journal = readJsonl<CallRecord>(path); }
    catch (error) {
      if (!this.durable || existsSync(join(this.dir, 'integrity.json'))) throw error;
      const lines = readFileSync(path, 'utf8').split('\n');
      // Исправляется только оборванная последняя запись; исходные байты сохраняются.
      journal = lines.slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as CallRecord);
      const authoritative = this.durable.store.intents(this.runId).flatMap(i => i.record ? [i.record] : []);
      if (journal.some(c => !authoritative.some(a => a.callId === c.callId && JSON.stringify(a) === JSON.stringify(c)))) throw error;
      renameSync(path, `${path}.interrupted-${randomUUID()}`);
      immutableWrite(path, authoritative.map(c => JSON.stringify(c) + '\n').join(''));
      journal = authoritative;
    }
    if (!journal.some((c) => c.callId === record.callId)) appendJsonl(path, record);
  }
  execute(task: Task, attemptId: string, index: number, prompt: string, images: ConnectionRequest['images'] = [], signal?: AbortSignal, intentKey = attemptId): Promise<Execution> {
    const request = this.executeOne(task, attemptId, index, prompt, images, signal, intentKey); this.pending.add(request);
    void request.then(() => this.pending.delete(request), () => this.pending.delete(request)); return request;
  }
  async waitForIdle() { await Promise.allSettled([...this.pending]); }
  private async executeOne(task: Task, attemptId: string, index: number, prompt: string, images: ConnectionRequest['images'], signal: AbortSignal | undefined, intentKey: string): Promise<Execution> {
    if (this.halt) return { ...this.halt, callIds: [], output: null };
    const existing = this.durable?.store.intent(this.runId, intentKey, this.role, 0);
    if (!existing && this.diagnostic.status !== 'ok') return { status: this.diagnostic.status, reason: this.diagnostic.reason, callIds: [], output: null };
    if (signal?.aborted) return { status: 'timeout', reason: 'Отмена до отправки', callIds: [], output: null };
    if (Buffer.byteLength(prompt) > task.limits.maxInputTokens) return { status: 'limit_exceeded', reason: 'Вход превышает консервативный локальный предел', callIds: [], output: null };
    const maxOutputTokens = Math.min(task.limits.maxOutputTokens, this.config.limits.maxOutputTokens);
    const maxAgentTurns = Math.min(task.limits.maxSteps, task.limits.maxCalls, this.config.limits.maxAgentTurns);
    const maxRetries = Math.min(task.limits.maxRetries, this.config.limits.maxRetries, task.limits.maxCalls - 1);
    const timeoutMs = Math.min(task.limits.timeoutMs, this.config.limits.timeoutMs), mode = billingMode(this.connection.config.provider);
    const callBound = this.connection.upperBound(maxOutputTokens, images.length, { prompt, images });
    let reservationId = existing?.reservationId ?? null;
    const callIds: string[] = [], totalStarted = performance.now();
    let safeToFinish = false;
    try {
      for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex++) {
        let intent = this.durable?.store.intent(this.runId, intentKey, this.role, retryIndex);
        if (intent && intent.promptHash !== hash(prompt + JSON.stringify(images))) throw new Error('Промпт восстановления отличается от исходного');
        if (intent?.state === 'dispatched' || intent?.state === 'in_doubt') {
          if (intent.state === 'dispatched') this.durable!.store.transition(intent, 'in_doubt', { reason: 'Исход dispatched неизвестен' });
          if (!intent.record) {
            const result = { ...emptyResult(), status: 'technical_error' as const, reason: 'in_doubt: dispatched без надёжно сохранённого ответа', incurredCostUsd: mode === 'api' ? null : 0 };
            const record: CallRecord = { runId: this.runId, taskId: task.id, attemptId, callId: intent.id, primaryCategory: task.primaryCategory,
              role: this.role, provider: this.connection.config.provider, requestedModel: this.connection.config.model ?? 'mock-practical-v1', returnedModel: null,
              generationId: intent.generationId, retryIndex, status: 'technical_error', error: result.reason, rawUsage: {}, usage: result.usage, historicalUsage: null,
              delivery: 'fresh', tariff: this.connection.tariff(), modeledCostUsd: null, incurredCostUsd: result.incurredCostUsd, costMethod: 'unknown', billingMode: mode,
              accountingIncomplete: true, startedAt: intent.updatedAt, elapsedMs: 0, generationElapsedMs: null,
              apiRequests: mode === 'api' ? 1 : 0, simulatedRequests: mode === 'mock' ? 1 : 0, parameters: task.limits,
              artifacts: [`responses/${attemptId}-${this.role}-${retryIndex + 1}-unknown.txt`, `responses/${attemptId}-${this.role}-${retryIndex + 1}-unknown.json`] };
            this.durable!.store.uncertainRecord(intent, record, result); this.publish(record, result);
          }
          return { status: 'in_doubt', reason: 'Неизвестен исход dispatched-вызова. Только сверка; повторная отправка запрещена', callIds: [intent.record!.callId], output: null };
        }
        if (!intent && this.durable) {
          intent = { id: `${this.runId}/${attemptId}/${this.role}-${retryIndex + 1}-${randomUUID().slice(0, 8)}`, runId: this.runId,
            taskId: task.id, attemptId: intentKey, role: this.role, retryIndex, state: 'planned', reservationId, generationId: null,
            promptHash: hash(prompt + JSON.stringify(images)), result: null, record: null, reason: '', updatedAt: new Date().toISOString() };
          this.durable.store.plan(intent); this.phase(intent, 'planned');
        }
        if (!reservationId && this.ledger && (!intent || intent.state === 'planned')) {
          const reserve = () => {
            const decision = this.ledger!.reserve(this.runId, task.id, callBound ? { ...callBound, attemptUsd: callBound.perCallUsd * (1 + maxRetries) } : null, new Date());
            if (decision.allowed) { reservationId = decision.reservationId; if (intent) this.durable!.store.transition(intent, 'reserved', { reservationId }); }
            else if (intent) this.durable!.store.transition(intent, 'failed', { reason: decision.reason });
            return decision;
          };
          const decision = this.durable ? this.durable.store.transaction(reserve) : reserve();
          if (!decision.allowed) return { status: 'budget_exhausted', reason: decision.reason, callIds, output: null };
        }
        if (intent?.state === 'planned') this.durable!.store.transition(intent, 'reserved', { reservationId });
        if (intent?.state === 'reserved') this.phase(intent, 'reserved');
        if (intent?.state === 'failed' && !intent.result) return { status: 'budget_exhausted', reason: intent.reason, callIds, output: null };
        const remainingMs = timeoutMs - (performance.now() - totalStarted);
        if (remainingMs <= 0) { safeToFinish = true; return { status: 'timeout', reason: 'Лимит времени попытки', callIds, output: null }; }
        let result: ConnectionResult, record: CallRecord | null = intent?.record ?? null;
        if (intent?.result) { result = intent.result; if (record) this.publish(record, result); }
        else {
          if (reservationId && this.ledger) {
            const decision = this.ledger.validateReservation(reservationId, callBound ? { ...callBound, attemptUsd: callBound.perCallUsd * (1 + maxRetries - retryIndex) } : null);
            if (!decision.allowed) {
              // Ни один байт этого вызова не отправлен; оставшийся известный резерв можно завершить.
              if (intent?.state === 'reserved') this.durable!.store.transition(intent, 'failed', { reason: decision.reason });
              safeToFinish = !this.ledger.snapshot().reservations[reservationId]?.reconciliationRequired;
              return { status: 'budget_exhausted', reason: decision.reason, callIds, output: null };
            }
          }
          if (this.diagnostic.status !== 'ok') { safeToFinish = true; return { status: this.diagnostic.status, reason: this.diagnostic.reason, callIds, output: null }; }
          const workspace = mkdtempSync(join(tmpdir(), 'bench-attempt-'));
          for (const material of task.materials) writeFileSync(join(workspace, `${material.id}.txt`), material.content, { flag: 'wx' });
          const startedAt = new Date().toISOString(), started = performance.now();
          try {
            if (intent) { this.durable!.store.transition(intent, 'dispatched'); this.phase(intent, 'dispatched'); }
            result = await this.connection.execute({ prompt, workspace, taskId: task.id, attemptIndex: index, maxOutputTokens, maxAgentTurns,
              timeoutMs: Math.max(1, Math.floor(remainingMs)), temperature: this.config.generation.temperature, reasoning: this.config.generation.reasoning, images,
              ...(signal ? { signal } : {}), ...(intent ? { onGenerationId: (id: string) => this.durable!.store.generation(intent!, id) } : {}) });
            if (intent) this.phase(intent, 'received');
          } catch (error) {
            if (this.durable?.fault) throw error;
            result = { ...emptyResult(), status: 'technical_error', reason: String(redact(error instanceof Error ? error.message : String(error))), incurredCostUsd: mode === 'api' ? null : 0 };
          } finally { rmSync(workspace, { recursive: true, force: true }); }
          if (result.sent) {
            const callId = intent?.id ?? `${this.runId}/${attemptId}/${this.role}-${retryIndex + 1}-${randomUUID().slice(0, 8)}`;
            const artifactStem = `${attemptId}-${this.role}-${retryIndex + 1}-${callId.split('-').at(-1)}`;
            const limited = (result.usage.outputTotal ?? 0) > maxOutputTokens || (result.usage.inputTotal ?? 0) > task.limits.maxInputTokens || (result.agentSteps ?? 0) > maxAgentTurns;
            if (limited && result.status === 'ok') { result.status = 'limit_exceeded'; result.reason = 'Наблюдаемые токены/ходы превысили лимиты'; }
            const elapsedMs = performance.now() - started;
            record = { runId: this.runId, taskId: task.id, attemptId, callId, primaryCategory: task.primaryCategory,
              role: this.role, provider: this.connection.config.provider, requestedModel: this.connection.config.model ?? 'mock-practical-v1',
              returnedModel: result.returnedModel, returnedProvider: result.returnedProvider, generationId: result.generationId,
              retryIndex, status: result.status, error: result.status === 'ok' ? null : String(redact(result.reason)),
              rawUsage: redact(result.rawUsage) as Record<string, unknown>, usage: result.usage, historicalUsage: null, delivery: 'fresh',
              tariff: this.connection.tariff(), modeledCostUsd: mode === 'mock' && this.connection.tariff() ? modeledCost(result.usage, this.connection.tariff()!) : result.estimatedCostUsd,
              incurredCostUsd: result.incurredCostUsd, billingMode: mode,
              costMethod: mode === 'api' ? 'api-token-estimate' : mode === 'subscription' ? 'client-api-equivalent-estimate' : mode === 'mock' ? 'synthetic-token-tariff' : 'unknown',
              agentSteps: result.agentSteps, internalRetries: result.internalRetries, usageScope: result.usageScope,
              accountingIncomplete: !result.usage.complete || result.internalRetries === null, clientVersion: this.diagnostic.version,
              subscriptionRun: mode === 'subscription', startedAt, elapsedMs,
              ...(this.sourceRunId ? { sourceRunId: this.sourceRunId } : {}),
              elapsedKind: mode === 'manual' ? 'import-processing' : 'generation', generationElapsedMs: mode === 'manual'
                ? typeof (result.raw as Record<string, unknown>).elapsedMs === 'number' ? Number((result.raw as Record<string, unknown>).elapsedMs) : null : elapsedMs,
              apiRequests: mode === 'api' ? 1 : 0, simulatedRequests: mode === 'mock' ? 1 : 0,
              parameters: { ...task.limits, maxOutputTokens, maxSteps: maxAgentTurns, maxRetries, timeoutMs },
              generationParameters: { requested: this.config.generation, applied: effectiveGeneration(this.connection.config.provider, this.config.generation),
                outputLimit: String(this.diagnostic.config.outputTokenLimit ?? (mode === 'api' ? 'API max_tokens' : 'fixture-or-declared')) },
              artifacts: [`responses/${artifactStem}.txt`, `responses/${artifactStem}.json`] };
          }
          const settle = () => {
            if (reservationId && record && this.ledger) {
              try { this.ledger.charge(reservationId, record.incurredCostUsd); }
              catch { this.ledger.charge(reservationId, null); this.ledger.freeze('Начисление выше резерва; требуется сверка'); this.halt = { status: 'budget_exhausted', reason: 'Начисление выше резерва', callIds: [], output: null }; }
            }
            const uncertain = mode === 'api' && result.sent && result.incurredCostUsd === null && ['timeout', 'technical_error', 'invalid_response'].includes(result.status);
            if (intent) this.durable!.store.transition(intent, uncertain ? 'in_doubt' : result.status === 'ok' ? 'completed' : 'failed', { result: redact(result) as ConnectionResult, record, generationId: result.generationId ?? intent.generationId, reason: result.reason });
          };
          if (this.durable) this.durable.store.transaction(settle); else settle();
          if (intent) this.phase(intent, intent.state);
          if (record) this.publish(record, result);
        }
        safeToFinish = true;
        if (record) callIds.push(record.callId);
        if (this.halt) return { ...this.halt, callIds };
        if (['quota_exhausted', 'auth_missing', 'auth_incompatible', 'model_unavailable', 'route_changed'].includes(result.status)) this.halt = { status: result.status, reason: result.reason, callIds: [], output: null };
        // Не повторять неопределённое списание даже при похожем на 503 тексте.
        if (result.status === 'technical_error' && /HTTP 503|HTTP 502|temporar.*unavailable/i.test(result.reason) && retryIndex < maxRetries && (mode !== 'api' || result.incurredCostUsd !== null)) { safeToFinish = false; continue; }
        return { status: result.status === 'ok' && !result.sent ? 'technical_error' : result.status, reason: result.reason, callIds, output: result.output };
      }
      safeToFinish = true; return { status: 'technical_error', reason: 'Повторы исчерпаны', callIds, output: null };
    } finally {
      if (safeToFinish && reservationId && this.ledger && !this.ledger.snapshot().reservations[reservationId]?.finished) this.ledger.finish(reservationId);
    }
  }
}
