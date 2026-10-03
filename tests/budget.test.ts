import { describe, expect, it } from 'vitest';
import { BudgetLedger, monthKey } from '../src/budget.js';
import { config } from './helpers.js';

const now = new Date('2026-10-03T12:00:00Z');
const limits = { perRequestUsd: 1, perTaskUsd: 2, runUsd: 3, monthUsd: 4 };
function reserve(ledger: BudgetLedger, amount: number, run = 'run', task = 'task') {
  const decision = ledger.reserve(run, task, { perCallUsd: amount, attemptUsd: amount }, now);
  if (!decision.allowed) throw new Error(decision.reason);
  return decision.reservationId;
}

describe('Синтетический бюджет до запроса', () => {
  it.each([
    [{ perRequestUsd: 0.1 }, 0.2, 'Лимит запроса'],
    [{ perTaskUsd: 0.1 }, 0.2, 'Лимит задания'],
    [{ runUsd: 0.1 }, 0.2, 'Лимит запуска'],
    [{ monthUsd: 0.1 }, 0.2, 'Лимит месяца'],
  ] as const)('атомарно отказывает по каждому уровню %j', (override, amount, reason) => {
    const ledger = new BudgetLedger({ ...limits, ...override }, 'Europe/Warsaw');
    const before = ledger.snapshot();
    expect(ledger.reserve('run', 'task', { perCallUsd: amount, attemptUsd: amount }, now)).toEqual({ allowed: false, reason });
    expect(ledger.snapshot()).toEqual(before);
  });
  it('учитывает выполняющиеся запросы и не даёт перерасхода конкурирующим Promise', async () => {
    const ledger = new BudgetLedger({ ...limits, runUsd: 1 }, 'Europe/Warsaw');
    const decisions = await Promise.all(['a', 'b', 'c'].map(async (id) => ledger.reserve('run', id, { perCallUsd: 0.6, attemptUsd: 0.6 }, now)));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
    expect(ledger.snapshot().runs.run?.reservedMicroUsd).toBe(600000);
  });
  it('переводит фактический известный расход из резерва и освобождает только остаток', () => {
    const ledger = new BudgetLedger(limits, 'Europe/Warsaw');
    const id = reserve(ledger, 1);
    ledger.charge(id, 0.25);
    expect(ledger.snapshot().runs.run).toEqual({ spentMicroUsd: 250000, reservedMicroUsd: 750000 });
    ledger.finish(id);
    expect(ledger.snapshot().runs.run).toEqual({ spentMicroUsd: 250000, reservedMicroUsd: 0 });
    expect(() => ledger.charge(id, 0.1)).toThrow('завершена');
  });
  it('не освобождает неизвестную оплату ошибки и сохраняет её между запусками', () => {
    const ledger = new BudgetLedger({ ...limits, monthUsd: 1 }, 'Europe/Warsaw');
    const id = reserve(ledger, 1);
    ledger.charge(id, 0.2);
    ledger.charge(id, null);
    ledger.finish(id);
    expect(ledger.snapshot().runs.run).toEqual({ spentMicroUsd: 200000, reservedMicroUsd: 800000 });
    const restored = new BudgetLedger({ ...limits, monthUsd: 1 }, 'Europe/Warsaw', ledger.snapshot());
    expect(restored.reserve('other', 'task', { perCallUsd: 0.01, attemptUsd: 0.01 }, now)).toMatchObject({ allowed: false, reason: 'Лимит месяца' });
    expect(restored.snapshot().reservations[id]?.reconciliationRequired).toBe(true);
  });
  it('блокирует неизвестную верхнюю цену до вызова', () => {
    const ledger = new BudgetLedger(limits, 'Europe/Warsaw');
    expect(ledger.reserve('run', 'task', null, now)).toMatchObject({ allowed: false });
    expect(ledger.snapshot().reservations).toEqual({});
  });
  it('нулевой бюджет пропускает только нулевой резерв', () => {
    const ledger = new BudgetLedger({ perRequestUsd: 0, perTaskUsd: 0, runUsd: 0, monthUsd: 0 }, 'Europe/Warsaw');
    expect(ledger.reserve('run', 'paid', { perCallUsd: 0.0000001, attemptUsd: 0.0000001 }, now)).toMatchObject({ allowed: false });
    const id = reserve(ledger, 0);
    ledger.charge(id, 0); ledger.finish(id);
    expect(ledger.snapshot().runs.run).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0 });
  });
  it('не разрешает расход больше резерва', () => {
    const ledger = new BudgetLedger(limits, 'Europe/Warsaw');
    const id = reserve(ledger, 0.25);
    expect(() => ledger.charge(id, 0.26)).toThrow('верхнюю границу');
    expect(ledger.snapshot().runs.run?.reservedMicroUsd).toBe(250000);
  });
  it('при ошибке сохранения не выдаёт разрешение и откатывает память', () => {
    const ledger = new BudgetLedger(limits, 'Europe/Warsaw', undefined, () => { throw new Error('disk full'); });
    expect(() => reserve(ledger, 0.1)).toThrow('disk full');
    expect(ledger.snapshot().reservations).toEqual({});
  });
  it('вычисляет месяц в явно заданной таймзоне', () => {
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'Europe/Warsaw')).toBe('2026-10');
    expect(monthKey(new Date('2026-09-30T22:30:00Z'), 'UTC')).toBe('2026-09');
    expect(() => new BudgetLedger(config.syntheticBudget, 'UTC', new BudgetLedger(limits, 'Europe/Warsaw').snapshot())).toThrow('Таймзона');
  });
});
