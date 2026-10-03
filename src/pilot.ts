import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse, TestCase } from 'promptfoo';
import { aggregate } from './aggregate.js';
import { BudgetLedger, budgetStateSchema } from './budget.js';
import { assess, BrowserChecks, evaluateChecks } from './checks.js';
import { CallExecutor } from './call-executor.js';
import type { Execution } from './call-executor.js';
import { createConnection } from './connections/index.js';
import { billingMode, effectiveGeneration } from './connections/config.js';
import type { RunConfig } from './connections/config.js';
import type { ModelConnection } from './connections/types.js';
import { redact } from './connections/process.js';
import { environment, prepareOfflineRuntime, projectRoot, taskPrompt } from './runner.js';
import { renderRun } from './report.js';
import { suiteSchema } from './schema.js';
import type { Suite } from './schema.js';
import { appendJsonl, atomicJson, createRunDir, finalizeIntegrity, hash, readJson, withProjectLock, writeJson } from './storage.js';
import { withApiNetwork, withoutNetwork } from './offline.js';
import type { AttemptRecord, CheckResult, Manifest, SavedRun } from './types.js';

export function pilotSuite(config: RunConfig): Suite {
  const suite = suiteSchema.parse(readJson(resolve(projectRoot, config.suite)));
  return suiteSchema.parse({ ...suite, tasks: suite.tasks.map((t) => ({ ...t, limits: { ...t.limits,
    attempts: config.limits.attempts, timeoutMs: Math.min(t.limits.timeoutMs, config.limits.timeoutMs),
    maxRetries: Math.min(t.limits.maxRetries, config.limits.maxRetries, t.limits.maxCalls - 1), maxJudgeCalls: Math.min(t.limits.maxJudgeCalls, config.limits.maxJudgeCalls),
  } })) });
}
export function apiLedger(root: string, config: RunConfig, budgetUsd: number | undefined): BudgetLedger {
  if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('API требует явного --budget <USD>, больше нуля');
  const path = join(root, '.api-budget.json');
  return new BudgetLedger({ ...config.apiBudget, runUsd: budgetUsd }, config.timezone,
    existsSync(path) ? budgetStateSchema.parse(readJson(path)) : undefined, (state) => atomicJson(path, state), 'api');
}
export async function dryRun(config: RunConfig, options: { apiBaseUrl?: string; budgetUsd?: number; baseline?: string; resultsDir?: string } = {}) {
  const suite = pilotSuite(config);
  const connection = createConnection(config.candidate, [projectRoot], options);
  const diagnostic = await connection.diagnose();
  const mode = billingMode(config.candidate.provider);
  const requests = suite.tasks.filter((t) => t.readiness === 'enabled').map((t) => {
    const bound = connection.upperBound(Math.min(t.limits.maxOutputTokens, config.limits.maxOutputTokens), 0);
    const attempts = t.limits.attempts, retries = t.limits.maxRetries;
    return { taskId: t.id, primaryCategory: t.primaryCategory, checkKind: t.primaryCategory === 'backend' ? 'JSON contract only' : 'objective + pending rubric',
      attempts, requests: attempts * (1 + retries), upperCostUsd: mode === 'api' ? bound ? bound.perCallUsd * attempts * (1 + retries) : null : 0,
      promptBytes: Buffer.byteLength(taskPrompt(t)), subjective: t.rubric.categories.length ? 'pending; separate evaluate command' : 'not_required' };
  });
  const knownUpperUsd = requests.reduce((sum, r) => sum + (r.upperCostUsd ?? 0), 0);
  const preview = [];
  const path = join(options.resultsDir ?? join(projectRoot, 'results'), '.api-budget.json');
  if (mode === 'api') {
    const ledger = new BudgetLedger({ ...config.apiBudget, runUsd: options.budgetUsd ?? 0 }, config.timezone,
      existsSync(path) ? budgetStateSchema.parse(readJson(path)) : undefined, undefined, 'api');
    for (const task of suite.tasks.filter((t) => t.readiness === 'enabled')) {
      const bound = connection.upperBound(Math.min(task.limits.maxOutputTokens, config.limits.maxOutputTokens), 0);
      for (let i = 0; i < task.limits.attempts; i++) preview.push({ taskId: task.id, attempt: i + 1,
        decision: ledger.reserve('dry-run-preview', task.id, bound ? { ...bound, attemptUsd: bound.perCallUsd * (1 + task.limits.maxRetries) } : null, new Date()) });
    }
  }
  return { command: 'dry-run', provider: config.candidate.provider, billingMode: mode, diagnostic, requests,
    noGenerations: true, upperCostUsd: requests.some((r) => r.upperCostUsd === null) ? null : knownUpperUsd,
    budgetUsd: options.budgetUsd ?? null, budgetSufficient: mode !== 'api' ? true : options.budgetUsd === undefined || requests.some((r) => r.upperCostUsd === null) ? null : knownUpperUsd <= options.budgetUsd,
    reservationPreview: preview, journalPath: mode === 'api' ? path : null, journalModified: false,
    budgetNote: 'Резерв API по полному контексту endpoint; после известного списания неиспользованный остаток освобождается. Перезапуск/месячный журнал проверяются перед каждой отправкой.',
    judges: { ...config.judges, note: 'Судьи запускаются отдельной командой evaluate с отдельным явным API-бюджетом; этот план только кандидатский', baseline: options.baseline ?? null },
    uncoveredCategories: (await import('./categories.js')).categoryIds.filter((id) => !suite.tasks.some((t) => t.evaluationCategories.includes(id))) };
}

