import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { categoryIds } from '../src/categories.js';
import { loadConfig } from '../src/connections/config.js';
import { BrowserChecks, evaluateChecks } from '../src/checks.js';
import { pilotSuite, runPilot } from '../src/pilot.js';
import { aggregate } from '../src/aggregate.js';
import { compareRuns } from '../src/compare.js';
import { projectRoot } from '../src/runner.js';
import { createRunDir, loadRun, readJson } from '../src/storage.js';
import { diagnoseSandbox } from '../src/sandbox.js';

const config = loadConfig(join(projectRoot, 'configs/pilot-mock.json')); config.profile = 'standard'; config.limits.attempts = 2;
const suite = pilotSuite(config);
const examples = readJson(join(projectRoot, 'fixtures/standard-examples.json')) as Record<string, { correctAlternatives: string[]; incorrectExamples: Array<{ output: string; reason: string }> }>;
let temp: string; const browser = new BrowserChecks();
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'bench-standard-test-'));
  expect(await diagnoseSandbox(config.sandbox), 'Сначала npm run sandbox:build; Docker должен работать').toMatchObject({ status: 'ok' });
  await browser.start();
});
afterAll(async () => { await browser.close(); vi.unstubAllEnvs(); if (temp) rmSync(temp, { recursive: true, force: true }); });
describe('16 отдельных практических заданий', () => {
  it('по одному primaryCategory, версии, фиксированные материалы, альтернативы и пример дефекта', () => {
    expect(suite.tasks).toHaveLength(16); expect(new Set(suite.tasks.map(t => t.primaryCategory))).toEqual(new Set(categoryIds));
    expect(new Set(suite.tasks.map(t => t.id)).size).toBe(16);
    for (const t of suite.tasks) {
      expect(t.version).toBeTruthy(); expect(t.materials.length).toBeGreaterThan(0); expect(t.readiness).toBe('enabled');
      expect(t.validation?.fixture).toBe('fixtures/standard-examples.json');
      expect(examples[t.id]?.correctAlternatives).toHaveLength(2);
      expect(new Set(examples[t.id]?.correctAlternatives).size).toBe(2);
      expect(examples[t.id]?.incorrectExamples[0]?.reason).toBeTruthy();
    }
  });
  for (const t of suite.tasks) it(`${t.primaryCategory}: принимает две реализации и обнаруживает содержательный дефект`, async () => {
    const variants = examples[t.id]!;
    for (const [i, output] of [...variants.correctAlternatives, variants.incorrectExamples[0]!.output].entries()) {
      const { dir } = createRunDir(temp, 'example');
      const checks = await evaluateChecks(t, output, browser, dir, `${t.id}-fixture-${i}`, config.sandbox);
      expect(checks).toHaveLength(t.checks.length);
      const passed = checks.every(c => c.pass);
      expect(passed, checks.map(c => c.reason).join('\n')).toBe(i < 2);
      if (t.execution && i < 2) {
        const evidence = checks.flatMap(c => c.evidence).find(p => p.endsWith('-container.json'))!;
        const log = readJson(join(dir, evidence)) as { environment: { candidateUid: number; browserVersion: string | null }; results: Array<{ id: string; reason: string }> };
        expect(log.environment.candidateUid).toBe(10001);
        if (t.primaryCategory === 'frontend') expect(log.environment.browserVersion).toMatch(/^\d+\./);
        if (t.primaryCategory === 'test-writing') expect(log.results.find(r => r.id === 'mutation-detection')?.reason).toContain('4/4');
      }
    }
  });
  it('smoke проходит через promptfoo без ключей, два повтора учитываются один раз, subjective остаётся pending', async () => {
    for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(key, '');
    const smoke = structuredClone(config); smoke.profile = 'smoke';
    const root = join(temp, 'smoke'), result = await runPilot(smoke, { resultsDir: root });
    expect(result.run.calls).toHaveLength(12); expect(result.run.attempts).toHaveLength(12);
    expect(result.run.attempts.filter(a => a.status === 'pending')).toHaveLength(4);
    expect(result.run.attempts.filter(a => a.status === 'passed')).toHaveLength(8);
    expect(result.run.manifest.realBudget).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
    const summary = aggregate(result.run.calls, result.run.attempts, result.run.manifest.suite, 'UTC');
    expect(summary.uncoveredCategories).toHaveLength(10); expect(summary.totals.incurredCostUsd).toBe(0);
    expect(loadRun(root, result.run.manifest.runId).calls).toEqual(result.run.calls);
    const one = structuredClone(result.run); one.manifest.suite.tasks.forEach(t => { t.limits.attempts = 1; }); one.attempts = one.attempts.filter(a => a.index === 1);
    const comparison = compareRuns(one, result.run);
    expect(comparison.matchingTaskCount).toBe(6); expect(comparison.pairedAttemptCount).toBe(6);
    expect(readFileSync(join(result.dir, 'report.html'), 'utf8')).toContain('проверки');
    const reportBrowser = await chromium.launch();
    try {
      const page = await reportBrowser.newPage({ javaScriptEnabled: false });
      for (const width of [1440,390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(pathToFileURL(join(result.dir,'report.html')).href);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Отчёт не должен распираться image ID/длинным путём шрифта').toBe(true);
      }
    } finally { await reportBrowser.close(); }
  });
});
