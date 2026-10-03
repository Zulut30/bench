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
import { calibrate, evaluateSaved } from './judges.js';
import { redact } from './connections/process.js';

const help = `npm run bench — сохранённое mock-демо (два запуска, без API)
npm run bench -- diagnose [--provider codex-cli] [--model <ID>]
npm run bench -- dry-run --provider openrouter --config <JSON> --budget <USD>
npm run bench -- run --provider <ID> [--config <JSON>] [--model <ID>] [--endpoint <tag>] [--budget <USD>]
npm run bench -- manual-template --output <JSON> [--config <JSON>]
npm run bench -- import --input <JSON> [--config <JSON>]
npm run bench -- evaluate --baseline <id> --current <id> --config <JSON> [--budget <USD>] [--limit-pairs 1] [--swap-order]
npm run bench -- calibrate --evaluation <id> --input <JSON>
npm run bench -- compare --baseline <id> --current <id> [--evaluation <id>]
Старое сравнение: npm run bench -- --baseline <id> --current <id>
Провайдеры: ${providerIds.join(', ')}. Дополнительно: --results-dir <путь>.
Run с реальным кандидатом требует явного --provider. API требует --budget > 0.
Диагностика и dry-run не генерируют ответов; manual импортирует готовые данные.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    baseline: { type: 'string' }, current: { type: 'string' },
    'results-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    provider: { type: 'string' }, config: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' },
    budget: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, evaluation: { type: 'string' },
    'limit-pairs': { type: 'string' }, 'swap-order': { type: 'boolean' },
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
  const configFor = (defaultProvider: ProviderId): RunConfig => {
    const config = loadConfig(resolve(values.config ?? join(projectRoot, 'configs', `pilot-${defaultProvider}.json`)));
    config.candidate = connectionSchema.parse({ ...config.candidate, ...(provider ? { provider } : {}),
      ...(values.model ? { model: values.model } : {}), ...(values.endpoint ? { providerEndpoint: values.endpoint } : {}) });
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
    const ids = provider ? [provider] : [...providerIds];
    const result = await Promise.all(ids.map(async (id) => createConnection(configFor(id).candidate, [projectRoot]).diagnose()));
    console.log(JSON.stringify(redact(result), null, 2)); return;
  }
  if (command === 'dry-run') {
    console.log(JSON.stringify(redact(await dryRun(configFor(provider ?? 'mock'), { resultsDir: root, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(values.baseline ? { baseline: values.baseline } : {}) })), null, 2)); return;
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
    const result = await runPilot(configFor(provider), { resultsDir: root, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    console.log(`Run ID: ${result.run.manifest.runId}\nСтатус: ${result.run.manifest.status}\nОтчёт: ${join(result.dir, 'report.html')}`); return;
  }
  if (command === 'evaluate') {
    const ids = pair(), limitPairs = values['limit-pairs'] === undefined ? undefined : Number(values['limit-pairs']);
    if (limitPairs !== undefined && (!Number.isInteger(limitPairs) || limitPairs < 1 || limitPairs > 100)) throw new Error('--limit-pairs: целое число 1–100');
    const result = await evaluateSaved(root, ids.baseline, ids.current, configFor(provider ?? 'openrouter'), {
      ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(limitPairs !== undefined ? { limitPairs } : {}), swapOrder: values['swap-order'] ?? false,
    });
    console.log(`Evaluation ID: ${result.artifact.evaluationId}\nОтчёт: ${join(result.dir, 'report.html')}\nДобавить в compare: --evaluation ${result.artifact.evaluationId}`); return;
  }
  if (command === 'calibrate') {
    if (!values.input || !values.evaluation) throw new Error('Нужны --evaluation и --input');
    const dir = await withProjectLock(root, async () => calibrate(root, values.evaluation!, readJson(resolve(values.input!))));
    console.log(`Ручная калибровка сохранена: ${join(dir, 'calibration.json')}`); return;
  }
  if (command !== 'demo') throw new Error(`Неизвестная команда: ${command}. Используйте --help`);
  if (provider && provider !== 'mock' || values.config || values.model || values.budget) throw new Error('Demo только mock с фиксированными fixtures. Для pilot используйте run/dry-run.');
  const demo = await runDemo({ resultsDir: root, onProgress: (message) => console.log(message) });
  console.log(`\nBaseline ID: ${demo.baseline.run.manifest.runId}\nCurrent ID: ${demo.current.run.manifest.runId}\nОтчёт baseline: ${join(demo.baseline.dir, 'report.html')}\nОтчёт current: ${join(demo.current.dir, 'report.html')}\nСравнение: ${join(demo.comparison.dir, 'report.html')}\nФактические расходы API: 0 USD.`);
  console.log(`Повтор сравнения: npm run bench -- --baseline ${demo.baseline.run.manifest.runId} --current ${demo.current.run.manifest.runId}`);
}

main().catch((error: unknown) => { console.error(`Ошибка: ${String(redact(error instanceof Error ? error.message : String(error)))}`); process.exitCode = 1; });
