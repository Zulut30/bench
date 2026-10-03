import { categories, categoryIds } from './categories.js';
import type { CategoryId } from './categories.js';
import type { Suite } from './schema.js';
import type { AttemptRecord, CallRecord } from './types.js';
import { monthKey } from './budget.js';
import { roundUsd } from './usage.js';

export interface Sum {
  value: number | null;
  known: number;
  unknownCount: number;
  complete: boolean;
}
export function sumKnown(values: Array<number | null>): Sum {
  const known = roundUsd(values.reduce<number>((total, value) => total + (value ?? 0), 0));
  const unknownCount = values.filter((value) => value === null).length;
  return { value: unknownCount ? null : known, known, unknownCount, complete: unknownCount === 0 };
}

export function uniqueCalls(calls: CallRecord[]): CallRecord[] {
  const map = new Map<string, CallRecord>();
  for (const call of calls) {
    const previous = map.get(call.callId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(call)) throw new Error(`Разные записи одного callId: ${call.callId}`);
    map.set(call.callId, call);
  }
  return [...map.values()];
}

export function costBreakdown(calls: CallRecord[]) {
  const cost = (selected: CallRecord[]) => sumKnown(selected.map((c) => c.modeledCostUsd));
  return {
    candidateInitial: cost(calls.filter((c) => c.role === 'candidate' && c.retryIndex === 0)),
    judgeInitial: cost(calls.filter((c) => c.role === 'judge' && c.retryIndex === 0)),
    retries: cost(calls.filter((c) => c.retryIndex > 0)),
    candidateTotal: cost(calls.filter((c) => c.role === 'candidate')),
    judgeTotal: cost(calls.filter((c) => c.role === 'judge')),
    total: cost(calls),
  };
}

export function summarizeCalls(input: CallRecord[], attempts: AttemptRecord[]) {
  const calls = uniqueCalls(input);
  const costs = costBreakdown(calls);
  const successfulAttempts = attempts.filter((a) => a.status === 'passed').length;
  return {
    callCount: calls.length,
    apiRequests: calls.reduce((sum, c) => sum + c.apiRequests, 0),
    simulatedRequests: calls.reduce((sum, c) => sum + c.simulatedRequests, 0),
    candidateCalls: calls.filter((c) => c.role === 'candidate').length,
    judgeCalls: calls.filter((c) => c.role === 'judge').length,
    retryCalls: calls.filter((c) => c.retryIndex > 0).length,
    localCacheReads: calls.filter((c) => c.delivery === 'local_cache').length,
    incompleteUsageCalls: calls.filter((c) => !c.usage.complete).length,
    tokens: {
      input: sumKnown(calls.map((c) => c.usage.inputTotal)), output: sumKnown(calls.map((c) => c.usage.outputTotal)),
      total: sumKnown(calls.map((c) => c.usage.total)), reasoning: sumKnown(calls.map((c) => c.usage.reasoning)),
      cacheRead: sumKnown(calls.map((c) => c.usage.cacheRead)), cacheWrite: sumKnown(calls.map((c) => c.usage.cacheWrite)),
    },
    costs, incurredCostUsd: roundUsd(calls.reduce((sum, c) => sum + c.incurredCostUsd, 0)),
    callElapsedMs: calls.reduce((sum, c) => sum + c.elapsedMs, 0),
    successfulAttempts,
    costPerSuccessUsd: successfulAttempts === 0 || costs.total.value === null ? null : roundUsd(costs.total.value / successfulAttempts),
    judgeIncludedInCostPerSuccess: true,
  };
}
export type CallSummary = ReturnType<typeof summarizeCalls>;
export interface CategorySummary {
  id: CategoryId; label: string; taskCount: number; executedTaskCount: number; plannedAttempts: number;
  evaluatedAttempts: number; passed: number; failed: number; pending: number; skipped: number;
  subjectivePending: number; passRate: number | null; automatedPassRate: number | null; meanScore: number | null;
  coverage: 'uncovered' | 'not_evaluated' | 'partial' | 'pending' | 'evaluated';
  primaryCostUsd: Sum;
}

