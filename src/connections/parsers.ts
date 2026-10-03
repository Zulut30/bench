import { z } from 'zod';
import { normalizeClaudeUsage, normalizeCodexUsage, normalizeGeminiUsage, unknownUsage } from '../usage.js';
import { sumKnown } from '../aggregate.js';
import { errorStatus } from './process.js';
import type { ConnectionResult } from './types.js';

const object = z.looseObject({});
const event = z.looseObject({ type: z.string() });
export function emptyResult(): ConnectionResult {
  return { status: 'ok', reason: '', output: null, raw: {}, rawUsage: {}, usage: unknownUsage(), incurredCostUsd: 0,
    estimatedCostUsd: null, returnedModel: null, returnedProvider: null, generationId: null,
    agentSteps: null, internalRetries: null, usageScope: 'unknown', sent: true };
}
export function parseCodex(stdout: string): ConnectionResult {
  const events = stdout.trim().split('\n').filter(Boolean).map((line) => event.parse(JSON.parse(line)));
  const result = emptyResult(); result.raw = events;
  const failed = events.find((e) => e.type === 'error' || e.type === 'turn.failed');
  if (failed) { result.status = errorStatus(JSON.stringify(failed)); result.reason = JSON.stringify(failed); }
  const summaries = events.filter((e) => e.type === 'turn.completed');
  const last = summaries.at(-1);
  if (!last && !failed) throw new Error('Нет turn.completed в Codex JSONL');
  result.rawUsage = last?.usage ? object.parse(last.usage) : {};
  result.usage = normalizeCodexUsage(result.rawUsage); result.usageScope = 'session-summary';
  const messages = events.filter((e) => e.type === 'item.completed').map((e) => object.parse(e.item));
  const answer = messages.filter((m) => m.type === 'agent_message').at(-1);
  result.output = answer ? z.string().parse(answer.text) : null;
  const start = events.find((e) => e.type === 'thread.started');
  result.generationId = typeof start?.thread_id === 'string' ? start.thread_id : null;
  result.returnedModel = typeof last?.model === 'string' ? last.model : null;
  result.agentSteps = summaries.length + messages.filter((m) => ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(String(m.type))).length;
  if (!result.output && result.status === 'ok') throw new Error('Нет финального agent_message');
  return result;
}
export function parseClaude(stdout: string): ConnectionResult {
  const events = stdout.trim().split('\n').filter(Boolean).map((line) => event.parse(JSON.parse(line)));
  const summary = events.findLast((e) => e.type === 'result');
  if (!summary) throw new Error('Нет result в Claude stream-json');
  const result = emptyResult(); result.raw = events;
  result.output = typeof summary.result === 'string' ? summary.result : null;
  if (summary.is_error === true || summary.subtype !== 'success') {
    result.reason = JSON.stringify(summary); result.status = summary.subtype === 'error_max_turns' ? 'limit_exceeded' : errorStatus(result.reason);
  }
  result.rawUsage = summary.usage ? object.parse(summary.usage) : {};
  result.usage = normalizeClaudeUsage(result.rawUsage); result.usageScope = 'session-summary';
  result.estimatedCostUsd = typeof summary.total_cost_usd === 'number' ? z.number().nonnegative().finite().parse(summary.total_cost_usd) : null;
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  result.returnedModel = typeof init?.model === 'string' ? init.model : null;
  const models = summary.modelUsage ? Object.keys(object.parse(summary.modelUsage)) : [];
  if (models.length === 1) result.returnedModel = models[0]!;
  if (models.length > 1) result.returnedModel = models.sort().join('+');
  result.generationId = typeof summary.session_id === 'string' ? summary.session_id : null;
  result.agentSteps = typeof summary.num_turns === 'number' ? z.number().int().nonnegative().parse(summary.num_turns) : null;
  if (result.status === 'ok' && !result.output) throw new Error('Нет текстового result');
  return result;
}
export function parseGemini(stdout: string): ConnectionResult {
  const json = z.looseObject({ response: z.string().optional(), stats: object.optional(), error: object.optional() }).parse(JSON.parse(stdout));
  const result = emptyResult(); result.raw = json; result.output = json.response ?? null;
  if (json.error) { result.reason = JSON.stringify(json.error); result.status = errorStatus(result.reason); }
  const models = json.stats?.models ? object.parse(json.stats.models) : {};
  const usages = Object.values(models).map((m) => { const model = object.parse(m); return normalizeGeminiUsage(model.tokens ? object.parse(model.tokens) : {}); });
  result.rawUsage = models; result.usageScope = 'session-summary';
  if (usages.length) {
    const sum = (k: 'inputTotal' | 'outputTotal' | 'reasoning' | 'cacheRead' | 'cacheWrite' | 'total') => sumKnown(usages.map((u) => u[k])).value;
    result.usage = { inputTotal: sum('inputTotal'), outputTotal: sum('outputTotal'), reasoning: sum('reasoning'),
      cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), total: sum('total'),
      source: usages.every((u) => u.source === 'unknown') ? 'unknown' : 'provider', complete: usages.every((u) => u.complete), synthetic: false };
    result.returnedModel = Object.keys(models).sort().join('+');
  }
  const apiCalls = Object.values(models).map((m) => object.parse(m).api).filter(Boolean).map((api) => object.parse(api));
  const requests = apiCalls.map((api) => typeof api.totalRequests === 'number' ? api.totalRequests : null);
  result.agentSteps = requests.length ? sumKnown(requests.map((count) => count === null ? null : z.number().int().nonnegative().parse(count))).value : null;
  result.generationId = typeof json.session_id === 'string' ? json.session_id : null;
  if (result.status === 'ok' && result.output === null) throw new Error('Нет response в Gemini JSON');
  return result;
}
