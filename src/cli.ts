import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { saveComparison } from './compare.js';
import { projectRoot, runDemo } from './runner.js';
import { withProjectLock } from './storage.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    baseline: { type: 'string' }, current: { type: 'string' },
    'results-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, allowPositionals: false });
  if (values.help) {
    console.log('npm run bench — два mock-запуска и сравнение\nnpm run bench -- --baseline <id> --current <id>\nДополнительно: --results-dir <путь>. Реальные провайдеры не поддерживаются.');
    return;
  }
  if (Boolean(values.baseline) !== Boolean(values.current)) throw new Error('Укажите и --baseline, и --current');
  const root = values['results-dir'] ? resolve(values['results-dir']) : join(projectRoot, 'results');
  if (values.baseline && values.current) {
    const result = await withProjectLock(root, async () => saveComparison(root, values.baseline!, values.current!));
    console.log(`Совпадающих задач: ${result.comparison.matchingTaskCount}; пар попыток: ${result.comparison.pairedAttemptCount}.\nОтчёт: ${join(result.dir, 'report.html')}`);
    return;
  }
  const demo = await runDemo({ resultsDir: root, onProgress: (message) => console.log(message) });
  console.log(`\nBaseline ID: ${demo.baseline.run.manifest.runId}\nCurrent ID: ${demo.current.run.manifest.runId}\nОтчёт baseline: ${join(demo.baseline.dir, 'report.html')}\nОтчёт current: ${join(demo.current.dir, 'report.html')}\nСравнение: ${join(demo.comparison.dir, 'report.html')}\nФактические расходы API: 0 USD.`);
  console.log(`Повтор сравнения: npm run bench -- --baseline ${demo.baseline.run.manifest.runId} --current ${demo.current.run.manifest.runId}`);
}

main().catch((error: unknown) => { console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
