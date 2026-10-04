import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { saveComparison } from './compare.js';
import { projectRoot, runDemo } from './runner.js';
import { withProjectLock } from './storage.js';
import { readJson } from './storage.js';
import { connectionSchema, loadConfig, providerIds } from './connections/config.js';
import type { ProviderId, RunConfig } from './connections/config.js';
import { createConnection } from './connections/index.js';
import { dryRun, runPilot } from './pilot.js';
import { manualTemplate, parseManual, ManualConnection } from './manual.js';
import { calibrate, calibrationSample, evaluateSaved } from './judges.js';
import type { EvaluationArtifact } from './judges.js';
import { redact } from './connections/process.js';
import { resumePlan, exportRun, rerunSuspected } from './daily.js';
import { reconcileRun } from './reconcile.js';
import { diagnoseSandbox } from './sandbox.js';
import type { SavedRun } from './types.js';

const help = `npm run bench — сохранённое mock-демо (два запуска, без API)
npm run bench -- diagnose [--provider codex-cli] [--model <ID>]
npm run bench -- dry-run --provider openrouter --config <JSON> --budget <USD>
npm run bench -- run --provider <ID> [--config <JSON>] [--model <ID>] [--endpoint <tag>] [--budget <USD>]
npm run bench -- resume --run <id>\nnpm run bench -- reconcile --run <id> [--input <generation-mapping.json>]\nnpm run bench -- export --run <id> --output <новая-папка>\nnpm run bench -- rerun --comparison <compare-id> [--attempts 3] [--budget <USD>]\nnpm run bench -- manual-template --output <JSON> [--config <JSON>]
npm run bench -- import --input <JSON> [--config <JSON>]
npm run bench -- evaluate --baseline <id> --current <id> --config <JSON> [--budget <USD>] [--limit-pairs 1] [--swap-order]
npm run bench -- calibrate --evaluation <id> --input <JSON>
npm run bench -- calibrate-sample --evaluation <id>
npm run bench -- compare --baseline <id> --current <id> [--evaluation <id>]
Старое сравнение: npm run bench -- --baseline <id> --current <id>
Провайдеры: ${providerIds.join(', ')}. Дополнительно: --results-dir <путь>, --profile smoke/standard/pilot, --attempts 1–10, --tasks <id,id>. Run по умолчанию smoke, 6 задач.
Run с реальным кандидатом требует явного --provider. API требует --budget > 0.
Диагностика и dry-run не генерируют ответов; manual импортирует готовые данные.`;

