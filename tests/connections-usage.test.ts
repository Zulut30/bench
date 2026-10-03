import { describe, expect, it } from 'vitest';
import { normalizeOpenRouterUsage, normalizeClaudeUsage, normalizeCodexUsage, normalizeGeminiUsage } from '../src/usage.js';
import { parseClaude, parseCodex, parseGemini } from '../src/connections/parsers.js';
import { aggregate } from '../src/aggregate.js';
import { attempt, call, suite } from './helpers.js';

describe('Usage официальных клиентов', () => {
  it('OpenRouter: input/output включают кеш и reasoning; unknown отличается от нуля', () => {
    expect(normalizeOpenRouterUsage({ prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 20 } })).toMatchObject({ inputTotal: 100, outputTotal: 40, total: 140, reasoning: 20, cacheRead: 30, cacheWrite: 10, complete: true });
    expect(normalizeOpenRouterUsage({})).toMatchObject({ inputTotal: null, outputTotal: null, source: 'unknown', complete: false });
    expect(normalizeOpenRouterUsage({ prompt_tokens: 0, completion_tokens: 0 })).toMatchObject({ total: 0, cacheRead: null, complete: false });
    expect(() => normalizeOpenRouterUsage({ prompt_tokens: -1 })).toThrow();
    expect(() => normalizeOpenRouterUsage({ prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } })).toThrow();
  });
  it('Anthropic: кеш добавляется к input; thinking уже входит в output', () => {
    expect(normalizeClaudeUsage({ input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 50, reasoning_tokens: 30 })).toMatchObject({ inputTotal: 70, outputTotal: 50, total: 120, reasoning: 30 });
    expect(normalizeClaudeUsage({ input_tokens: 10, output_tokens: 50 }).inputTotal).toBeNull();
  });
  it('Gemini: prompt включает кеш, candidates и thoughts складываются один раз', () => {
    expect(normalizeGeminiUsage({ prompt: 100, tool: 10, candidates: 20, thoughts: 5, cached: 60 })).toMatchObject({ inputTotal: 110, outputTotal: 25, total: 135, reasoning: 5, cacheRead: 60 });
    expect(normalizeGeminiUsage({ prompt: 100, candidates: 20 }).outputTotal).toBeNull();
  });
  it('Codex: последняя сводка новой сессии, а не сводки + отдельные события', () => {
    const parsed = parseCodex([{ type: 'thread.started', thread_id: 'fresh' }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } },
      { type: 'item.completed', item: { id: 'x', type: 'agent_message', text: 'ok', usage: { input_tokens: 999 } } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5 } }].map((value) => JSON.stringify(value)).join('\n'));
    expect(parsed.usage).toEqual(normalizeCodexUsage({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5 }));
    expect(parsed.usage.total).toBe(120); expect(parsed.usageScope).toBe('session-summary');
  });
  it('Claude: usage и modelUsage не дублируются; total_cost только API-эквивалент', () => {
    const parsed = parseClaude([{ type: 'system', subtype: 'init', model: 'pinned', tools: [] },
      { type: 'assistant', message: { usage: { input_tokens: 999 } } },
      { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 5 }, modelUsage: { pinned: { inputTokens: 30, outputTokens: 5 } } }].map((value) => JSON.stringify(value)).join('\n'));
    expect(parsed.usage.total).toBe(35); expect(parsed.incurredCostUsd).toBe(0); expect(parsed.estimatedCostUsd).toBe(0.01);
  });
  it('Gemini: только сводка models; общий total не прибавляется', () => {
    const parsed = parseGemini(JSON.stringify({ response: 'ok', stats: { models: { pinned: { tokens: { prompt: 100, tool: 0, candidates: 20, thoughts: 5, cached: 60 }, api: { totalRequests: 2 } } }, total: 999 } }));
    expect(parsed.usage.total).toBe(125); expect(parsed.agentSteps).toBe(2); expect(parsed.internalRetries).toBeNull();
    expect(() => parseGemini('{broken')).toThrow(); expect(() => parseClaude('{}')).toThrow(); expect(() => parseCodex('{}')).toThrow();
  });
  it('режимы оплаты разделены, judge и retry учтены, неизвестное списание не превращается в ноль', () => {
    const records = [call({ billingMode: 'subscription', incurredCostUsd: 0, modeledCostUsd: 0.2 }),
      call({ callId: 'judge', role: 'judge', billingMode: 'api', incurredCostUsd: 0.01, modeledCostUsd: 0.008 }),
      call({ callId: 'retry', retryIndex: 1, billingMode: 'api', incurredCostUsd: null, modeledCostUsd: null })];
    const summary = aggregate([...records, records[0]!], [attempt()], suite, 'UTC');
    expect(summary.totals.callCount).toBe(3); expect(summary.totals.incurredCostUsd).toBeNull();
    expect(summary.totals.actualCosts).toMatchObject({ judgeInitial: { value: 0.01 }, retries: { value: null }, total: { known: 0.01 } });
    expect(Object.keys(summary.byBillingMode).sort()).toEqual(['api', 'subscription']);
    expect(summary.totals.incurredCostPerSuccessUsd).toBeNull();
  });
});
