import { z } from 'zod';
import type { Tariff, Task } from './schema.js';

const counter = z.number().int().min(0).safe().nullable().optional();
// Контракт именно mock: input/output включают кеш/reasoning. Это не адаптер реального API.
export const mockUsageSchema = z.strictObject({
  inputTokens: counter, outputTokens: counter, reasoningTokens: counter,
  cacheReadTokens: counter, cacheWriteTokens: counter,
});
export type MockUsage = z.infer<typeof mockUsageSchema>;
export interface Usage {
  inputTotal: number | null;
  outputTotal: number | null;
  total: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: 'provider' | 'estimate' | 'unknown';
  complete: boolean;
  synthetic: boolean;
}

export function normalizeMockUsage(raw: unknown, delivery: 'fresh' | 'local_cache' = 'fresh'): Usage {
  const parsed = mockUsageSchema.parse(raw);
  if (delivery === 'local_cache') {
    return { inputTotal: 0, outputTotal: 0, total: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, source: 'provider', complete: true, synthetic: true };
  }
  const inputTotal = parsed.inputTokens ?? null;
  const outputTotal = parsed.outputTokens ?? null;
  const reasoning = parsed.reasoningTokens ?? null;
  const cacheRead = parsed.cacheReadTokens ?? null;
  const cacheWrite = parsed.cacheWriteTokens ?? null;
  if (outputTotal !== null && reasoning !== null && reasoning > outputTotal) throw new Error('reasoning превышает outputTotal');
  if (inputTotal !== null && (cacheRead ?? 0) + (cacheWrite ?? 0) > inputTotal) throw new Error('Кеш превышает inputTotal');
  return {
    inputTotal, outputTotal,
    total: inputTotal === null || outputTotal === null ? null : inputTotal + outputTotal,
    reasoning, cacheRead, cacheWrite,
    source: Object.values(parsed).some((v) => typeof v === 'number') ? 'provider' : 'unknown',
    complete: [inputTotal, outputTotal, cacheRead, cacheWrite].every((v) => v !== null),
    synthetic: true,
  };
}

export function modeledCost(usage: Usage, tariff: Tariff, delivery: 'fresh' | 'local_cache' = 'fresh'): number | null {
  if (delivery === 'local_cache') return 0;
  const { inputTotal, outputTotal, cacheRead, cacheWrite } = usage;
  if (inputTotal === null || outputTotal === null || cacheRead === null || cacheWrite === null) return null;
  return roundUsd(((inputTotal - cacheRead - cacheWrite) * tariff.inputPerMillion
    + cacheRead * tariff.cacheReadPerMillion + cacheWrite * tariff.cacheWritePerMillion
    + outputTotal * tariff.outputPerMillion) / 1_000_000);
}

export function upperBound(task: Task, tariff: Tariff | null): { perCallUsd: number; attemptUsd: number } | null {
  if (tariff === null) return null;
  const perCallUsd = roundUsd((task.limits.maxInputTokens * Math.max(tariff.inputPerMillion, tariff.cacheReadPerMillion, tariff.cacheWritePerMillion)
    + task.limits.maxOutputTokens * tariff.outputPerMillion) / 1_000_000);
  // reasoning уже входит в maxOutputTokens; инструментов и судьи на этапе 1 нет.
  return { perCallUsd, attemptUsd: roundUsd(perCallUsd * (1 + task.limits.maxRetries)) };
}

export function roundUsd(value: number): number { return Math.round(value * 1e12) / 1e12; }
