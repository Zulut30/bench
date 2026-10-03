import { describe, expect, it } from 'vitest';
import { modeledCost, normalizeMockUsage, upperBound } from '../src/usage.js';
import { config, task } from './helpers.js';

describe('Нормализация mock usage', () => {
  it('не прибавляет reasoning и кеш повторно и тарифицирует выход один раз', () => {
    const usage = normalizeMockUsage({ inputTokens: 100, outputTokens: 50, reasoningTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10 });
    expect(usage).toMatchObject({ inputTotal: 100, outputTotal: 50, total: 150, reasoning: 20, complete: true });
    expect(modeledCost(usage, config.tariff)).toBe(0.0002225);
  });
  it('различает нулевые и неизвестные значения', () => {
    const zero = normalizeMockUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    const unknown = normalizeMockUsage({});
    expect(zero.total).toBe(0);
    expect(zero.complete).toBe(true);
    expect(modeledCost(zero, config.tariff)).toBe(0);
    expect(unknown.total).toBeNull();
    expect(unknown.source).toBe('unknown');
    expect(modeledCost(unknown, config.tariff)).toBeNull();
  });
  it('не считает частичный usage полным и не превращает отсутствие кеша в ноль', () => {
    const partial = normalizeMockUsage({ inputTokens: 100, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(partial.inputTotal).toBe(100);
    expect(partial.total).toBeNull();
    expect(partial.complete).toBe(false);
    expect(modeledCost(partial, config.tariff)).toBeNull();
    expect(modeledCost(normalizeMockUsage({ inputTokens: 100, outputTokens: 50 }), config.tariff)).toBeNull();
  });
  it('неизвестное reasoning не мешает цене, когда оно уже включено в известный output', () => {
    const usage = normalizeMockUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(usage.reasoning).toBeNull();
    expect(usage.complete).toBe(true);
    expect(modeledCost(usage, config.tariff)).toBe(0.00025);
  });
  it('локальный кеш не создаёт новых токенов и оплаты даже при историческом usage', () => {
    const usage = normalizeMockUsage({ inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 }, 'local_cache');
    expect(usage).toMatchObject({ inputTotal: 0, outputTotal: 0, total: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(modeledCost(usage, config.tariff, 'local_cache')).toBe(0);
  });
  it.each([
    { inputTokens: -1 }, { outputTokens: 1.5 }, { inputTokens: Infinity },
    { inputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 11 },
    { outputTokens: 5, reasoningTokens: 6 }, { extra: 2 },
  ])('отвергает некорректный usage %j', (raw) => {
    expect(() => normalizeMockUsage(raw)).toThrow();
  });
  it('резервирует максимальный выход, худший вариант кеша и весь разрешённый повтор', () => {
    const t = task('validation-error');
    expect(upperBound(t, config.tariff)).toEqual({ perCallUsd: 0.011264, attemptUsd: 0.022528 });
    expect(upperBound(t, null)).toBeNull();
  });
});
