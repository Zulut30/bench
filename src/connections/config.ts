import { z } from 'zod';
import { readJson } from '../storage.js';

export const providerIds = ['mock', 'openrouter', 'codex-cli', 'claude-code', 'gemini-cli', 'manual'] as const;
export type ProviderId = typeof providerIds[number];
export type BillingMode = 'mock' | 'api' | 'subscription' | 'manual';
const usd = z.number().finite().nonnegative();
export const connectionSchema = z.strictObject({
  provider: z.enum(providerIds), model: z.string().min(1).nullable().default(null),
  providerEndpoint: z.string().min(1).nullable().default(null),
  promptTransport: z.enum(['chat', 'raw-llama3']).default('chat'),
  executionMode: z.enum(['model-only', 'agent']).default('model-only'),
  executable: z.string().min(1).nullable().default(null),
  clientHome: z.string().min(1).nullable().default(null),
  subscription: z.strictObject({
    fixedMonthlyUsd: usd.nullable().default(null), availableTokens: z.number().int().nonnegative().nullable().default(null),
    knownLimits: z.array(z.string()).default([]),
    paidOverage: z.enum(['disabled', 'unknown']).default('unknown'),
  }).default({ fixedMonthlyUsd: null, availableTokens: null, knownLimits: [], paidOverage: 'unknown' }),
});
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export const runConfigSchema = z.strictObject({
  version: z.literal(1), suite: z.string().default('benchmarks/pilot.json'),
  timezone: z.string().default('Europe/Warsaw').refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  candidate: connectionSchema,
  profile: z.enum(['pilot', 'smoke', 'standard']).default('pilot'),
  taskIds: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  sandbox: z.strictObject({ image: z.string().default('practical-bench-sandbox:1'), dockerContext: z.string().nullable().default(null) })
    .default({ image: 'practical-bench-sandbox:1', dockerContext: null }),
  judges: z.strictObject({ text: connectionSchema.nullable(), vision: connectionSchema.nullable(), version: z.string().min(1) }),
  apiBudget: z.strictObject({ perRequestUsd: usd, perTaskUsd: usd, runUsd: usd, monthUsd: usd }),
  generation: z.strictObject({ temperature: z.number().min(0).max(2), reasoning: z.enum(['none', 'low', 'medium', 'high', 'xhigh']) }),
  limits: z.strictObject({ attempts: z.number().int().min(1).max(10), timeoutMs: z.number().int().min(100).max(300_000),
    maxAgentTurns: z.number().int().min(1).max(10), maxRetries: z.number().int().min(0).max(2),
    maxOutputTokens: z.number().int().min(32).max(32768), maxJudgeCalls: z.number().int().min(0).max(2),
  }),
}).superRefine((config, ctx) => {
  for (const judge of [config.judges.text, config.judges.vision]) if (judge && judge.provider !== 'openrouter') {
    ctx.addIssue({ code: 'custom', message: 'Автоматические судьи сейчас используют только OpenRouter; ручная оценка отдельная' });
  }
});
export type RunConfig = z.infer<typeof runConfigSchema>;
export function loadConfig(path: string): RunConfig { return runConfigSchema.parse(readJson(path)); }
export function billingMode(provider: ProviderId): BillingMode {
  return provider === 'openrouter' ? 'api' : provider === 'mock' || provider === 'manual' ? provider : 'subscription';
}
export function effectiveGeneration(provider: ProviderId, requested: RunConfig['generation']) {
  return { temperature: provider === 'openrouter' ? requested.temperature : null,
    reasoning: provider === 'openrouter' ? requested.reasoning : provider === 'codex-cli' || provider === 'claude-code'
      ? requested.reasoning === 'none' ? 'low' : requested.reasoning : provider === 'mock' ? 'synthetic-in-output' : null,
    cache: false as const };
}
