import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { TestCase } from 'promptfoo';
import { aggregate } from './aggregate.js';
import { BudgetLedger, budgetStateSchema } from './budget.js';
import { assess, BrowserChecks, evaluateChecks } from './checks.js';
import { saveComparison } from './compare.js';
import { modelId, MockProvider, responsesSchema } from './mock-provider.js';
import { withoutNetwork } from './offline.js';
import type { ProviderAttemptMetadata } from './mock-provider.js';
import { renderRun } from './report.js';
import { configSchema, suiteSchema } from './schema.js';
import type { DemoConfig, Suite, Task } from './schema.js';
import { appendJsonl, atomicJson, createRunDir, filesUnder, finalizeIntegrity, hash, readJson, withProjectLock, writeJson } from './storage.js';
import type { AttemptRecord, CheckResult, Manifest, SavedRun, Scenario } from './types.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const shellVersion = 'promptfoo-local-mock-1';
export function taskPrompt(task: Task): string {
  return `${task.prompt}\n\nИСХОДНЫЕ МАТЕРИАЛЫ\n${task.materials.map((m) => `${m.id}:\n${m.content}`).join('\n\n')}`;
}
export function loadInputs(): { suite: Suite; config: DemoConfig } {
  return { suite: suiteSchema.parse(readJson(join(projectRoot, 'benchmarks/demo.json'))), config: configSchema.parse(readJson(join(projectRoot, 'configs/demo.json'))) };
}