class PilotProvider implements ApiProvider {
  private readonly visited = new Set<string>();
  constructor(private readonly suite: Suite, private readonly executor: CallExecutor) {}
  id() { return `practical:${this.executor.connection.config.provider}`; }
  toJSON() { return { id: this.id(), label: this.executor.connection.config.model ?? 'mock-practical-v1' }; }
  async callApi(prompt: string, context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    const task = this.suite.tasks.find((t) => t.id === context?.vars.taskId), index = Number(context?.vars.attemptIndex);
    if (!task || !Number.isInteger(index) || index < 1 || index > task.limits.attempts) throw new Error('Неверное задание promptfoo');
    const attemptId = `${task.id}-a${index}`;
    if (this.visited.has(attemptId)) throw new Error('Повторная отправка одной попытки движком');
    this.visited.add(attemptId);
    const execution = await this.executor.execute(task, attemptId, index, prompt, [], options?.abortSignal);
    // promptfoo 0.123.1 иначе считает текст HTTP 429 повторяемым rate limit.
    const metadata = { ...execution, ...(execution.status === 'quota_exhausted' ? { rateLimitKind: 'quota' } : {}) };
    return execution.status === 'ok' ? { output: execution.output ?? '', cached: false, cost: 0, metadata }
      : { error: `${execution.status}: ${execution.reason}`, metadata };
  }
}
export async function runPilot(config: RunConfig, options: { resultsDir?: string; budgetUsd?: number; connection?: ModelConnection; apiBaseUrl?: string } = {}): Promise<{ dir: string; run: SavedRun }> {
  const root = options.resultsDir ?? join(projectRoot, 'results');
  const mode = billingMode(config.candidate.provider), suite = pilotSuite(config);
  if (mode === 'api' && options.budgetUsd === undefined) throw new Error('API требует явного --budget <USD>');
  return withProjectLock(root, () => (mode === 'mock' ? withoutNetwork : (action: () => Promise<{ dir: string; run: SavedRun }>) => withApiNetwork(options.apiBaseUrl ?? 'https://openrouter.ai/api/v1', action))(async () => {
    const started = performance.now(), startedAt = new Date().toISOString();
    const { dir, runId } = createRunDir(root, mode === 'manual' ? 'manual' : 'pilot');
    const runtime = mkdtempSync(join(tmpdir(), 'bench-promptfoo-'));
    let ledger: BudgetLedger | null = null;
    const browser = new BrowserChecks();
    try {
      prepareOfflineRuntime(runtime);
      const connection = options.connection ?? createConnection(config.candidate, [projectRoot, root], options);
      const diagnostic = await connection.diagnose();
      ledger = mode === 'api' ? apiLedger(root, config, options.budgetUsd) : null;
      const executor = new CallExecutor(runId, dir, config, connection, diagnostic, ledger);
      await browser.start();
      const checksByAttempt = new Map<string, CheckResult[]>();
      for (const task of suite.tasks) writeFileSync(join(dir, 'prompts', `${task.id}.txt`), taskPrompt(task), { flag: 'wx' });
      const tests: TestCase[] = suite.tasks.filter((t) => t.readiness === 'enabled').flatMap((task) => Array.from({ length: task.limits.attempts }, (_, i) => ({
        description: `${task.id} / ${i + 1}`, vars: { taskId: task.id, attemptIndex: i + 1, taskPrompt: taskPrompt(task) },
        assert: [{ type: 'javascript' as const, value: async (output: string) => {
          const checks = await evaluateChecks(task, output, browser, dir, `${task.id}-a${i + 1}`); checksByAttempt.set(`${task.id}-a${i + 1}`, checks);
          const score = checks.reduce((s, c) => s + c.score * c.weight, 0) / checks.reduce((s, c) => s + c.weight, 0);
          return { pass: score >= task.passThreshold && !checks.some((c) => c.critical && !c.pass), score, reason: checks.map((c) => c.reason).join('; ') };
        } }],
      })));
      const { evaluate } = await import('promptfoo');
      const evaluation = await evaluate({ description: `Practical pilot ${config.candidate.provider}`, prompts: ['{{taskPrompt}}'],
        providers: [new PilotProvider(suite, executor)], tests, writeLatestResults: false, sharing: false },
      { cache: false, maxConcurrency: 1, showProgressBar: false, timeoutMs: config.limits.timeoutMs });
      const raw = await evaluation.toEvaluateSummary(); writeJson(join(dir, 'promptfoo.json'), redact(raw));
      const model = `${config.candidate.provider}:${config.candidate.model ?? 'mock-practical-v1'}:${diagnostic.executionMode}`;
      const attempts: AttemptRecord[] = raw.results.map((result) => {
        const task = suite.tasks.find((t) => t.id === result.vars.taskId)!;
        const index = Number(result.vars.attemptIndex), attemptId = `${task.id}-a${index}`;
        const metadata = result.response?.metadata as Execution | undefined;
        const checks = checksByAttempt.get(attemptId) ?? [];
        const skip = !metadata ? 'Нет метаданных подключения' : metadata.status !== 'ok' ? metadata.reason : checks.length !== task.checks.length ? 'Не завершены проверки' : undefined;
        const assessment = assess(task, checks, skip);
        const related = executor.calls.filter((c) => c.attemptId === attemptId);
        const record: AttemptRecord = { runId, taskId: task.id, attemptId, index, primaryCategory: task.primaryCategory, model,
          status: metadata?.status !== 'ok' ? metadata?.status ?? 'technical_error' : skip ? 'technical_error' : assessment.status,
          checks, assessments: assessment.assessments, callIds: metadata?.callIds ?? [], elapsedMs: related.reduce((s, c) => s + c.elapsedMs, 0),
          reason: skip ?? 'Объективные проверки; смысл/дизайн оцениваются отдельно слепым A/B',
          artifacts: [...new Set([...related.flatMap((c) => c.artifacts), ...checks.flatMap((c) => c.evidence), `checks/${attemptId}.json`])],
          promptfooSuccess: skip ? null : result.success };
        writeJson(join(dir, 'checks', `${attemptId}.json`), { evaluationVersion: suite.evaluationVersion, checks, assessments: record.assessments });
        appendJsonl(join(dir, 'attempts.jsonl'), record); return record;
      });
      if (attempts.length !== tests.length) throw new Error('Движок не вернул все попытки');
      const budget = ledger?.snapshot() ?? new BudgetLedger({ perRequestUsd: 0, perTaskUsd: 0, runUsd: 0, monthUsd: 0 }, config.timezone, undefined, undefined, 'api').snapshot();
      const account = budget.runs[runId];
      const manifest: Manifest = { schemaVersion: 2, runId, mode: config.candidate.provider, synthetic: mode === 'mock', scenario: mode === 'manual' ? 'manual' : 'pilot',
        billingMode: mode, startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started, timezone: config.timezone,
        suite, suiteHash: hash(JSON.stringify(suite)), taskHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(JSON.stringify(t))])),
        promptHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(taskPrompt(t))])), materialHashes: Object.fromEntries(suite.tasks.flatMap((t) => t.materials.map((m) => [`${t.id}/${m.id}`, hash(m.content)]))),
        evaluationVersion: suite.evaluationVersion, shellVersion: 'promptfoo-practical-connections-1', model,
        generation: effectiveGeneration(config.candidate.provider, config.generation), environment: environment(),
        browser: { engine: 'chromium', version: browser.version(), viewports: [1440, 390], font: 'Arial', javaScriptEnabled: false, network: 'blocked' },
        conditions: { provider: config.candidate.provider, executionMode: diagnostic.executionMode, clientVersion: diagnostic.version,
          authMethod: diagnostic.authMethod, tools: diagnostic.tools, configHash: hash(JSON.stringify({ endpoint: config.candidate.providerEndpoint, mode: diagnostic.executionMode,
            settings: diagnostic.config.settings ?? null, generation: config.generation, limits: config.limits })),
          isolation: mode === 'api' ? 'api-no-tools' : mode === 'manual' ? 'manual-declared' : mode === 'mock' ? 'mock' : 'os-workspace', diagnostic },
        config, budget, realBudget: { limitUsd: mode === 'api' ? options.budgetUsd! : 0, spentUsd: (account?.spentMicroUsd ?? 0) / 1e6, reservedUsd: (account?.reservedMicroUsd ?? 0) / 1e6 },
        artifacts: ['manifest.json', 'calls.jsonl', 'attempts.jsonl', 'summary.json', 'promptfoo.json', 'report.html', 'integrity.json'],
        status: attempts.some((a) => !['passed', 'failed', 'pending'].includes(a.status)) ? 'complete_with_skips' : 'complete' };
      const run: SavedRun = { manifest, attempts, calls: executor.calls }, summary = aggregate(run.calls, attempts, suite, config.timezone);
      writeJson(join(dir, 'manifest.json'), redact(manifest)); writeJson(join(dir, 'summary.json'), summary);
      writeFileSync(join(dir, 'report.html'), renderRun(run, summary), { flag: 'wx' }); finalizeIntegrity(dir); return { dir, run };
    } catch (error) { writeJson(join(dir, 'failure.json'), { runId, reason: String(redact(String(error))), budget: ledger?.snapshot() ?? null }); throw error; }
    finally { await browser.close(); rmSync(runtime, { recursive: true, force: true }); }
  }));
}