const controller = new AbortController();
process.once('SIGINT', () => { controller.abort(); process.exitCode = 130; console.error(JSON.stringify({ event: 'interrupted', reason: 'Ctrl+C; исход отправленного вызова может быть неизвестен, используйте resume/reconcile' })); });
function exitFromStatuses(statuses: string[]) {
  process.exitCode = controller.signal.aborted ? 130 : statuses.includes('in_doubt') ? 7 : statuses.includes('budget_exhausted') ? 4 : statuses.includes('quota_exhausted') ? 5 : statuses.includes('timeout') ? 6
    : statuses.some(s => !['passed', 'failed', 'pending'].includes(s)) ? 3 : 0;
}
function runExit(run: SavedRun) { exitFromStatuses(run.attempts.map(a => a.status)); }
function evaluationExit(artifact: EvaluationArtifact) { exitFromStatuses(artifact.pairs.flatMap(p => p.executionStatus === 'ok' || p.executionStatus === undefined ? [] : [p.executionStatus])); }
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    baseline: { type: 'string' }, current: { type: 'string' },
    'results-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    provider: { type: 'string' }, config: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' },
    budget: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, evaluation: { type: 'string' },
    'limit-pairs': { type: 'string' }, 'swap-order': { type: 'boolean' },
    profile: { type: 'string' }, attempts: { type: 'string' }, tasks: { type: 'string' }, run: { type: 'string' }, comparison: { type: 'string' }, 'log-json': { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help) {
    console.log(help);
    return;
  }
  if (Boolean(values.baseline) !== Boolean(values.current)) throw new Error('Укажите и --baseline, и --current');
  const root = values['results-dir'] ? resolve(values['results-dir']) : join(projectRoot, 'results');
  if (positionals.length > 1) throw new Error('Ожидается одна команда');
  const command = positionals[0] ?? (values.baseline ? 'compare' : 'demo');
  const provider = values.provider as ProviderId | undefined;
  if (provider && !providerIds.includes(provider)) throw new Error(`Провайдер должен быть одним из ${providerIds.join(', ')}`);
  const budgetUsd = values.budget === undefined ? undefined : Number(values.budget);
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error('--budget должен быть положительным числом USD');
  const attempts = values.attempts === undefined ? undefined : Number(values.attempts);
  if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)) throw new Error('--attempts: целое число 1–10');
  if (values.profile && !['pilot', 'smoke', 'standard'].includes(values.profile)) throw new Error('--profile: pilot/smoke/standard');
  const log = (event: Record<string, unknown>) => console.error(JSON.stringify(redact({ at: new Date().toISOString(), ...event })));
  const configFor = (defaultProvider: ProviderId): RunConfig => {
    const config = loadConfig(resolve(values.config ?? join(projectRoot, 'configs', `pilot-${defaultProvider}.json`)));
    config.candidate = connectionSchema.parse({ ...config.candidate, ...(provider ? { provider } : {}),
      ...(values.model ? { model: values.model } : {}), ...(values.endpoint ? { providerEndpoint: values.endpoint } : {}) });
    if (values.profile) config.profile = values.profile as RunConfig['profile'];
    else if (!values.config && ['run','dry-run','manual-template','import'].includes(command)) config.profile = 'smoke';
    if (attempts !== undefined) config.limits.attempts = attempts;
    if (values.tasks) config.taskIds = values.tasks.split(',');
    return config;
  };
  const pair = () => { if (!values.baseline || !values.current) throw new Error('Нужны --baseline и --current'); return { baseline: values.baseline, current: values.current }; };
  if (command === 'compare') {
    const ids = pair();
    const result = await withProjectLock(root, async () => saveComparison(root, ids.baseline, ids.current, values.evaluation));
    console.log(`Совпадающих задач: ${result.comparison.matchingTaskCount}; пар попыток: ${result.comparison.pairedAttemptCount}.\nОтчёт: ${join(result.dir, 'report.html')}`);
    return;
  }
  if (command === 'diagnose') {
    const ids = provider ? [provider] : values.config ? [configFor('mock').candidate.provider] : [...providerIds];
    const result = await Promise.all(ids.map(async (id) => createConnection(configFor(id).candidate, [projectRoot]).diagnose()));
    console.log(JSON.stringify(redact({ connections: result, sandbox: await diagnoseSandbox(configFor(provider ?? 'mock').sandbox) }), null, 2));
    if (provider && result.some(r => r.status !== 'ok')) process.exitCode = 3; return;
  }
  if (command === 'dry-run') {
    const plan = await dryRun(configFor(provider ?? 'mock'), { resultsDir: root, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(values.baseline ? { baseline: values.baseline } : {}) });
    console.log(JSON.stringify(redact(plan), null, 2));
    if (plan.diagnostic.status !== 'ok' || plan.sandbox?.status === 'isolation_unavailable') process.exitCode = 3;
    else if (plan.reservationPreview.some(r => !r.decision.allowed)) process.exitCode = 4; return;
  }
  if (command === 'manual-template') {
    if (!values.output) throw new Error('Нужен --output <JSON>'); manualTemplate(configFor('manual'), resolve(values.output));
    console.log(`Шаблон и точные промпты: ${resolve(values.output)}. Заполните ответы в новых веб-сессиях; затем import.`); return;
  }
  if (command === 'import') {
    if (!values.input) throw new Error('Нужен --input <JSON>');
    const config = configFor('manual'), input = parseManual(readJson(resolve(values.input)), config);
    config.candidate = connectionSchema.parse({ ...config.candidate, provider: 'manual', model: input.model, executionMode: input.executionMode });
    const result = await runPilot(config, { resultsDir: root, connection: new ManualConnection(config.candidate, input) });
    console.log(`Run ID: ${result.run.manifest.runId}\nОтчёт: ${join(result.dir, 'report.html')}\nUsage и скрытые вызовы manual неизвестны.`); return;
  }
  if (command === 'run') {
    if (!provider) throw new Error('Run требует явного --provider (mock/openrouter/codex-cli/claude-code/gemini-cli)');
    if (provider === 'manual') throw new Error('Для manual используйте import');
    const result = await runPilot(configFor(provider), { resultsDir: root, signal: controller.signal, log, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    runExit(result.run);
    console.log(`Run ID: ${result.run.manifest.runId}\nСтатус: ${result.run.manifest.status}\nОтчёт: ${join(result.dir, 'report.html')}`); return;
  }
  if (command === 'resume') {
    if (!values.run) throw new Error('Нужен --run <id>');
    const plan = resumePlan(root, values.run);
    if (plan.kind === 'evaluation') {
      const result = await evaluateSaved(root, plan.baselineId!, plan.currentId!, plan.config, { resumeId: values.run, signal: controller.signal, log, ...(plan.budgetUsd === null ? {} : { budgetUsd: plan.budgetUsd }) });
      evaluationExit(result.artifact);
      console.log(`Evaluation ID: ${result.artifact.evaluationId}\nОтчёт: ${join(result.dir, 'report.html')}`); return;
    }
    const result = await runPilot(plan.config, { resultsDir: root, resumeId: values.run, signal: controller.signal, log, ...(plan.budgetUsd === null ? {} : { budgetUsd: plan.budgetUsd }) });
    runExit(result.run); console.log(`Run ID: ${result.run.manifest.runId}\nСтатус: ${result.run.manifest.status}\nОтчёт: ${join(result.dir, 'report.html')}`); return;
  }
  if (command === 'reconcile') {
    if (!values.run) throw new Error('Нужен --run <id>');
    const result = await reconcileRun(root, values.run, values.input ? { input: readJson(resolve(values.input)) } : {});
    console.log(JSON.stringify(redact(result), null, 2)); if (result.report.results.some(r => r.status === 'in_doubt')) process.exitCode = 7; return;
  }
  if (command === 'export') {
    if (!values.run || !values.output) throw new Error('Нужны --run <id> и --output <новая-папка>');
    const report = await withProjectLock(root, async () => exportRun(root, values.run!, values.output!));
    console.log(`Экспорт: ${report}`); return;
  }
  if (command === 'rerun') {
    if (!values.comparison) throw new Error('Нужен --comparison <compare-id>');
    const result = await rerunSuspected(root, values.comparison, { ...(attempts === undefined ? {} : { attempts }), ...(budgetUsd === undefined ? {} : { budgetUsd }), signal: controller.signal, log });
    runExit(result.run); console.log(`Свежий Run ID: ${result.run.manifest.runId}\nНезависимых задач: ${result.independentTaskCount}\nСравнение: ${join(result.comparison.dir, 'report.html')}`); return;
  }
  if (command === 'evaluate') {
    const ids = pair(), limitPairs = values['limit-pairs'] === undefined ? undefined : Number(values['limit-pairs']);
    if (limitPairs !== undefined && (!Number.isInteger(limitPairs) || limitPairs < 1 || limitPairs > 100)) throw new Error('--limit-pairs: целое число 1–100');
    const result = await evaluateSaved(root, ids.baseline, ids.current, configFor(provider ?? 'openrouter'), {
      signal: controller.signal, log, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(limitPairs !== undefined ? { limitPairs } : {}), swapOrder: values['swap-order'] ?? false,
    });
    evaluationExit(result.artifact);
    console.log(`Evaluation ID: ${result.artifact.evaluationId}\nОтчёт: ${join(result.dir, 'report.html')}\nДобавить в compare: --evaluation ${result.artifact.evaluationId}`); return;
  }
  if (command === 'calibrate') {
    if (!values.input || !values.evaluation) throw new Error('Нужны --evaluation и --input');
    const dir = await withProjectLock(root, async () => calibrate(root, values.evaluation!, readJson(resolve(values.input!))));
    console.log(`Ручная калибровка сохранена: ${join(dir, 'calibration.json')}`); return;
  }
  if (command === 'calibrate-sample') {
    if (!values.evaluation) throw new Error('Нужен --evaluation <id>');
    const dir = await withProjectLock(root, async () => calibrationSample(root, values.evaluation!));
    console.log(`Слепая выборка: ${join(dir, 'review.html')}\nШаблон: ${join(dir, 'reviews-template.json')}`); return;
  }
  if (command !== 'demo') throw new Error(`Неизвестная команда: ${command}. Используйте --help`);
  if (provider && provider !== 'mock' || values.config || values.model || values.budget) throw new Error('Demo только mock с фиксированными fixtures. Для pilot используйте run/dry-run.');
  const demo = await runDemo({ resultsDir: root, onProgress: (message) => console.log(message) });
  console.log(`\nBaseline ID: ${demo.baseline.run.manifest.runId}\nCurrent ID: ${demo.current.run.manifest.runId}\nОтчёт baseline: ${join(demo.baseline.dir, 'report.html')}\nОтчёт current: ${join(demo.current.dir, 'report.html')}\nСравнение: ${join(demo.comparison.dir, 'report.html')}\nФактические расходы API: 0 USD.`);
  console.log(`Повтор сравнения: npm run bench -- --baseline ${demo.baseline.run.manifest.runId} --current ${demo.current.run.manifest.runId}`);
}

main().catch((error: unknown) => { process.exitCode = controller.signal.aborted ? 130 : 2;
  console.error(JSON.stringify({ event: 'error', code: process.exitCode, reason: redact(error instanceof Error ? error.message : String(error)) })); });
