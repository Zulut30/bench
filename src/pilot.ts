import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse, TestCase } from 'promptfoo';
import { aggregate } from './aggregate.js';
import { BudgetLedger } from './budget.js';
import type { BudgetAccess } from './budget.js';
import { readBudget, SqliteBudgetLedger, StateStore } from './state.js';
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
import { createRunDir, finalizeIntegrity, hash, loadRun, readJson, withProjectLock, writeJson, writeJsonOnce, writeOnce } from './storage.js';
import { withApiNetwork, withoutNetwork } from './offline.js';
import type { AttemptRecord, CheckResult, Manifest, SavedRun } from './types.js';
import { diagnoseSandbox } from './sandbox.js';

export function pilotSuite(config: RunConfig): Suite {
  const suite = suiteSchema.parse(readJson(resolve(projectRoot, config.profile !== 'pilot' && config.suite === 'benchmarks/pilot.json' ? 'benchmarks/standard.json' : config.suite)));
  const profiles = readJson(join(projectRoot, 'benchmarks/profiles.json')) as { smoke: string[]; standard: string[] };
  const ids = config.taskIds.length ? config.taskIds : config.profile === 'smoke' ? profiles.smoke : suite.tasks.map(t => t.id);
  if (ids.some(id => !suite.tasks.some(t => t.id === id))) throw new Error('Выбрано неизвестное задание профиля');
  return suiteSchema.parse({ ...suite, tasks: suite.tasks.filter(t => ids.includes(t.id)).map((t) => ({ ...t, limits: { ...t.limits,
    attempts: config.limits.attempts, timeoutMs: Math.min(t.limits.timeoutMs, config.limits.timeoutMs),
    maxRetries: Math.min(t.limits.maxRetries, config.limits.maxRetries, t.limits.maxCalls - 1), maxJudgeCalls: Math.min(t.limits.maxJudgeCalls, config.limits.maxJudgeCalls),
  } })) });
}
export function apiLedger(root: string, config: RunConfig, budgetUsd: number | undefined, store?: StateStore): SqliteBudgetLedger {
  if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('API требует явного --budget <USD>, больше нуля');
  return new SqliteBudgetLedger(store ?? new StateStore(root), { ...config.apiBudget, runUsd: budgetUsd }, config.timezone);
}
export async function dryRun(config: RunConfig, options: { apiBaseUrl?: string; budgetUsd?: number; baseline?: string; resultsDir?: string } = {}) {
  const suite = pilotSuite(config);
  const connection = createConnection(config.candidate, [projectRoot], options);
  const diagnostic = await connection.diagnose();
  const mode = billingMode(config.candidate.provider);
  const sandbox = suite.tasks.some(t => t.execution) ? await diagnoseSandbox(config.sandbox) : null;
  const requests = suite.tasks.filter((t) => t.readiness === 'enabled').map((t) => {
    const bound = connection.upperBound(Math.min(t.limits.maxOutputTokens, config.limits.maxOutputTokens), 0, { prompt: taskPrompt(t), images: [] });
    const attempts = t.limits.attempts, retries = t.limits.maxRetries;
    return { taskId: t.id, primaryCategory: t.primaryCategory, checkKind: t.execution ? `container: ${t.execution.kind}` : 'objective + pending rubric',
      attempts, requests: attempts * (1 + retries), upperCostUsd: mode === 'api' ? bound ? bound.perCallUsd * attempts * (1 + retries) : null : 0,
      reservationBound: bound,
      promptBytes: Buffer.byteLength(taskPrompt(t)), subjective: t.rubric.categories.length ? 'pending; separate evaluate command' : 'not_required' };
  });
  const knownUpperUsd = requests.reduce((sum, r) => sum + (r.upperCostUsd ?? 0), 0);
  const preview = [];
  const resultRoot = options.resultsDir ?? join(projectRoot, 'results'), path = join(resultRoot, '.bench.sqlite');
  if (mode === 'api') {
    const ledger = new BudgetLedger({ ...config.apiBudget, runUsd: options.budgetUsd ?? 0 }, config.timezone,
      readBudget(resultRoot), undefined, 'api');
    for (const task of suite.tasks.filter((t) => t.readiness === 'enabled')) {
      const bound = connection.upperBound(Math.min(task.limits.maxOutputTokens, config.limits.maxOutputTokens), 0, { prompt: taskPrompt(task), images: [] });
      for (let i = 0; i < task.limits.attempts; i++) preview.push({ taskId: task.id, attempt: i + 1,
        decision: ledger.reserve('dry-run-preview', task.id, bound ? { ...bound, attemptUsd: bound.perCallUsd * (1 + task.limits.maxRetries) } : null, new Date()) });
    }
  }
  return { command: 'dry-run', provider: config.candidate.provider, billingMode: mode, diagnostic, sandbox, requests,
    noGenerations: true, upperCostUsd: requests.some((r) => r.upperCostUsd === null) ? null : knownUpperUsd,
    budgetUsd: options.budgetUsd ?? null, budgetSufficient: mode !== 'api' ? true : preview.length > 0 && preview.every(p => p.decision.allowed),
    reservationPreview: preview, journalPath: mode === 'api' ? path : null, journalModified: false,
    budgetNote: 'Метод и доказательство резерва указаны для каждого запроса. Unknown upstream serialization → fallback context. Retries резервируются заранее. Неизвестное списание удерживает резерв; каждый scope объясняется reservationPreview.',
    judges: { ...config.judges, note: 'Судьи запускаются отдельной командой evaluate с отдельным явным API-бюджетом; этот план только кандидатский', baseline: options.baseline ?? null },
    uncoveredCategories: (await import('./categories.js')).categoryIds.filter((id) => !suite.tasks.some((t) => t.evaluationCategories.includes(id))) };
}

