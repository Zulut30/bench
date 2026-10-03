import { describe, expect, it } from 'vitest';
import { aggregate, summarizeCalls, sumKnown, uniqueCalls } from '../src/aggregate.js';
import { assess } from '../src/checks.js';
import { normalizeMockUsage } from '../src/usage.js';
import { attempt, call, suite, task } from './helpers.js';

describe('Агрегация уникальных вызовов', () => {
  it('учитывает ошибки, судью и повторы, не умножая расходы на пересекающиеся категории', () => {
    const initial = call({ status: 'technical_error', error: 'temporary', modeledCostUsd: 0.1 });
    const retry = call({ callId: 'call-2', retryIndex: 1, modeledCostUsd: 0.2 });
    const judge = call({ callId: 'call-3', role: 'judge', requestedModel: 'synthetic-judge', modeledCostUsd: 0.3 });
    const record = attempt(task(), true, { callIds: ['call-1', 'call-2', 'call-3'] });
    const summary = aggregate([initial, retry, judge, initial], [record], suite, 'Europe/Warsaw');
    expect(summary.totals.callCount).toBe(3);
    expect(summary.totals.costs.candidateInitial.value).toBe(0.1);
    expect(summary.totals.costs.judgeInitial.value).toBe(0.3);
    expect(summary.totals.costs.retries.value).toBe(0.2);
    expect(summary.totals.costs.total.value).toBe(0.6);
    expect(summary.totals.incurredCostUsd).toBe(0);
    expect(summary.byPrimaryCategory.backend?.costs.total.value).toBe(0.6);
    expect(summary.categories.find((c) => c.id === 'instruction-following')?.primaryCostUsd.value).toBe(0);
    expect(summary.byModel['mock-practical-v1']?.costs.judgeTotal.value).toBe(0.3);
    expect(summary.byMonth['2026-10']?.costs.total.value).toBe(0.6);
  });
  it('отвергает конфликтующие записи одного callId', () => {
    expect(() => uniqueCalls([call(), call({ modeledCostUsd: 1 })])).toThrow('callId');
  });
  it('показывает известную часть и неизвестность, не превращая пропуск в ноль', () => {
    const partial = call({ callId: 'partial', modeledCostUsd: null, usage: normalizeMockUsage({ inputTokens: 70 }) });
    const summary = summarizeCalls([call(), partial], [attempt()]);
    expect(summary.costs.total).toMatchObject({ value: null, known: 0.000205, unknownCount: 1, complete: false });
    expect(summary.tokens.input.value).toBe(170);
    expect(summary.tokens.output.value).toBeNull();
    expect(summary.costPerSuccessUsd).toBeNull();
    expect(sumKnown([]).value).toBe(0);
  });
  it('делит расходы всех попыток, включая провалы, на успехи того же набора', () => {
    const attempts = [attempt(), attempt(task(), false, { attemptId: 'pagination-a2', index: 2, callIds: ['call-2'] })];
    expect(summarizeCalls([call({ modeledCostUsd: 1 }), call({ callId: 'call-2', attemptId: 'pagination-a2', modeledCostUsd: 2 })], attempts).costPerSuccessUsd).toBe(3);
    expect(summarizeCalls([call()], [attempt(task(), false)]).costPerSuccessUsd).toBeNull();
  });
  it('pending и пропуски не получают ложных баллов; все 16 категорий присутствуют', () => {
    const subjective = attempt(task('pricing-layout'));
    const skippedTask = task('pagination');
    const skipped = attempt(skippedTask, true, { ...assess(skippedTask, [], 'Лимит бюджета'), status: 'budget_exhausted', checks: [], callIds: [] });
    const summary = aggregate([], [subjective, skipped], suite, 'Europe/Warsaw');
    expect(summary.categories).toHaveLength(16);
    expect(summary.categories.find((c) => c.id === 'ui-design')).toMatchObject({ pending: 1, meanScore: null, passRate: null, automatedPassRate: 1 });
    expect(summary.categories.find((c) => c.id === 'backend')).toMatchObject({ evaluatedAttempts: 0, meanScore: null, passRate: null });
    expect(summary.categories.find((c) => c.id === 'sql')).toMatchObject({ coverage: 'uncovered', taskCount: 0, meanScore: null, passRate: null });
    expect(summary.totals.successfulAttempts).toBe(0);
  });
  it('критический провал блокирует успех даже при хорошем среднем балле', () => {
    const t = task(); t.passThreshold = 0.4;
    const checks = attempt(t).checks; checks[0]!.pass = false; checks[0]!.score = 0;
    expect(assess(t, checks).status).toBe('failed');
  });
});
