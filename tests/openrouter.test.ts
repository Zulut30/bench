import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionSchema, loadConfig } from '../src/connections/config.js';
import type { ConnectionRequest } from '../src/connections/types.js';
import { OpenRouterConnection } from '../src/connections/openrouter.js';
import { CallExecutor } from '../src/call-executor.js';
import { BudgetLedger } from '../src/budget.js';
import { createRunDir, filesUnder } from '../src/storage.js';
import { projectRoot } from '../src/runner.js';
import { task } from './helpers.js';
import { answer, httpFixture } from './http-fixture.js';

const settings = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/pilot-v1', providerEndpoint: 'fixture/isolated' });
const request: ConnectionRequest = { prompt: 'Задание', taskId: 'pagination', attemptIndex: 1, workspace: tmpdir(), timeoutMs: 1000,
  maxOutputTokens: 256, maxAgentTurns: 1, temperature: 0, reasoning: 'none', images: [] };
afterEach(() => vi.unstubAllEnvs());
describe('OpenRouter — только локальная HTTP заглушка', () => {
  it.each(['success', 'no-usage', 'auth', 'quota', 'bad-json', 'bad-shape', 'timeout', 'route'] as const)('%s', async (scenario) => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret-not-real-key');
    const stub = await httpFixture(({ response, body }) => {
      if (scenario === 'auth' || scenario === 'quota') { response.statusCode = scenario === 'auth' ? 401 : 429; response.end(JSON.stringify({ error: { message: scenario === 'auth' ? 'Unauthorized fixture-secret-not-real-key' : 'quota exhausted' } })); }
      else if (scenario === 'bad-json') response.end('{broken');
      else if (scenario === 'bad-shape') answer(response, body, 'ok', { choices: [{ message: { content: 123 } }] });
      else if (scenario === 'timeout') { /* Таймаут до ответа. */ }
      else answer(response, body, 'ok', scenario === 'no-usage' ? { usage: undefined } : scenario === 'route' ? { model: 'replaced-model', provider: 'Other' } : {});
    });
    try {
      const connection = new OpenRouterConnection(settings, stub.baseUrl); expect((await connection.diagnose()).status).toBe('ok');
      const result = await connection.execute({ ...request, timeoutMs: scenario === 'timeout' ? 70 : 1000 });
      expect(result.status).toBe({ success: 'ok', 'no-usage': 'ok', auth: 'auth_missing', quota: 'quota_exhausted', 'bad-json': 'invalid_response', 'bad-shape': 'invalid_response', timeout: 'timeout', route: 'route_changed' }[scenario]);
      expect(stub.bodies[0]).toMatchObject({ model: 'vendor/pilot-v1', stream: false, max_tokens: 256,
        provider: { only: ['fixture/isolated'], order: ['fixture/isolated'], allow_fallbacks: false, require_parameters: true } });
      expect(stub.bodies[0]).not.toHaveProperty('models');
      if (scenario === 'success') { expect(result.usage.total).toBe(140); expect(result.incurredCostUsd).toBe(0.0005); expect(result.estimatedCostUsd).toBe(0.000164); }
      if (scenario === 'no-usage') { expect(result.usage.inputTotal).toBeNull(); expect(result.incurredCostUsd).toBeNull(); }
      expect(JSON.stringify(result)).not.toContain('fixture-secret-not-real-key');
    } finally { await stub.close(); }
  });
  it('показывает endpoint tags без ключа и POST, чтобы закрепить маршрут до запуска', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const stub = await httpFixture(({ response, body }) => answer(response, body, 'must not be called'));
    try {
      const connection = new OpenRouterConnection(connectionSchema.parse({ provider: 'openrouter', model: settings.model }), stub.baseUrl);
      const diagnostic = await connection.diagnose();
      expect(diagnostic.status).toBe('model_missing'); expect(diagnostic.config.availableEndpoints).toMatchObject([{ tag: 'fixture/isolated' }]);
      expect((await connection.execute(request)).sent).toBe(false); expect(stub.bodies).toHaveLength(0);
    } finally { await stub.close(); }
  });
  it('отказывает до POST при отсутствии ключа или закреплённой модели/endpoint', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const stub = await httpFixture(({ response, body }) => answer(response, body, 'wrong'));
    try {
      const connection = new OpenRouterConnection(settings, stub.baseUrl); expect((await connection.diagnose()).status).toBe('auth_missing');
      expect((await connection.execute(request)).sent).toBe(false);
      const noModel = new OpenRouterConnection(connectionSchema.parse({ provider: 'openrouter' }), stub.baseUrl);
      expect((await noModel.diagnose()).status).toBe('model_missing'); expect(stub.bodies).toHaveLength(0);
    } finally { await stub.close(); }
  });
  it('резерв учитывает параллельные вызовы, а неизвестная цена удерживает его после ответа', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret-not-real-key');
    let release: () => void = () => {}, entered: () => void = () => {};
    const received = new Promise<void>((done) => { entered = done; });
    const stub = await httpFixture(async ({ response, body }) => { entered(); await new Promise<void>((done) => { release = done; }); answer(response, body, 'ok', { usage: undefined }); });
    const temp = mkdtempSync(join(tmpdir(), 'bench-budget-api-'));
    try {
      const connection = new OpenRouterConnection(settings, stub.baseUrl), diagnostic = await connection.diagnose(), bound = connection.upperBound(256, 0)!;
      const ledger = new BudgetLedger({ perRequestUsd: 1, perTaskUsd: 1, runUsd: bound.perCallUsd, monthUsd: 1 }, 'UTC', undefined, undefined, 'api');
      const config = loadConfig(join(projectRoot, 'configs/pilot-openrouter.json')); config.limits.maxOutputTokens = 256; config.limits.maxRetries = 0;
      const { dir } = createRunDir(temp, 'test'); const executor = new CallExecutor('atomic-run', dir, config, connection, diagnostic, ledger);
      const t = task(); t.limits.maxRetries = 0;
      const first = executor.execute(t, 'a1', 1, 'small'); await received;
      const second = await executor.execute(t, 'a2', 2, 'small'); expect(second.status).toBe('budget_exhausted'); expect(stub.bodies).toHaveLength(1);
      release(); expect((await first).status).toBe('ok');
      const account = ledger.snapshot().runs['atomic-run']!; expect(account.spentMicroUsd).toBe(0); expect(account.reservedMicroUsd).toBeGreaterThan(0);
      expect(Object.values(ledger.snapshot().reservations)[0]).toMatchObject({ reconciliationRequired: true, finished: true });
      expect((await executor.execute(t, 'a3', 3, 'small')).status).toBe('budget_exhausted');
      expect(filesUnder(dir).filter((p) => p.endsWith('.json') || p.endsWith('.jsonl')).every((p) => !readFileSync(join(dir, p), 'utf8').includes('fixture-secret-not-real-key'))).toBe(true);
    } finally { release(); await stub.close(); rmSync(temp, { recursive: true, force: true }); }
  });
  it('API и synthetic journals несовместимы, overcharge замораживает последующие запросы', () => {
    const limits = { perRequestUsd: 1, perTaskUsd: 1, runUsd: 1, monthUsd: 1 };
    const synthetic = new BudgetLedger(limits, 'UTC');
    expect(() => new BudgetLedger(limits, 'UTC', synthetic.snapshot(), undefined, 'api')).toThrow('смешивать');
    const api = new BudgetLedger(limits, 'UTC', undefined, undefined, 'api'); api.freeze('сверка');
    expect(api.reserve('run', 'task', { perCallUsd: 0.1, attemptUsd: 0.1 }, new Date())).toMatchObject({ allowed: false });
  });
});
