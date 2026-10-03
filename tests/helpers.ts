import { loadInputs } from '../src/runner.js';
import { assess } from '../src/checks.js';
import { modelId } from '../src/mock-provider.js';
import { normalizeMockUsage } from '../src/usage.js';
import type { AttemptRecord, CallRecord, CheckResult } from '../src/types.js';
import type { Task } from '../src/schema.js';

export const { suite, config } = loadInputs();
export function task(id = 'pagination'): Task {
  const found = suite.tasks.find((t) => t.id === id);
  if (!found) throw new Error(`Нет задания ${id}`);
  return structuredClone(found);
}
export function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    runId: 'run-1', taskId: 'pagination', attemptId: 'pagination-a1', callId: 'call-1', primaryCategory: 'backend',
    role: 'candidate', provider: 'local-mock', requestedModel: modelId, returnedModel: modelId,
    retryIndex: 0, status: 'ok', error: null, rawUsage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 },
    usage: normalizeMockUsage({ inputTokens: 100, outputTokens: 40, reasoningTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 }),
    historicalUsage: null, delivery: 'fresh', tariff: config.tariff, modeledCostUsd: 0.000205, incurredCostUsd: 0,
    costMethod: 'synthetic-token-tariff', startedAt: '2026-10-03T12:00:00Z', elapsedMs: 1, apiRequests: 0, simulatedRequests: 1,
    parameters: task().limits, artifacts: [], ...overrides,
  };
}
export function attempt(t = task(), pass = true, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const checks: CheckResult[] = t.checks.map((c) => ({ id: c.id, category: c.category, critical: c.critical, weight: c.weight, pass, score: pass ? 1 : 0, reason: 'fixture', evidence: [] }));
  const assessment = assess(t, checks);
  return {
    runId: 'run-1', taskId: t.id, attemptId: `${t.id}-a1`, index: 1, primaryCategory: t.primaryCategory, model: modelId,
    ...assessment, checks, callIds: ['call-1'], elapsedMs: 1, reason: 'fixture', artifacts: [], promptfooSuccess: pass,
    ...overrides,
  };
}
