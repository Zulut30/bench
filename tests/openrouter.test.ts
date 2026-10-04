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
  it('literal Llama3 использует границу конкретного UTF-8 запроса; cache, fees, output/reasoning и retries входят в резерв', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret-not-real-key');
    const stub = await httpFixture(({ body, response }) => answer(response, body, 'Привет', { choices: [{ text: 'Привет' }] }), { metadata: {
      architecture: { tokenizer: 'Llama3', input_modalities: ['text', 'image'], output_modalities: ['text'] }, endpoints: [{ tag: 'fixture/isolated', provider_name: 'Fixture', context_length: 8192,
        max_prompt_tokens: 7000, max_completion_tokens: 2048, pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000002', input_cache_write: '0.000003', request: '0.002', image: '0.01' } }] } });
    try {
      const connection = new OpenRouterConnection(connectionSchema.parse({ ...settings, model: 'meta-llama/llama-3.1-8b-instruct', promptTransport: 'raw-llama3' }), stub.baseUrl);
      expect((await connection.diagnose()).status).toBe('ok');
      const concrete = connection.upperBound(256, 0, request)!;
      expect(concrete).toMatchObject({ method: 'raw-byte-bpe', feesUsd: 0.002, outputTokens: 256 }); expect(concrete.inputTokens).toBeLessThan(200);
      const result = await connection.execute(request); expect(result.status).toBe('ok');
      expect(concrete.inputTokens).toBe(Buffer.byteLength(String(stub.bodies[0]!.prompt)) + 2);
      expect(concrete.perCallUsd).toBeCloseTo(concrete.inputTokens! * 0.000003 + 256 * 0.000002 + 0.002, 10);
      expect(result.estimatedCostUsd).toBe(0.002164); expect(stub.bodies[0]).not.toHaveProperty('messages');
      const vision = connection.upperBound(256, 2, { ...request, images: [{ label: 'A', dataUrl: 'data:image/png;base64,YQ==' }, { label: 'B', dataUrl: 'data:image/png;base64,Yg==' }] })!;
      expect(vision).toMatchObject({ method: 'endpoint-context', inputTokens: 7000, feesUsd: 0.022 });
      expect(vision.perCallUsd).toBeCloseTo(7000 * 0.000003 + 256 * 0.000002 + 0.022, 10);
      expect(connection.upperBound(8192, 0, request)).toBeNull(); expect(connection.upperBound(256, 0, { ...request, prompt: 'x'.repeat(8192) })).toBeNull();
      const noFunds = new BudgetLedger({ perRequestUsd: 1, perTaskUsd: 1, runUsd: concrete.perCallUsd * 1.5, monthUsd: 1 }, 'UTC', undefined, undefined, 'api');
      expect(noFunds.reserve('run', 'task', { ...concrete, attemptUsd: concrete.perCallUsd * 2 }, new Date())).toMatchObject({ allowed: false, details: { nextUsd: expect.any(Number), spentUsd: 0, reservedUsd: 0 } });
    } finally { await stub.close(); }
  });
  it('сохраняет generation ID даже при недопустимом usage; неизвестное начисление не превращает в ноль', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret-not-real-key');
    const stub = await httpFixture(({ body, response }) => answer(response, body, 'ok', { id: 'gen-invalid-usage', usage: { prompt_tokens: -1, cost: 'bad' } }));
    try {
      const connection = new OpenRouterConnection(settings, stub.baseUrl); await connection.diagnose(); let id = '';
      const result = await connection.execute({ ...request, onGenerationId: value => { id = value; } });
      expect(result.status).toBe('invalid_response'); expect(id).toBe('gen-invalid-usage'); expect(result.incurredCostUsd).toBeNull();
    } finally { await stub.close(); }
  });
  it.each([undefined, ['image'], ['text','audio']])('не отправляет генерацию с неизвестной границей выходных модальностей: %j', async outputs => {
    vi.stubEnv('OPENROUTER_API_KEY','fixture-secret-not-real-key');
    const stub=await httpFixture(({body,response})=>answer(response,body,'must not happen'),{metadata:{architecture:{input_modalities:['text'],output_modalities:outputs},endpoints:[{tag:'fixture/isolated',provider_name:'Fixture',context_length:8192,pricing:{prompt:0.000001,completion:0.000002,image:0.01}}]}});
    try{const connection=new OpenRouterConnection(settings,stub.baseUrl);expect((await connection.diagnose()).status).toBe('model_unavailable');expect((await connection.execute(request)).sent).toBe(false);expect(stub.bodies).toHaveLength(0);}finally{await stub.close();}
  });
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
