import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget.js';
import { MockProvider, responsesSchema } from '../src/mock-provider.js';
import { projectRoot, taskPrompt } from '../src/runner.js';
import { readJson } from '../src/storage.js';
import type { Task } from '../src/schema.js';
import { config, task } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function providerFor(t: Task, ledger = new BudgetLedger(config.syntheticBudget, config.timezone)) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-provider-test-')); dirs.push(dir);
  mkdirSync(join(dir, 'responses'));
  return new MockProvider('test-run', 'current', [t], responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json'))), config.tariff, ledger, dir);
}
const contextFor = (t: Task, index = 1) => ({ prompt: { raw: taskPrompt(t), label: 'test' }, vars: { taskId: t.id, attemptIndex: index } });

describe('Mock provider: отказ до отправки и учёт попыток', () => {
  it('не отправляет запрос при нехватке резерва, а не проверяет бюджет после ответа', async () => {
    const t = task();
    const ledger = new BudgetLedger({ ...config.syntheticBudget, runUsd: 0.00001 }, config.timezone);
    const provider = providerFor(t, ledger);
    const response = await provider.callApi(taskPrompt(t), contextFor(t));
    expect(response.metadata?.status).toBe('budget_exhausted');
    expect(provider.wireCallCount).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(ledger.snapshot().reservations).toEqual({});
  });
  it('сохраняет оба вызова технического повтора и их расходы', async () => {
    const t = task('validation-error');
    const provider = providerFor(t);
    const response = await provider.callApi(taskPrompt(t), contextFor(t));
    expect(response.metadata?.status).toBe('ok');
    expect(provider.wireCallCount).toBe(2);
    expect(provider.calls.map((c) => c.retryIndex)).toEqual([0, 1]);
    expect(provider.calls[0]).toMatchObject({ status: 'technical_error', modeledCostUsd: 0.00003, incurredCostUsd: 0 });
    expect(provider.calls[1]).toMatchObject({ status: 'ok', modeledCostUsd: 0.00054, incurredCostUsd: 0 });
    expect(response.tokenUsage).toMatchObject({ prompt: 210, completion: 120, total: 330 });
  });
  it('исчерпание технических повторов не означает бесплатную ошибку', async () => {
    const t = task('validation-error'); t.limits.maxRetries = 0; t.limits.maxCalls = 1; t.limits.maxSteps = 1;
    const ledger = new BudgetLedger(config.syntheticBudget, config.timezone);
    const provider = providerFor(t, ledger);
    expect((await provider.callApi(taskPrompt(t), contextFor(t))).metadata?.status).toBe('technical_error');
    expect(ledger.snapshot().runs['test-run']).toEqual({ spentMicroUsd: 30, reservedMicroUsd: 0 });
  });
  it('неполный usage удерживает резерв после успешно полученного ответа', async () => {
    const t = task('translation-ru');
    const ledger = new BudgetLedger(config.syntheticBudget, config.timezone);
    const provider = providerFor(t, ledger);
    await provider.callApi(taskPrompt(t), contextFor(t));
    expect(provider.calls[0]?.modeledCostUsd).toBeNull();
    expect(ledger.snapshot().runs['test-run']?.reservedMicroUsd).toBe(11264);
    expect(Object.values(ledger.snapshot().reservations)[0]).toMatchObject({ reconciliationRequired: true, finished: true });
  });
  it('локальный кеш работает с нулевым бюджетом и не считается новым запросом', async () => {
    const t = task('release-notes');
    const ledger = new BudgetLedger({ perRequestUsd: 0, perTaskUsd: 0, runUsd: 0, monthUsd: 0 }, config.timezone);
    const provider = providerFor(t, ledger);
    const response = await provider.callApi(taskPrompt(t), contextFor(t, 2));
    expect(response.cached).toBe(true);
    expect(provider.wireCallCount).toBe(0);
    expect(provider.calls[0]).toMatchObject({ modeledCostUsd: 0, incurredCostUsd: 0, usage: { total: 0 }, historicalUsage: { total: 300 } });
  });
  it('ограничивает вход и отменённые запросы до отправки', async () => {
    const t = task();
    const provider = providerFor(t);
    expect((await provider.callApi('x'.repeat(t.limits.maxInputTokens + 1), contextFor(t))).metadata?.status).toBe('limit_exceeded');
    const controller = new AbortController(); controller.abort();
    expect((await provider.callApi(taskPrompt(t), contextFor(t, 2), { abortSignal: controller.signal })).metadata?.status).toBe('limit_exceeded');
    expect(provider.wireCallCount).toBe(0);
  });
  it('не повторяет запрос при провале качества', async () => {
    const t = task('faq-disclosure');
    const provider = providerFor(t);
    await provider.callApi(taskPrompt(t), contextFor(t, 2));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.retryIndex).toBe(0);
  });
});
