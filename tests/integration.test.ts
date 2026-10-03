import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { compareRuns, saveComparison } from '../src/compare.js';
import { aggregate } from '../src/aggregate.js';
import { projectRoot, runDemo } from '../src/runner.js';
import { filesUnder, hash, loadRun, readJson, withProjectLock } from '../src/storage.js';
import type { SavedRun } from '../src/types.js';
import { config } from './helpers.js';

describe('Полное локальное демо, отчёты и сравнение', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bench-integration-'));
  const root = join(temp, 'results');
  let baseline: SavedRun;
  let current: SavedRun;
  beforeAll(() => {
    const browsersPath = chromium.executablePath().replace(/[\\/](?:chromium|chromium_headless_shell)-\d+[\\/].*$/, '');
    const child = spawnSync(process.execPath, ['--require', join(projectRoot, 'tests/offline-guard.cjs'), '--import', 'tsx', join(projectRoot, 'src/cli.ts'), '--results-dir', root], {
      cwd: projectRoot, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      // Отсутствуют все ключи, токены и пользовательские dotenv-файлы.
      env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, LANG: 'en_US.UTF-8',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? browsersPath,
        BENCH_TEST_NETWORK_LOG: join(temp, 'network.json') },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(readJson(join(temp, 'network.json'))).toEqual({ attempts: 0, events: [], credentialEnvNames: [] });
    const ids = readdirSync(root);
    baseline = loadRun(root, ids.find((id) => id.includes('-baseline-'))!);
    current = loadRun(root, ids.find((id) => id.includes('-current-'))!);
  });
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('создаёт два полных разных запуска через настоящий движок promptfoo без сети/ключей', () => {
    for (const run of [baseline, current]) {
      expect(run.manifest.status).toBe('complete');
      expect(run.manifest.mode).toBe('mock');
      expect(run.manifest.realBudget).toEqual({ limitUsd: 0, spentUsd: 0, reservedUsd: 0 });
      expect(run.attempts).toHaveLength(20);
      expect(run.calls).toHaveLength(21);
      expect(run.calls.every((c) => c.incurredCostUsd === 0)).toBe(true);
      expect(run.calls.every((c) => c.apiRequests === 0)).toBe(true);
      expect(run.calls.filter((c) => c.role === 'judge')).toHaveLength(0);
      expect(existsSync(join(root, run.manifest.runId, 'promptfoo.json'))).toBe(true);
      expect(run.attempts.every((a) => a.checks.length === 2)).toBe(true);
    }
    expect(baseline.attempts.filter((a) => a.status === 'failed')).toHaveLength(10);
    expect(current.attempts.filter((a) => a.status === 'failed')).toHaveLength(1);
    expect(current.attempts.filter((a) => a.status === 'passed')).toHaveLength(7);
    expect(current.attempts.filter((a) => a.status === 'pending')).toHaveLength(12);
  });
  it('сохраняет raw usage, кеш, ноль, неполные начисления и неизрасходованный резерв', () => {
    const summary = aggregate(current.calls, current.attempts, current.manifest.suite, current.manifest.timezone);
    expect(summary.totals).toMatchObject({ callCount: 21, retryCalls: 1, localCacheReads: 1, incompleteUsageCalls: 2, judgeCalls: 0, incurredCostUsd: 0 });
    expect(summary.totals.costs.total.value).toBeNull();
    expect(current.calls.find((c) => c.taskId === 'pricing-layout' && c.attemptId.endsWith('a2'))?.usage.total).toBe(0);
    expect(current.calls.find((c) => c.taskId === 'dashboard-layout' && c.attemptId.endsWith('a2'))?.usage.total).toBeNull();
    expect(current.manifest.budget.runs[current.manifest.runId]?.reservedMicroUsd).toBe(22528);
    expect(current.calls.find((c) => c.delivery === 'local_cache')?.historicalUsage?.total).toBe(300);
    expect(summary.uncoveredCategories).toHaveLength(10);
  });
  it('вычисляет ожидаемое изменение и только suspected для одного слабого ответа', () => {
    const comparison = compareRuns(baseline, current);
    expect(comparison.comparisonKind).toBe('models');
    expect(comparison.matchingTaskCount).toBe(10);
    expect(comparison.observedTaskCount).toBe(10);
    expect(comparison.pairedAttemptCount).toBe(20);
    expect(comparison.tasks.find((t) => t.taskId === 'contact-form')).toMatchObject({ deltaPercentagePoints: 100, status: 'improved', pairedAttempts: 2 });
    expect(comparison.tasks.find((t) => t.taskId === 'faq-disclosure')).toMatchObject({ deltaPercentagePoints: -50, status: 'suspected' });
    expect(comparison.categories.find((c) => c.id === 'ui-design')).toMatchObject({ baselineScore: null, currentScore: null });
    expect(comparison.costDeltaUsd).toBeNull();
  });
  it('исключает несовпадающие материалы/оценку и отмечает смену оболочки', () => {
    const changed = structuredClone(current);
    changed.manifest.materialHashes['contact-form/source'] = 'changed';
    expect(compareRuns(baseline, changed).excludedTaskIds).toContain('contact-form');
    changed.manifest.evaluationVersion = 'new-version';
    expect(compareRuns(baseline, changed)).toMatchObject({ comparisonKind: 'not_comparable', matchingTaskCount: 0, pairedAttemptCount: 0 });
    const otherShell = structuredClone(current); otherShell.manifest.shellVersion = 'another-shell';
    expect(compareRuns(baseline, otherShell).comparisonKind).toBe('systems');
  });
  it('не включает пропуски в сравнение качества, но сохраняет расходы технической ошибки', () => {
    const skipped = structuredClone(current);
    const a = skipped.attempts.find((a) => a.taskId === 'contact-form' && a.index === 1)!;
    a.status = 'technical_error'; a.checks = []; a.assessments.forEach((s) => { s.status = 'not_evaluated'; s.score = null; s.automatedScore = null; s.automatedPass = null; });
    const comparison = compareRuns(baseline, skipped);
    expect(comparison.tasks.find((t) => t.taskId === 'contact-form')).toMatchObject({ pairedAttempts: 1, skippedPairs: 1 });
    expect(comparison.current.totals.callCount).toBe(21);
  });
  it('повтор сравнения создаёт новую папку, не изменяя историю', () => {
    const dir = join(root, baseline.manifest.runId);
    const before = filesUnder(dir).map((p) => `${p}:${hash(readFileSync(join(dir, p)))}`);
    const first = saveComparison(root, baseline.manifest.runId, current.manifest.runId);
    const second = saveComparison(root, baseline.manifest.runId, current.manifest.runId);
    expect(first.dir).not.toBe(second.dir);
    expect(first.comparison).toEqual(second.comparison);
    expect(filesUnder(dir).map((p) => `${p}:${hash(readFileSync(join(dir, p)))}`)).toEqual(before);
  });
  it('HTML читается без JavaScript, содержит ссылки на существующие артефакты и реальные скриншоты', async () => {
    const browser = await chromium.launch({ env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp } });
    try {
      const page = await browser.newPage({ javaScriptEnabled: false });
      const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith('file:') ? route.continue() : route.abort());
      const report = join(root, current.manifest.runId, 'report.html');
      await page.goto(pathToFileURL(report).toString());
      expect(await page.locator('h1').textContent()).toContain('current');
      expect(await page.locator('body').textContent()).toContain('не покрыто');
      const hrefs = await page.locator('a').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
      for (const href of hrefs) { expect(href).toBeTruthy(); expect(existsSync(resolve(root, current.manifest.runId, href!)), href!).toBe(true); }
      expect(await page.locator('img').count()).toBe(4);
      expect(await page.locator('img').evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
    const screenshot = current.attempts.find((a) => a.taskId === 'pricing-layout' && a.index === 1)!.artifacts.find((p) => p.endsWith('-390.png'))!;
    expect(readFileSync(join(root, current.manifest.runId, screenshot)).readUInt32BE(16)).toBe(390);
  });
  it('отклоняет изменённые артефакты и небезопасные ID', () => {
    const path = join(root, baseline.manifest.runId, 'summary.json');
    const original = readFileSync(path);
    try {
      writeFileSync(path, '{}');
      expect(() => loadRun(root, baseline.manifest.runId)).toThrow('Артефакт изменён');
    } finally { writeFileSync(path, original); }
    expect(() => loadRun(root, '../somewhere')).toThrow('ID');
  });
  it('общий lock исключает два одновременных процесса', async () => {
    let release: () => void = () => {};
    const first = withProjectLock(root, () => new Promise<void>((done) => { release = done; }));
    await expect(withProjectLock(root, async () => {})).rejects.toThrow('.bench.lock');
    release(); await first;
    expect(existsSync(join(root, '.bench.lock'))).toBe(false);
  });
  it('нулевой синтетический бюджет сохраняет пропуски без фиктивных провалов', async () => {
    const zero = { ...config, syntheticBudget: { perRequestUsd: 0, perTaskUsd: 0, runUsd: 0, monthUsd: 0 } };
    const result = await runDemo({ resultsDir: join(temp, 'zero'), config: zero });
    for (const run of [result.baseline.run, result.current.run]) {
      expect(run.manifest.status).toBe('complete_with_skips');
      expect(run.attempts.filter((a) => a.status === 'budget_exhausted')).toHaveLength(19);
      expect(run.attempts.filter((a) => a.status === 'failed')).toHaveLength(0);
      expect(run.calls).toHaveLength(1); // Бесплатное локальное чтение кеша.
      expect(run.calls[0]?.apiRequests).toBe(0);
      const summary = aggregate(run.calls, run.attempts, run.manifest.suite, run.manifest.timezone);
      expect(summary.totals.costPerSuccessUsd).toBeNull();
      expect(summary.categories.find((c) => c.id === 'backend')?.passRate).toBeNull();
    }
  });
});
