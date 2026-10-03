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

export const unknownUsage = (): Usage => ({ inputTotal: null, outputTotal: null, total: null, reasoning: null,
  cacheRead: null, cacheWrite: null, source: 'unknown', complete: false, synthetic: false });
const usageObject = z.looseObject({});
export function usageCounter(value: unknown): number | null {
  return value === undefined || value === null ? null : z.number().int().nonnegative().safe().parse(value);
}
function normalized(input: number | null, output: number | null, reasoning: number | null, read: number | null, write: number | null): Usage {
  if (output !== null && reasoning !== null && reasoning > output) throw new Error('reasoning превышает output');
  if (input !== null && (read ?? 0) + (write ?? 0) > input) throw new Error('Кеш превышает вход');
  return { inputTotal: input, outputTotal: output, total: input === null || output === null ? null : input + output,
    reasoning, cacheRead: read, cacheWrite: write, synthetic: false,
    source: [input, output, reasoning, read].some((v) => v !== null) ? 'provider' : 'unknown',
    complete: [input, output, read, write].every((v) => v !== null) };
}
export function normalizeOpenRouterUsage(raw: Record<string, unknown>): Usage {
  const input = usageCounter(raw.prompt_tokens), output = usageCounter(raw.completion_tokens);
  const prompt = raw.prompt_tokens_details ? usageObject.parse(raw.prompt_tokens_details) : {};
  const completion = raw.completion_tokens_details ? usageObject.parse(raw.completion_tokens_details) : {};
  return normalized(input, output, usageCounter(completion.reasoning_tokens), usageCounter(prompt.cached_tokens), usageCounter(prompt.cache_write_tokens));
}
export function normalizeCodexUsage(raw: Record<string, unknown>): Usage {
  // turn.completed — накопительная сводка новой сессии; кеш/reasoning уже включены.
  return normalized(usageCounter(raw.input_tokens), usageCounter(raw.output_tokens), usageCounter(raw.reasoning_output_tokens), usageCounter(raw.cached_input_tokens), 0);
}
export function normalizeClaudeUsage(raw: Record<string, unknown>): Usage {
  // Anthropic input_tokens НЕ включает cache_read/cache_creation. Выход включает thinking.
  const input = usageCounter(raw.input_tokens), read = usageCounter(raw.cache_read_input_tokens), write = usageCounter(raw.cache_creation_input_tokens);
  return normalized([input, read, write].every((v) => v !== null) ? input! + read! + write! : null,
    usageCounter(raw.output_tokens), usageCounter(raw.reasoning_tokens), read, write);
}
export function normalizeGeminiUsage(raw: Record<string, unknown>): Usage {
  // prompt включает cached; tool-use prompt отдельный вход; candidates не включает thoughts.
  const candidate = usageCounter(raw.candidates), thought = usageCounter(raw.thoughts);
  const prompt = usageCounter(raw.prompt), tool = usageCounter(raw.tool);
  return normalized(prompt === null || tool === null ? null : prompt + tool, candidate === null || thought === null ? null : candidate + thought,
    thought, usageCounter(raw.cached), 0);
}