class PilotProvider implements ApiProvider {
  private readonly visited = new Set<string>();
  constructor(private readonly suite: Suite, private readonly executor: CallExecutor, private readonly signal?: AbortSignal, private readonly sandboxAvailable = true) {}
  id() { return `practical:${this.executor.connection.config.provider}`; }
  toJSON() { return { id: this.id(), label: this.executor.connection.config.model ?? 'mock-practical-v1' }; }
  async callApi(prompt: string, context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    const task = this.suite.tasks.find((t) => t.id === context?.vars.taskId), index = Number(context?.vars.attemptIndex);
    if (!task || !Number.isInteger(index) || index < 1 || index > task.limits.attempts) throw new Error('Неверное задание promptfoo');
    const attemptId = `${task.id}-a${index}`;
    if (this.visited.has(attemptId)) throw new Error('Повторная отправка одной попытки движком');
    this.visited.add(attemptId);
    if (task.execution && !this.sandboxAvailable) return { error: 'isolation_unavailable: фиксированный образ недоступен', metadata: { status: 'isolation_unavailable', reason: 'Контейнер недоступен; генерация не отправлена', callIds: [], output: null } };
    const signal = this.signal && options?.abortSignal ? AbortSignal.any([this.signal, options.abortSignal]) : this.signal ?? options?.abortSignal;
    const execution = await this.executor.execute(task, attemptId, index, prompt, [], signal);
    // promptfoo 0.123.1 иначе считает текст HTTP 429 повторяемым rate limit.
    const metadata = { ...execution, ...(execution.status === 'quota_exhausted' ? { rateLimitKind: 'quota' } : {}) };
    return execution.status === 'ok' ? { output: execution.output ?? '', cached: false, cost: 0, metadata }
      : { error: `${execution.status}: ${execution.reason}`, metadata };
  }
}
interface RunPlan { config: RunConfig; suite: Suite; startedAt: string; budgetUsd: number | null; environment: Manifest['environment']; }
export async function runPilot(config: RunConfig, options: { resultsDir?: string; budgetUsd?: number; connection?: ModelConnection; apiBaseUrl?: string;
  resumeId?: string; signal?: AbortSignal; fault?: (point: string) => void; log?: (event: Record<string, unknown>) => void } = {}): Promise<{ dir: string; run: SavedRun }> {
  const root = options.resultsDir ?? join(projectRoot, 'results');
  const mode = billingMode(config.candidate.provider), suite = pilotSuite(config);
  if (mode === 'api' && options.budgetUsd === undefined) throw new Error('API требует явного --budget <USD>');
  return withProjectLock(root, (store) => (mode === 'mock' ? withoutNetwork : (action: () => Promise<{ dir: string; run: SavedRun }>) => withApiNetwork(options.apiBaseUrl ?? 'https://openrouter.ai/api/v1', action))(async () => {
    const started = performance.now();
    const { dir, runId } = options.resumeId ? { dir: join(root, options.resumeId), runId: options.resumeId } : createRunDir(root, mode === 'manual' ? 'manual' : 'pilot');
    const plan: RunPlan = options.resumeId ? store.run<RunPlan>(runId).plan : { config, suite, startedAt: new Date().toISOString(), budgetUsd: options.budgetUsd ?? null, environment: environment() };
    if (hash(JSON.stringify(plan.config)) !== hash(JSON.stringify(config)) || hash(JSON.stringify(plan.suite)) !== hash(JSON.stringify(suite))) throw new Error('Для resume нужны исходные настройки/набор; используйте сохранённый план');
    const finish = (run: SavedRun, raw: unknown) => {
      writeJsonOnce(join(dir, 'promptfoo.json'), raw);
      writeOnce(join(dir, 'attempts.jsonl'), run.attempts.map((a) => JSON.stringify(a) + '\n').join(''));
      writeJsonOnce(join(dir, 'manifest.json'), redact(run.manifest));
      writeJsonOnce(join(dir, 'summary.json'), aggregate(run.calls, run.attempts, suite, config.timezone));
      writeOnce(join(dir, 'report.html'), renderRun(run, aggregate(run.calls, run.attempts, suite, config.timezone)));
      writeOnce(join(dir, 'events.jsonl'), store.events(runId).map((e) => JSON.stringify(e) + '\n').join(''));
      if (!existsSync(join(dir, 'integrity.json'))) finalizeIntegrity(dir);
      store.finishRun(runId, 'complete'); return { dir, run: loadRun(root, runId) };
    };
    if (options.resumeId) {
      if (store.run<RunPlan>(runId).status === 'complete') return { dir, run: loadRun(root, runId) };
      const final = store.finalization<{ run: SavedRun; raw: unknown }>(runId); if (final) return finish(final.run, final.raw);
      if (plan.environment.implementationHash !== environment().implementationHash) throw new Error('Код измерений изменён; resume блокирован. Данные сохранены для сверки/экспорта');
      store.recover(runId);
    } else { store.createRun(runId, plan); writeJson(join(dir, 'plan.json'), plan); }
    const startedAt = plan.startedAt;
    const runtime = mkdtempSync(join(tmpdir(), 'bench-promptfoo-'));
    let ledger: BudgetAccess | null = null;
    let executor: CallExecutor | null = null;
    const browser = new BrowserChecks();
    try {
      prepareOfflineRuntime(runtime);
      const connection = options.connection ?? createConnection(config.candidate, [projectRoot, root], options);
      const diagnostic = await connection.diagnose();
      ledger = mode === 'api' ? apiLedger(root, config, options.budgetUsd, store) : null;
      executor = new CallExecutor(runId, dir, config, connection, diagnostic, ledger, 'candidate', undefined,
        { store, ...(options.fault ? { fault: options.fault } : {}), ...(options.log ? { log: options.log } : {}) });
      const executionEnvironment = suite.tasks.some(t => t.execution) ? await diagnoseSandbox(config.sandbox) : null;
      await browser.start();
      const checksByAttempt = new Map<string, CheckResult[]>();
      const checkTimes = new Map<string, number>();
      for (const task of suite.tasks) writeOnce(join(dir, 'prompts', `${task.id}.txt`), taskPrompt(task));
      const tests: TestCase[] = suite.tasks.filter((t) => t.readiness === 'enabled').flatMap((task) => Array.from({ length: task.limits.attempts }, (_, i) => ({
        description: `${task.id} / ${i + 1}`, vars: { taskId: task.id, attemptIndex: i + 1, taskPrompt: taskPrompt(task) },
        assert: [{ type: 'javascript' as const, value: async (output: string) => {
          const id = `${task.id}-a${i + 1}`, previous = store.assessment<{ checks: CheckResult[]; elapsedMs: number }>(runId, id), began = performance.now();
          const checks = previous?.checks ?? await evaluateChecks(task, output, browser, dir, `${id}-check-${randomUUID().slice(0, 8)}`, config.sandbox, options.signal);
          const elapsedMs = previous?.elapsedMs ?? performance.now() - began;
          if (!previous) store.saveAssessment(runId, id, { checks, elapsedMs });
          checksByAttempt.set(id, checks); checkTimes.set(id, elapsedMs);
          const score = checks.reduce((s, c) => s + c.score * c.weight, 0) / checks.reduce((s, c) => s + c.weight, 0);
          return { pass: score >= task.passThreshold && !checks.some((c) => c.critical && !c.pass), score, reason: checks.map((c) => c.reason).join('; ') };
        } }],
      })));
      const { evaluate } = await import('promptfoo');
      const evaluation = await evaluate({ description: `Practical pilot ${config.candidate.provider}`, prompts: ['{{taskPrompt}}'],
        providers: [new PilotProvider(suite, executor, options.signal, executionEnvironment === null || executionEnvironment.status === 'ok')], tests, writeLatestResults: false, sharing: false },
      // Внешний watchdog движка оставляет время транспорту завершить отмену и
      // транзакцию. Жёсткий generation timeout контролируется CallExecutor.
      { cache: false, maxConcurrency: 1, showProgressBar: false, timeoutMs: config.limits.timeoutMs + Math.max(0, ...suite.tasks.map(t => t.execution?.timeoutMs ?? 0)) + 15000 });
      await executor.waitForIdle();
      const raw = await evaluation.toEvaluateSummary();
      const completedCalls = executor.calls;
      const model = `${config.candidate.provider}:${config.candidate.model ?? 'mock-practical-v1'}:${diagnostic.executionMode}`;
      const attempts: AttemptRecord[] = raw.results.map((result) => {
        const task = suite.tasks.find((t) => t.id === result.vars.taskId)!;
        const index = Number(result.vars.attemptIndex), attemptId = `${task.id}-a${index}`;
        const metadata = result.response?.metadata as Execution | undefined;
        const checks = checksByAttempt.get(attemptId) ?? [];
        const skip = !metadata ? 'Нет метаданных подключения' : metadata.status !== 'ok' ? metadata.reason : checks.length !== task.checks.length ? 'Не завершены проверки' : undefined;
        const assessment = assess(task, checks, skip);
        const related = completedCalls.filter((c) => c.attemptId === attemptId);
        const record: AttemptRecord = { runId, taskId: task.id, attemptId, index, primaryCategory: task.primaryCategory, model,
          status: metadata?.status !== 'ok' ? metadata?.status ?? 'technical_error' : skip ? 'technical_error' : assessment.status,
          checks, assessments: assessment.assessments, callIds: metadata?.callIds ?? [], elapsedMs: related.reduce((s, c) => s + c.elapsedMs, 0),
          generationElapsedMs: related.length && related.every(c => c.generationElapsedMs !== null) ? related.reduce((s, c) => s + (c.generationElapsedMs ?? c.elapsedMs), 0) : null, checksElapsedMs: checkTimes.get(attemptId) ?? 0,
          reason: skip ?? 'Объективные проверки; смысл/дизайн оцениваются отдельно слепым A/B',
          artifacts: [...new Set([...related.flatMap((c) => c.artifacts), ...checks.flatMap((c) => c.evidence), `checks/${attemptId}.json`])],
          promptfooSuccess: skip ? null : result.success };
        writeJsonOnce(join(dir, 'checks', `${attemptId}.json`), { evaluationVersion: suite.evaluationVersion, checks, assessments: record.assessments });
        return record;
      });
      if (attempts.length !== tests.length) throw new Error('Движок не вернул все попытки');
      if (store.intents(runId).some(c => ['planned', 'reserved', 'dispatched'].includes(c.state))) throw new Error(`Остались незавершённые вызовы. Resume ID: ${runId}`);
      const budget = ledger?.snapshot() ?? new BudgetLedger({ perRequestUsd: 0, perTaskUsd: 0, runUsd: 0, monthUsd: 0 }, config.timezone, undefined, undefined, 'api').snapshot();
      const account = budget.runs[runId];
      const containerBrowser = attempts.flatMap(a => a.artifacts).filter(p => p.endsWith('-container.json')).map(p => readJson(join(dir,p)) as { environment: { browserVersion: string | null; defaultFont: string } })
        .find(log => typeof log.environment.browserVersion === 'string')?.environment;
      const manifest: Manifest = { schemaVersion: 2, runId, mode: config.candidate.provider, synthetic: mode === 'mock', scenario: mode === 'manual' ? 'manual' : 'pilot',
        billingMode: mode, startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started, timezone: config.timezone,
        suite, suiteHash: hash(JSON.stringify(suite)), taskHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(JSON.stringify(t))])),
        promptHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(taskPrompt(t))])), materialHashes: Object.fromEntries(suite.tasks.flatMap((t) => t.materials.map((m) => [`${t.id}/${m.id}`, hash(m.content)]))),
        evaluationVersion: suite.evaluationVersion, shellVersion: 'promptfoo-practical-connections-1', model,
        generation: effectiveGeneration(config.candidate.provider, config.generation), environment: environment(),
        browser: { engine: 'chromium', version: executionEnvironment ? containerBrowser?.browserVersion ?? 'not_used' : browser.version(), viewports: [1440, 390],
          font: executionEnvironment ? containerBrowser?.defaultFont ?? 'not_used' : 'Arial', javaScriptEnabled: suite.tasks.some(t => ['frontend','ui-design'].includes(t.execution?.kind ?? '')), network: 'blocked' },
        ...(executionEnvironment ? { execution: { imageId: executionEnvironment.imageId, checkerHash: hash(JSON.stringify(environment().implementationHash)), network: 'none', candidateUid: 10001, cpu: 1, memoryMb: 768, pids: 128 } } : {}),
        conditions: { provider: config.candidate.provider, executionMode: diagnostic.executionMode, clientVersion: diagnostic.version,
          authMethod: diagnostic.authMethod, tools: diagnostic.tools, configHash: hash(JSON.stringify({ endpoint: config.candidate.providerEndpoint, mode: diagnostic.executionMode,
            settings: diagnostic.config.settings ?? null, transport: config.candidate.promptTransport, generation: config.generation, limits: { ...config.limits, attempts: undefined } })),
          isolation: mode === 'api' ? 'api-no-tools' : mode === 'manual' ? 'manual-declared' : mode === 'mock' ? 'mock' : 'os-workspace', diagnostic },
        config, budget, realBudget: { limitUsd: mode === 'api' ? options.budgetUsd! : 0, spentUsd: (account?.spentMicroUsd ?? 0) / 1e6, reservedUsd: (account?.reservedMicroUsd ?? 0) / 1e6 },
        artifacts: ['manifest.json', 'calls.jsonl', 'attempts.jsonl', 'summary.json', 'promptfoo.json', 'plan.json', 'events.jsonl', 'report.html', 'integrity.json'],
        status: attempts.some((a) => !['passed', 'failed', 'pending'].includes(a.status)) ? 'complete_with_skips' : 'complete' };
      const run: SavedRun = { manifest, attempts, calls: executor.calls };
      if (options.signal?.aborted) { store.finishRun(runId, 'interrupted'); throw new Error(`Запуск прерван. Resume ID: ${runId}`); }
      store.saveFinalization(runId, { run, raw: redact(raw) }); options.fault?.('finalizing');
      return finish(run, redact(raw));
    } catch (error) { writeJson(join(dir, `interruption-${randomUUID()}.json`), { runId, reason: String(redact(String(error))), budget: ledger?.snapshot() ?? null }); throw error; }
    finally { await executor?.waitForIdle(); await browser.close(); rmSync(runtime, { recursive: true, force: true }); }
  }));
}