export function environment(): Manifest['environment'] {
  const packageJson = readJson(join(projectRoot, 'package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  let commit: string | null = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Новый проект может быть без Git. */ }
  return { node: process.version, platform: process.platform, arch: process.arch, commit,
    dependencies: { ...packageJson.dependencies, ...packageJson.devDependencies }, lockfileHash: hash(readFileSync(join(projectRoot, 'package-lock.json'))),
    implementationHash: measurementHash(projectRoot) };
}
export function measurementHash(root: string) {
  const paths = ['src', 'fixtures', 'sandbox'].flatMap(dir => existsSync(join(root, dir)) ? filesUnder(join(root, dir))
    .filter(p => !p.startsWith('node_modules/') && !['report.ts', 'cli.ts'].includes(p)).map(p => `${dir}/${p}`) : []);
  return hash(paths.map(p => `${p}:${hash(readFileSync(join(root, p)))}`).join('\n'));
}

export function prepareOfflineRuntime(dir: string): void {
  Object.assign(process.env, {
    PROMPTFOO_DISABLE_TELEMETRY: 'true', PROMPTFOO_DISABLE_UPDATE: 'true',
    PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true', PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
    PROMPTFOO_CACHE_ENABLED: 'false', PROMPTFOO_CONFIG_DIR: dir, LOG_LEVEL: 'error',
  });
}

async function runSingle(root: string, scenario: Scenario, suite: Suite, config: DemoConfig, ledger: BudgetLedger, browser: BrowserChecks): Promise<{ dir: string; run: SavedRun }> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { runId, dir } = createRunDir(root, scenario);
  const checksByAttempt = new Map<string, CheckResult[]>();
  const provider = new MockProvider(runId, scenario, suite.tasks.filter((t) => t.readiness === 'enabled'), responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json'))), config.tariff, ledger, dir);
  try {
    const { evaluate } = await import('promptfoo');
    for (const task of suite.tasks) writeFileSync(join(dir, 'prompts', `${task.id}.txt`), taskPrompt(task), { flag: 'wx' });
    const tests: TestCase[] = suite.tasks.filter((t) => t.readiness === 'enabled').flatMap((task) => Array.from({ length: task.limits.attempts }, (_, i) => ({
      description: `${task.id} / ${i + 1}`,
      vars: { taskId: task.id, attemptIndex: i + 1, taskPrompt: taskPrompt(task) },
      assert: [{
        type: 'javascript' as const,
        value: async (output: string) => {
          const attemptId = `${task.id}-a${i + 1}`;
          const checks = await evaluateChecks(task, output, browser, dir, attemptId);
          checksByAttempt.set(attemptId, checks);
          const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
          const score = checks.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
          return { pass: score >= task.passThreshold && !checks.some((c) => c.critical && !c.pass), score,
            reason: checks.map((c) => `${c.id}: ${c.reason}`).join('; ') };
        },
      }],
    })));
    // Только конкретный объект local-mock и функции собственных проверок; никаких строк провайдеров/LLM-судей.
    const evaluation = await evaluate({
      description: `Practical Model Bench mock ${scenario}`, prompts: ['{{taskPrompt}}'], providers: [provider], tests,
      author: 'local-mock', writeLatestResults: false, sharing: false,
    }, { cache: false, maxConcurrency: 1, showProgressBar: false, timeoutMs: 10_000 });
    const raw = await evaluation.toEvaluateSummary();
    writeJson(join(dir, 'promptfoo.json'), raw);
    const attempts: AttemptRecord[] = raw.results.map((result) => {
      const task = suite.tasks.find((t) => t.id === result.vars.taskId);
      if (!task) throw new Error('promptfoo вернул неизвестное задание');
      const index = Number(result.vars.attemptIndex);
      const attemptId = `${task.id}-a${index}`;
      const metadata = result.response?.metadata as ProviderAttemptMetadata | undefined;
      if (!metadata || !['ok', 'budget_exhausted', 'technical_error', 'limit_exceeded'].includes(metadata.status)) throw new Error('Нет метаданных mock provider');
      const checks = checksByAttempt.get(attemptId) ?? [];
      const checksIncomplete = metadata.status === 'ok' && checks.length !== task.checks.length;
      const skipped = checksIncomplete ? `Проверки не завершены: ${result.error ?? attemptId}` : metadata.status !== 'ok' ? metadata.reason : undefined;
      const assessment = assess(task, checks, skipped);
      const status = checksIncomplete ? 'technical_error' : metadata.status === 'ok' ? assessment.status : metadata.status;
      const relatedCalls = provider.calls.filter((c) => c.attemptId === attemptId);
      const artifacts = [...new Set([...relatedCalls.flatMap((c) => c.artifacts), ...checks.flatMap((c) => c.evidence), `checks/${attemptId}.json`])];
      const record: AttemptRecord = {
        runId, taskId: task.id, attemptId, index, primaryCategory: task.primaryCategory, model: modelId, status,
        checks, assessments: assessment.assessments, callIds: metadata.callIds,
        elapsedMs: result.latencyMs ?? relatedCalls.reduce((s, c) => s + c.elapsedMs, 0),
        reason: skipped ?? (status === 'pending' ? 'Объективные проверки завершены; субъективная оценка pending' : 'См. результаты проверок'),
        artifacts, promptfooSuccess: metadata.status === 'ok' && !checksIncomplete ? result.success : null,
      };
      writeJson(join(dir, 'checks', `${attemptId}.json`), { evaluationVersion: suite.evaluationVersion, taskVersion: task.version, checks, assessments: record.assessments });
      appendJsonl(join(dir, 'attempts.jsonl'), record);
      return record;
    });
    const expectedAttempts = suite.tasks.filter((t) => t.readiness === 'enabled').reduce((s, t) => s + t.limits.attempts, 0);
    if (attempts.length !== expectedAttempts) throw new Error('promptfoo не вернул все запланированные попытки');
    const manifest: Manifest = {
      schemaVersion: 1, runId, mode: 'mock', synthetic: true, scenario, startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started,
      timezone: config.timezone, suite, suiteHash: hash(JSON.stringify(suite)),
      taskHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(JSON.stringify(t))])),
      promptHashes: Object.fromEntries(suite.tasks.map((t) => [t.id, hash(taskPrompt(t))])),
      materialHashes: Object.fromEntries(suite.tasks.flatMap((t) => t.materials.map((m) => [`${t.id}/${m.id}`, hash(m.content)]))),
      evaluationVersion: suite.evaluationVersion, shellVersion, model: modelId,
      generation: { temperature: 0, reasoning: 'synthetic-in-output', cache: false }, environment: environment(),
      browser: { engine: 'chromium', version: browser.version(), viewports: [1440, 390], font: 'Arial', javaScriptEnabled: false, network: 'blocked' },
      config, budget: ledger.snapshot(), realBudget: { limitUsd: 0, spentUsd: 0, reservedUsd: 0 },
      artifacts: ['manifest.json', 'summary.json', 'calls.jsonl', 'attempts.jsonl', 'promptfoo.json', 'integrity.json', 'report.html'],
      status: attempts.some((a) => ['budget_exhausted', 'not_evaluated', 'technical_error', 'limit_exceeded'].includes(a.status)) ? 'complete_with_skips' : 'complete',
    };
    const run: SavedRun = { manifest, calls: provider.calls, attempts };
    const summary = aggregate(provider.calls, attempts, suite, config.timezone);
    writeJson(join(dir, 'manifest.json'), manifest);
    writeJson(join(dir, 'summary.json'), summary);
    writeFileSync(join(dir, 'report.html'), renderRun(run, summary), { flag: 'wx' });
    finalizeIntegrity(dir);
    return { dir, run };
  } catch (error) {
    writeJson(join(dir, 'failure.json'), { runId, status: 'incomplete', reason: error instanceof Error ? error.message : String(error), budget: ledger.snapshot() });
    throw error;
  }
}

export async function runDemo(options: { resultsDir?: string; config?: DemoConfig; onProgress?: (message: string) => void } = {}) {
  const root = options.resultsDir ?? join(projectRoot, 'results');
  const inputs = loadInputs();
  const config = configSchema.parse(options.config ?? inputs.config);
  return withProjectLock(root, () => withoutNetwork(async () => {
    const journal = join(root, '.synthetic-budget.json');
    const ledger = new BudgetLedger(config.syntheticBudget, config.timezone, existsSync(journal) ? budgetStateSchema.parse(readJson(journal)) : undefined, (state) => atomicJson(journal, state));
    const runtimeDir = mkdtempSync(join(tmpdir(), 'practical-bench-promptfoo-'));
    prepareOfflineRuntime(runtimeDir);
    const browser = new BrowserChecks();
    try {
      await browser.start();
      options.onProgress?.('Baseline: 10 задач, 20 попыток; mock, фактические расходы API 0 USD.');
      const baseline = await runSingle(root, 'baseline', inputs.suite, config, ledger, browser);
      options.onProgress?.(`Baseline сохранён: ${baseline.run.manifest.runId}. Запускаю current.`);
      const current = await runSingle(root, 'current', inputs.suite, config, ledger, browser);
      const comparison = saveComparison(root, baseline.run.manifest.runId, current.run.manifest.runId);
      return { baseline, current, comparison };
    } finally {
      await browser.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }));
}
