import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tariff } from '../schema.js';
import { hash } from '../storage.js';
import type { ConnectionConfig } from './config.js';
import type { ConnectionRequest, ConnectionResult, Diagnostic, ModelConnection } from './types.js';
import { clientEnvironment, errorStatus, executablePath, executeProcess, isolatedCommand, redact } from './process.js';
import { emptyResult, parseClaude, parseCodex, parseGemini } from './parsers.js';

const defaultExecutable = { 'codex-cli': 'codex', 'claude-code': 'claude', 'gemini-cli': 'gemini' };
const object = z.looseObject({});
export class CliConnection implements ModelConnection {
  private diagnostic: Diagnostic | null = null;
  private executable: string | null = null;
  constructor(readonly config: ConnectionConfig, private readonly protectedPaths: string[]) {}
  tariff(): Tariff | null { return null; }
  upperBound(): { perCallUsd: number; attemptUsd: number } { return { perCallUsd: 0, attemptUsd: 0 }; }
  private environment(): NodeJS.ProcessEnv {
    const env = clientEnvironment(homedir());
    if (this.config.provider === 'codex-cli') {
      env.CODEX_HOME = this.config.clientHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    } else if (this.config.provider === 'claude-code') {
      const configDir = this.config.clientHome ?? process.env.CLAUDE_CONFIG_DIR;
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      env.DISABLE_TELEMETRY = '1'; env.DISABLE_ERROR_REPORTING = '1'; env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      env.DISABLE_EXTRA_USAGE_COMMAND = '1'; env.CLAUDE_CODE_MAX_RETRIES = '0';
    } else {
      env.GEMINI_CLI_HOME = this.config.clientHome ?? process.env.GEMINI_CLI_HOME ?? homedir();
      env.GEMINI_TELEMETRY_ENABLED = 'false';
    }
    return env;
  }
  private clientPaths(env: NodeJS.ProcessEnv): string[] {
    return this.config.provider === 'codex-cli' ? [String(env.CODEX_HOME)] : this.config.provider === 'claude-code'
      ? [env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')] : [join(String(env.GEMINI_CLI_HOME), '.gemini')];
  }
  async diagnose(): Promise<Diagnostic> {
    const provider = this.config.provider as keyof typeof defaultExecutable;
    const mode = provider === 'claude-code' && this.config.executionMode === 'model-only' ? 'model-only' : 'agent';
    const diagnostic: Diagnostic = { provider, status: 'ok', reason: '', version: null, authMethod: null, configuredModel: this.config.model,
      modelAvailability: 'unverified', executionMode: mode, tools: mode === 'model-only' ? [] : ['client-managed; restricted workspace'],
      config: { freshSession: true, responseCache: false, authManagedByClient: true,
        outputTokenLimit: provider === 'claude-code' ? 'client-setting-and-observed' : 'observed-only; timeout/step/byte caps',
        settings: provider === 'codex-cli' ? 'ignore-user-config, ignore-rules, read-only, web-search disabled' : provider === 'claude-code' ? 'safe-mode, restricted, no tools/MCP in model-only' : 'project/system settings, oauth-personal, overage never' } };
    this.executable = executablePath(this.config.executable ?? defaultExecutable[provider], this.protectedPaths);
    if (!this.executable) return this.diagnostic = { ...diagnostic, status: 'client_missing', reason: `Не найден ${this.config.executable ?? defaultExecutable[provider]}` };
    const temp = mkdtempSync(join(tmpdir(), 'bench-diagnostics-'));
    try {
      const env = this.environment();
      const version = await executeProcess(this.executable, ['--version'], { cwd: temp, env, timeoutMs: 10_000 });
      const help = await executeProcess(this.executable, provider === 'codex-cli' ? ['exec', '--help'] : ['--help'], { cwd: temp, env, timeoutMs: 10_000 });
      diagnostic.version = String(redact(version.stdout.trim())) || null;
      const required = provider === 'codex-cli' ? ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox']
        : provider === 'claude-code' ? ['--safe-mode', '--restricted', '--tools', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '--effort']
          : ['--output-format', '--model', '--sandbox'];
      if (version.code !== 0 || help.code !== 0 || required.some((flag) => !help.stdout.includes(flag))) {
        return this.diagnostic = { ...diagnostic, status: 'unsupported_client', reason: 'Установленный клиент не подтверждает необходимые флаги --help' };
      }
      if (provider === 'codex-cli') {
        const auth = await executeProcess(this.executable, ['login', 'status'], { cwd: temp, env, timeoutMs: 10_000 });
        const text = auth.stdout + auth.stderr;
        diagnostic.authMethod = /ChatGPT/i.test(text) ? 'chatgpt' : /api.?key/i.test(text) ? 'api-key' : null;
        if (auth.code !== 0 || diagnostic.authMethod !== 'chatgpt') diagnostic.status = diagnostic.authMethod ? 'auth_incompatible' : 'auth_missing';
      } else if (provider === 'claude-code') {
        const auth = await executeProcess(this.executable, ['auth', 'status'], { cwd: temp, env, timeoutMs: 10_000 });
        let json: Record<string, unknown> = {};
        try { json = object.parse(JSON.parse(auth.stdout)); } catch { /* Старый/неавторизованный клиент. */ }
        diagnostic.authMethod = typeof json.authMethod === 'string' ? json.authMethod : null;
        // Email, организация, OAuth и содержимое credential store никогда не сохраняются.
        if (auth.code !== 0 || json.loggedIn !== true || diagnostic.authMethod !== 'claude.ai') diagnostic.status = json.loggedIn === true ? 'auth_incompatible' : 'auth_missing';
      } else {
        const home = String(env.GEMINI_CLI_HOME);
        const path = join(home, '.gemini', 'settings.json');
        let json: Record<string, unknown> = {};
        try { json = object.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* Нет настроенного входа. */ }
        const security = json.security ? object.parse(json.security) : {};
        const auth = security.auth ? object.parse(security.auth) : {};
        diagnostic.authMethod = typeof auth.selectedType === 'string' ? auth.selectedType : null;
        // Проверяем только наличие файла, не читаем OAuth credentials.
        if (diagnostic.authMethod !== 'oauth-personal') diagnostic.status = diagnostic.authMethod ? 'auth_incompatible' : 'auth_missing';
        else if (!existsSync(join(home, '.gemini', 'oauth_creds.json'))) diagnostic.status = 'auth_missing';
      }
      if (diagnostic.status !== 'ok') diagnostic.reason = 'Нужен официальный подписочный вход клиента; платный API fallback запрещён';
      if (provider === 'claude-code' && diagnostic.status === 'ok' && this.config.subscription.paidOverage !== 'disabled') {
        diagnostic.status = 'subscription_policy_unknown';
        diagnostic.reason = 'Отключите Usage credits в аккаунте Claude и укажите subscription.paidOverage=disabled. CLI не предоставляет проверку этого server-side переключателя без генерации.';
      }
      if (diagnostic.status === 'ok' && (!this.config.model || ['auto', 'pro', 'flash', 'opus', 'sonnet', 'fable'].includes(this.config.model))) {
        diagnostic.status = 'model_missing'; diagnostic.reason = 'Укажите конкретный model ID; доступность аккаунту без генерации не подтверждается';
      }
      const isolated = isolatedCommand(this.executable, ['--version'], temp, this.protectedPaths, this.clientPaths(env));
      const probe = isolated ? await executeProcess(isolated.executable, isolated.args, { cwd: temp, env, timeoutMs: 10_000 }) : null;
      if (!probe || probe.code !== 0 || probe.status !== 'ok') {
        diagnostic.status = 'isolation_unavailable'; diagnostic.reason = 'Нужен sandbox-exec (macOS) или bubblewrap (Linux); без файловой изоляции запуск запрещён';
      }
      diagnostic.config = { ...diagnostic.config, executable: this.executable, configHash: hash(JSON.stringify({ model: this.config.model, mode, tools: diagnostic.tools, settings: diagnostic.config.settings })) };
      return this.diagnostic = diagnostic;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  async execute(request: ConnectionRequest): Promise<ConnectionResult> {
    const base = emptyResult();
    if (!this.diagnostic || this.diagnostic.status !== 'ok' || !this.executable || !this.config.model) {
      return { ...base, sent: false, status: this.diagnostic?.status ?? 'auth_missing', reason: this.diagnostic?.reason ?? 'Сначала выполните диагностику' };
    }
    const env = this.environment();
    let args: string[];
    if (this.config.provider === 'codex-cli') args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--color', 'never', '--model', this.config.model,
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'web_search="disabled"',
      '-c', `model_reasoning_effort=${JSON.stringify(request.reasoning === 'none' ? 'low' : request.reasoning)}`, '-'];
    else if (this.config.provider === 'claude-code') {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxOutputTokens);
      args = ['--print', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--restricted', '--setting-sources', '',
        '--settings', '{"disableAllHooks":true,"fastMode":false,"fastModePerSessionOptIn":true,"fallbackModel":[]}', '--tools', this.diagnostic.executionMode === 'model-only' ? '' : 'Read,Glob,Grep',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk',
        '--no-session-persistence', '--session-id', randomUUID(), '--model', this.config.model,
        '--effort', request.reasoning === 'none' ? 'low' : request.reasoning, '--max-turns', String(request.maxAgentTurns)];
    } else {
      mkdirSync(join(request.workspace, '.gemini'));
      const settings = { model: { name: this.config.model, maxSessionTurns: request.maxAgentTurns },
        security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' }, disableYoloMode: true },
        general: { retryFetchErrors: false, plan: { modelRouting: false } }, billing: { overageStrategy: 'never' },
        telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, mcpServers: {},
        tools: { core: [], exclude: ['run_shell_command', 'read_file', 'read_many_files', 'write_file', 'replace', 'glob', 'search_file_content', 'web_fetch', 'google_web_search'] } };
      const path = join(request.workspace, '.gemini', 'settings.json'); writeFileSync(path, JSON.stringify(settings), { flag: 'wx' });
      writeFileSync(join(request.workspace, '.env'), '', { flag: 'wx' });
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path;
      args = ['--output-format', 'json', '--model', this.config.model, '--sandbox'];
    }
    const command = isolatedCommand(this.executable, args, request.workspace, this.protectedPaths, this.clientPaths(env));
    if (!command) return { ...base, sent: false, status: 'isolation_unavailable', reason: 'Не удалось подготовить файловую изоляцию' };
    let steps = 0;
    const processResult = await executeProcess(command.executable, command.args, { cwd: request.workspace, env, input: request.prompt,
      timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}),
      ...(this.config.provider !== 'gemini-cli' ? { onLine: (line: string) => {
        const json = object.parse(JSON.parse(line));
        if (json.type === 'error' || json.type === 'turn.failed' || json.type === 'result' && json.is_error) {
          const status = errorStatus(JSON.stringify(json)); if (status === 'quota_exhausted' || status === 'auth_missing') return status;
        }
        if (json.type === 'turn.started' || json.type === 'assistant' || json.type === 'item.started'
          && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(String(object.parse(json.item).type))) steps++;
        return steps > request.maxAgentTurns ? 'limit_exceeded' as const : null;
      } } : {}),
    });
    if (processResult.status !== 'ok') return { ...base, status: processResult.status, reason: `Клиент остановлен: ${processResult.status}`,
      raw: redact(processResult), agentSteps: steps || null };
    try {
      const result = this.config.provider === 'codex-cli' ? parseCodex(processResult.stdout) : this.config.provider === 'claude-code' ? parseClaude(processResult.stdout) : parseGemini(processResult.stdout);
      result.raw = redact(result.raw); result.output = result.output === null ? null : String(redact(result.output)); result.reason = String(redact(result.reason));
      if (processResult.code !== 0 && result.status === 'ok') { result.status = errorStatus(processResult.stderr); result.reason = String(redact(processResult.stderr)); }
      if (result.returnedModel && result.returnedModel !== this.config.model && result.status === 'ok') { result.status = 'route_changed'; result.reason = 'Клиент фактически использовал другую модель'; }
      return result;
    } catch (error) { return { ...base, status: processResult.code === 0 ? 'invalid_response' : errorStatus(processResult.stderr),
      reason: String(redact(error instanceof Error ? error.message : String(error))), raw: redact(processResult) }; }
  }
}
