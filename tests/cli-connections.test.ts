import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CliConnection } from '../src/connections/cli.js';
import { executablePath } from '../src/connections/process.js';
import { connectionSchema, loadConfig } from '../src/connections/config.js';
import { CallExecutor } from '../src/call-executor.js';
import { createRunDir, readJsonl } from '../src/storage.js';
import { projectRoot } from '../src/runner.js';
import { fakeCli } from './fake-cli.js';
import { task } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());
describe('Официальные CLI — тестируются только fake executable', () => {
  it('Codex передаёт xhigh без понижения и сохраняет запрошенные и применённые настройки', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'bench-fake-xhigh-'));
    try {
      const fake = fakeCli(temp, 'codex-cli', 'success', join(projectRoot, 'package.json'));
      const connection = new CliConnection(connectionSchema.parse({ provider: 'codex-cli', model: 'pinned-v1', executable: fake.executable, clientHome: fake.clientHome }), [projectRoot]);
      const diagnostic = await connection.diagnose(); expect(diagnostic.status).toBe('ok');
      const c = loadConfig(join(projectRoot, 'configs/pilot-codex-cli.json')); c.generation.reasoning = 'xhigh';
      const { dir } = createRunDir(temp, 'calls'), executor = new CallExecutor('run', dir, c, connection, diagnostic, null);
      expect((await executor.execute(task(), 'pagination-a1', 1, 'prompt')).status).toBe('ok');
      expect(readJsonl<{ args: string[] }>(fake.record)[0]!.args).toContain('model_reasoning_effort="xhigh"');
      expect(executor.calls[0]!.generationParameters).toMatchObject({ requested: { reasoning: 'xhigh' }, applied: { reasoning: 'xhigh' } });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('локальный npm bin не подменяет официальный клиент внутри защищённого проекта', () => {
    const temp = mkdtempSync(join(tmpdir(), 'bench-client-path-'));
    try {
      const local = join(temp, 'protected'), external = join(temp, 'official'); mkdirSync(local); mkdirSync(external);
      for (const dir of [local, external]) { writeFileSync(join(dir, 'codex'), 'fixture, never executed'); chmodSync(join(dir, 'codex'), 0o755); }
      vi.stubEnv('PATH', [local, external].join(delimiter));
      expect(executablePath('codex', [local])).toBe(realpathSync(join(external, 'codex')));
      expect(executablePath(join(local, 'codex'), [local])).toBeNull();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each(['codex-cli', 'claude-code', 'gemini-cli'] as const)('%s: JSON, свежая папка, stdin, без ключей и скрытых проверок', async (provider) => {
    const temp = mkdtempSync(join(tmpdir(), 'bench-fake-cli-'));
    try {
      vi.stubEnv('OPENROUTER_API_KEY', 'fixture-openrouter-key'); vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-anthropic-key');
      const fake = fakeCli(temp, provider, 'success', join(projectRoot, 'fixtures/mock-responses.json'));
      const connection = new CliConnection(connectionSchema.parse({ provider, model: 'pinned-v1', ...{ executable: fake.executable, clientHome: fake.clientHome },
        subscription: { paidOverage: 'disabled' } }), [projectRoot]);
      const diagnostic = await connection.diagnose();
      if (diagnostic.status === 'isolation_unavailable') return; // Платформа без обязательной песочницы блокирует генерацию.
      expect(diagnostic.status).toBe('ok'); expect(existsSync(fake.record)).toBe(false);
      expect(JSON.stringify(diagnostic)).not.toContain('DO-NOT-PERSIST');
      const config = loadConfig(join(projectRoot, `configs/pilot-${provider}.json`)), { dir } = createRunDir(temp, 'calls');
      const executor = new CallExecutor('run', dir, config, connection, diagnostic, null);
      const prompt = `literal $(touch ${join(temp, 'injected')}) ; echo secret`;
      const first = await executor.execute(task(), 'pagination-a1', 1, prompt), second = await executor.execute(task(), 'pagination-a2', 2, prompt);
      expect(first.status).toBe('ok'); expect(second.status).toBe('ok');
      const records = readJsonl<{ cwd: string; input: string; args: string[]; secretEnvNames: string[]; protectedReadable: boolean; files: string[] }>(fake.record);
      expect(records).toHaveLength(2); expect(records[0]!.cwd).not.toBe(records[1]!.cwd);
      for (const record of records) { expect(record.input).toBe(prompt); expect(record.secretEnvNames).toEqual([]); expect(record.protectedReadable).toBe(false);
        expect(record.files.some((p) => /checks|reference|mock-responses/.test(p))).toBe(false); expect(existsSync(record.cwd)).toBe(false); }
      expect(existsSync(join(temp, 'injected'))).toBe(false);
      expect(executor.calls.every((c) => c.billingMode === 'subscription' && c.incurredCostUsd === 0 && c.accountingIncomplete && c.apiRequests === 0)).toBe(true);
      expect(executor.calls[0]!.generationParameters).toMatchObject({ applied: { temperature: null, reasoning: provider === 'gemini-cli' ? null : 'low' }, requested: config.generation });
      expect(executor.calls[0]!.parameters.maxSteps).toBe(Math.min(task().limits.maxSteps, task().limits.maxCalls, config.limits.maxAgentTurns));
      if (provider === 'claude-code') { expect(records[0]!.args).not.toContain('--bare'); const tools = records[0]!.args.indexOf('--tools'); expect(records[0]!.args[tools + 1]).toBe(''); expect(executor.calls[0]!.usage.total).toBe(35); }
      if (provider === 'claude-code') expect(records[0]!.args[records[0]!.args.indexOf('--effort') + 1]).toBe('low');
      if (provider === 'codex-cli') expect(executor.calls[0]!.usage.total).toBe(120);
      if (provider === 'gemini-cli') expect(executor.calls[0]!.usage.total).toBe(135);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each(['no-usage', 'auth-error', 'quota', 'timeout', 'bad-json', 'model-error'] as const)('Codex fake: %s', async (scenario) => {
    const temp = mkdtempSync(join(tmpdir(), 'bench-fake-errors-'));
    try {
      const fake = fakeCli(temp, 'codex-cli', scenario, join(projectRoot, 'package.json'));
      const connection = new CliConnection(connectionSchema.parse({ provider: 'codex-cli', model: 'pinned-v1', executable: fake.executable, clientHome: fake.clientHome }), [projectRoot]);
      const diagnostic = await connection.diagnose(); if (diagnostic.status === 'isolation_unavailable') return;
      const config = loadConfig(join(projectRoot, 'configs/pilot-codex-cli.json')); if (scenario === 'timeout') config.limits.timeoutMs = 160;
      const { dir } = createRunDir(temp, 'calls'), executor = new CallExecutor('run', dir, config, connection, diagnostic, null);
      const t = task(); t.limits.timeoutMs = 1000;
      const first = await executor.execute(t, 'pagination-a1', 1, 'prompt');
      expect(first.status).toBe({ 'no-usage': 'ok', 'auth-error': 'auth_missing', quota: 'quota_exhausted', timeout: 'timeout', 'bad-json': 'invalid_response', 'model-error': 'model_unavailable' }[scenario]);
      if (scenario === 'no-usage') expect(executor.calls[0]!.usage.total).toBeNull();
      if (['quota', 'auth-error', 'model-error'].includes(scenario)) {
        const next = await executor.execute(t, 'pagination-a2', 2, 'prompt'); expect(next.callIds).toHaveLength(0); expect(executor.calls).toHaveLength(1);
        expect(readFileSync(fake.record, 'utf8').trim().split('\n')).toHaveLength(1);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each(['codex-cli', 'claude-code', 'gemini-cli'] as const)('%s: отсутствующий клиент/вход и API вход диагностируются без генерации', async (provider) => {
    expect((await new CliConnection(connectionSchema.parse({ provider, model: 'pinned-v1', executable: '/does-not-exist-bench-cli' }), [projectRoot]).diagnose()).status).toBe('client_missing');
    const temp = mkdtempSync(join(tmpdir(), 'bench-fake-auth-'));
    try {
      for (const scenario of ['no-auth', 'wrong-auth']) {
        const fake = fakeCli(temp, provider, scenario, join(projectRoot, 'package.json'));
        const diagnostic = await new CliConnection(connectionSchema.parse({ provider, model: 'pinned-v1', executable: fake.executable, clientHome: fake.clientHome }), [projectRoot]).diagnose();
        if (diagnostic.status !== 'isolation_unavailable') expect(diagnostic.status).toBe(scenario === 'no-auth' ? 'auth_missing' : 'auth_incompatible');
        expect(existsSync(fake.record)).toBe(false);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('не выдаёт неизвестное состояние Claude usage credits за гарантию бесплатного quota', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'bench-fake-overage-'));
    try {
      const fake = fakeCli(temp, 'claude-code', 'success', join(projectRoot, 'package.json'));
      const diagnostic = await new CliConnection(connectionSchema.parse({ provider: 'claude-code', model: 'pinned-v1', executable: fake.executable, clientHome: fake.clientHome }), [projectRoot]).diagnose();
      if (diagnostic.status !== 'isolation_unavailable') expect(diagnostic.status).toBe('subscription_policy_unknown');
      expect(existsSync(fake.record)).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