export function summarizeCategories(suite: Suite, calls: CallRecord[], attempts: AttemptRecord[]): CategorySummary[] {
  return categoryIds.map((id) => {
    const tasks = suite.tasks.filter((t) => t.readiness === 'enabled' && t.evaluationCategories.includes(id));
    const selected = attempts.filter((a) => tasks.some((t) => t.id === a.taskId));
    const assessments = selected.flatMap((a) => a.assessments.filter((evaluation) => evaluation.category === id));
    const passed = assessments.filter((a) => a.status === 'passed').length;
    const failed = assessments.filter((a) => a.status === 'failed').length;
    const pending = assessments.filter((a) => a.status === 'pending').length;
    const plannedAttempts = tasks.reduce((sum, t) => sum + t.limits.attempts, 0);
    const skipped = Math.max(0, plannedAttempts - passed - failed - pending);
    const automated = assessments.filter((a) => a.automatedPass !== null);
    const scores = assessments.flatMap((a) => a.score === null ? [] : [a.score]);
    const executedTaskCount = new Set(selected.filter((a) => a.callIds.length > 0).map((a) => a.taskId)).size;
    return {
      id, label: categories[id].label, taskCount: tasks.length, executedTaskCount, plannedAttempts,
      evaluatedAttempts: passed + failed, passed, failed, pending, skipped,
      subjectivePending: assessments.filter((a) => a.subjectiveStatus === 'pending' && a.status !== 'not_evaluated').length,
      passRate: passed + failed ? passed / (passed + failed) : null,
      automatedPassRate: automated.length ? automated.filter((a) => a.automatedPass).length / automated.length : null,
      meanScore: scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null,
      coverage: !tasks.length ? 'uncovered' : !executedTaskCount ? 'not_evaluated' : skipped ? 'partial' : pending ? 'pending' : 'evaluated',
      primaryCostUsd: sumKnown(uniqueCalls(calls).filter((c) => c.primaryCategory === id).map((c) => c.modeledCostUsd)),
    };
  });
}

function grouped(calls: CallRecord[], attempts: AttemptRecord[], callKey: (c: CallRecord) => string, attemptKey: (a: AttemptRecord) => string) {
  const keys = new Set([...calls.map(callKey), ...attempts.map(attemptKey)]);
  return Object.fromEntries([...keys].sort().map((key) => [key, summarizeCalls(calls.filter((c) => callKey(c) === key), attempts.filter((a) => attemptKey(a) === key))]));
}

export function aggregate(callsInput: CallRecord[], attempts: AttemptRecord[], suite: Suite, timezone: string) {
  const calls = uniqueCalls(callsInput);
  const modelFor = (c: CallRecord) => attempts.find((a) => a.attemptId === c.attemptId && a.runId === c.runId)?.model ?? c.requestedModel;
  const totals = summarizeCalls(calls, attempts);
  const categories = summarizeCategories(suite, calls, attempts);
  const enabled = suite.tasks.filter((t) => t.readiness === 'enabled');
  return {
    totals, categories,
    taskCount: enabled.length, plannedAttempts: enabled.reduce((s, t) => s + t.limits.attempts, 0),
    executedTaskCount: new Set(attempts.filter((a) => a.callIds.length).map((a) => a.taskId)).size,
    statuses: Object.fromEntries(['passed', 'failed', 'pending', 'not_evaluated', 'budget_exhausted', 'technical_error', 'limit_exceeded'].map((status) => [status, attempts.filter((a) => a.status === status).length])),
    byAttempt: grouped(calls, attempts, (c) => `${c.runId}/${c.attemptId}`, (a) => `${a.runId}/${a.attemptId}`),
    byTask: grouped(calls, attempts, (c) => c.taskId, (a) => a.taskId),
    byPrimaryCategory: grouped(calls, attempts, (c) => c.primaryCategory, (a) => a.primaryCategory),
    byModel: grouped(calls, attempts, modelFor, (a) => a.model),
    byMonth: Object.fromEntries([...new Set(calls.map((c) => monthKey(new Date(c.startedAt), timezone)))].sort().map((month) => [month,
      summarizeCalls(calls.filter((c) => monthKey(new Date(c.startedAt), timezone) === month), attempts.filter((a) => calls.some((c) => c.attemptId === a.attemptId && monthKey(new Date(c.startedAt), timezone) === month)))])),
    uncoveredCategories: categories.filter((c) => c.coverage === 'uncovered').map((c) => c.id),
  };
}
export type RunSummary = ReturnType<typeof aggregate>;
