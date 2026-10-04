import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { connectionSchema, loadConfig } from '../src/connections/config.js';
import { dryRun, pilotSuite, runPilot } from '../src/pilot.js';
import { projectRoot, taskPrompt } from '../src/runner.js';
import { aggregate } from '../src/aggregate.js';
import { compareRuns, saveComparison } from '../src/compare.js';
import { calibrate, evaluateSaved, loadEvaluation } from '../src/judges.js';
import { manualTemplate, parseManual, ManualConnection } from '../src/manual.js';
import { filesUnder, hash, loadRun, readJson } from '../src/storage.js';
import type { SavedRun } from '../src/types.js';
import { responsesSchema } from '../src/mock-provider.js';
import { answer, httpFixture } from './http-fixture.js';
import { readBudget } from '../src/state.js';

const config = loadConfig(join(projectRoot, 'configs/pilot-openrouter.json'));
config.candidate = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/pilot-v1', providerEndpoint: 'fixture/isolated' });
config.limits.maxRetries = 0;
const suite = pilotSuite(config), responses = responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json')));
let temp: string, root: string, baseline: SavedRun, current: SavedRun, stub: Awaited<ReturnType<typeof httpFixture>>;
let phase: 'candidate' | 'judge' | 'bad-judge' | 'quota' = 'candidate';
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'bench-pilot-integration-')); root = join(temp, 'results');
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture-secret-not-real-key');
  stub = await httpFixture(({ body, response }, count) => {
    if (phase === 'quota') { response.statusCode = 429; response.end(JSON.stringify({ error: { message: 'quota exhausted' } })); }
    else if (phase !== 'candidate') answer(response, body, phase === 'bad-judge' ? '{"verdict":"great","reason":"wrong enum"}' : '{"verdict":"A","reason":"A точнее соблюдает рубрику и источники"}');
    else answer(response, body, responses[suite.tasks[(count - 1) % suite.tasks.length]!.id]!.correct);
  });
  baseline = (await runPilot(config, { resultsDir: root, budgetUsd: 0.1, apiBaseUrl: stub.baseUrl })).run;
  current = (await runPilot(config, { resultsDir: root, budgetUsd: 0.1, apiBaseUrl: stub.baseUrl })).run;
});
afterAll(async () => { await stub?.close(); vi.unstubAllEnvs(); if (temp) rmSync(temp, { recursive: true, force: true }); });
describe('Pilot, immutable judge evaluations, manual import and compare', () => {
  it('не разрешает автоматический сигнал без подтверждённой фактической модели/маршрута', () => {
    const unknown = structuredClone(current); unknown.calls[0]!.returnedProvider = null;
    expect(compareRuns(baseline, unknown)).toMatchObject({ routesVerified: false, regressionEligible: false });
    unknown.calls[0]!.returnedModel = null;
    expect(compareRuns(baseline, unknown).tasks.every((t) => t.status !== 'suspected')).toBe(true);
  });
  it('promptfoo выполняет пять направлений, пишет ответы/скриншоты и отделяет pending', () => {
    expect(stub.bodies).toHaveLength(10);
    for (const run of [baseline, current]) {
      expect(run.manifest).toMatchObject({ mode: 'openrouter', billingMode: 'api', synthetic: false, schemaVersion: 2, status: 'complete' });
      expect(run.calls).toHaveLength(5); expect(run.attempts.filter((a) => a.status === 'passed')).toHaveLength(2);
      expect(run.attempts.filter((a) => a.status === 'pending')).toHaveLength(3);
      const summary = aggregate(run.calls, run.attempts, run.manifest.suite, run.manifest.timezone);
      expect(summary.uncoveredCategories).toHaveLength(10); expect(summary.totals.incurredCostUsd).toBe(0.0025);
      expect(run.manifest.realBudget).toMatchObject({ spentUsd: 0.0025, reservedUsd: 0 });
      expect(loadRun(root, run.manifest.runId).calls).toEqual(run.calls);
      const dir = join(root, run.manifest.runId);
      expect(filesUnder(dir).filter((p) => p.endsWith('.png'))).toHaveLength(4);
      for (const path of filesUnder(dir).filter((p) => !p.endsWith('.png'))) expect(readFileSync(join(dir, path), 'utf8')).not.toContain('fixture-secret-not-real-key');
    }
    expect(compareRuns(baseline, current)).toMatchObject({ pairedAttemptCount: 5, regressionEligible: true, conditionsCompatible: true, routeChanged: false });
  });
  it('dry-run показывает цену, readonly reservations и не отправляет генераций', async () => {
    const posts = stub.bodies.length, journal = JSON.stringify(readBudget(root));
    const plan = await dryRun(config, { resultsDir: root, apiBaseUrl: stub.baseUrl, budgetUsd: 0.1 });
    expect(plan).toMatchObject({ noGenerations: true, journalModified: false, budgetSufficient: true });
    expect(plan.requests).toHaveLength(5); expect(plan.upperCostUsd).toBeGreaterThan(0.05);
    expect(stub.bodies).toHaveLength(posts); expect(JSON.stringify(readBudget(root))).toBe(journal);
  });
  it('авария судьи после dispatched восстанавливает тот же слепой порядок без повторной генерации', async () => {
    const judges=structuredClone(config);judges.judges.text=connectionSchema.parse({provider:'openrouter',model:'vendor/judge-text-v1',providerEndpoint:'fixture/isolated'});
    const before=new Set(existsSync(join(root,'evaluations')) ? (await import('node:fs')).readdirSync(join(root,'evaluations')) : []),posts=stub.bodies.length;
    await expect(evaluateSaved(root,baseline.manifest.runId,current.manifest.runId,judges,{budgetUsd:0.1,apiBaseUrl:stub.baseUrl,limitPairs:1,
      fault:point=>{if(point==='dispatched')throw Error('judge crash fixture');}})).rejects.toThrow('Resume ID');
    const id=(await import('node:fs')).readdirSync(join(root,'evaluations')).find(p=>!before.has(p))!;
    const {StateStore}=await import('../src/state.js'),store=new StateStore(root);
    const prepared=store.assessment<{pairs:Array<{id:string;order:unknown}>}>(id,'judge-plan')!;const order=prepared.pairs.map(p=>({id:p.id,order:p.order}));store.close();
    const resumed=await evaluateSaved(root,baseline.manifest.runId,current.manifest.runId,judges,{budgetUsd:0.1,apiBaseUrl:stub.baseUrl,resumeId:id});
    expect(stub.bodies).toHaveLength(posts);expect(resumed.calls).toHaveLength(1);expect(resumed.calls[0]!.incurredCostUsd).toBeNull();
    expect(resumed.artifact.pairs.map(p=>({id:p.id,order:p.order}))).toEqual(order);
    expect(resumed.artifact.pairs.some(p=>p.executionStatus==='in_doubt')).toBe(true);
    expect(resumed.artifact.budget).toMatchObject({runs:{[id]:{spentMicroUsd:0,reservedMicroUsd:expect.any(Number)}}});
  });
  it('требует явный бюджет, отказывает до POST и сохраняет пропуски без провала качества', async () => {
    const posts = stub.bodies.length;
    await expect(runPilot(config, { resultsDir: root, apiBaseUrl: stub.baseUrl })).rejects.toThrow('--budget');
    const run = (await runPilot(config, { resultsDir: root, budgetUsd: 0.001, apiBaseUrl: stub.baseUrl })).run;
    expect(stub.bodies).toHaveLength(posts); expect(run.calls).toHaveLength(0);
    expect(run.attempts.every((a) => a.status === 'budget_exhausted' && a.assessments.every((s) => s.score === null))).toBe(true);
  });
  it('исключает несовместимые клиенты/инструменты и показывает изменение actual и configured route', () => {
    for (const kind of ['client', 'tools', 'mode', 'endpoint', 'actual-provider'] as const) {
      const changed = structuredClone(current);
      if (kind === 'client') changed.manifest.conditions!.clientVersion = 'different';
      if (kind === 'tools') changed.manifest.conditions!.tools = ['shell'];
      if (kind === 'mode') changed.manifest.conditions!.executionMode = 'agent';
      if (kind === 'endpoint' && 'candidate' in changed.manifest.config) changed.manifest.config.candidate.providerEndpoint = 'other';
      if (kind === 'actual-provider') changed.calls[0]!.returnedProvider = 'Other';
      const comparison = compareRuns(baseline, changed); expect(comparison.regressionEligible).toBe(false);
      expect(comparison.tasks.every((t) => t.status !== 'suspected')).toBe(true);
      if (kind === 'endpoint' || kind === 'actual-provider') expect(comparison.routeChanged).toBe(true);
      expect(comparison.pairedAttemptCount).toBe(5);
    }
  });
  it('без подходящего судьи pending, ручная слепая калибровка отдельная и неизменяемая', async () => {
    const posts = stub.bodies.length;
    const evaluation = await evaluateSaved(root, baseline.manifest.runId, current.manifest.runId, config, { apiBaseUrl: stub.baseUrl });
    expect(evaluation.calls).toHaveLength(0); expect(stub.bodies).toHaveLength(posts);
    expect(evaluation.artifact.pairs.every((p) => p.status === 'pending' && p.verdict === null)).toBe(true);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ javaScriptEnabled: false });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(pathToFileURL(join(evaluation.dir, 'report.html')).href);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally { await browser.close(); }
    const beforeHash = hash(readFileSync(join(evaluation.dir, 'evaluation.json')));
    const calibrated = calibrate(root, evaluation.artifact.evaluationId, { reviewer: 'local-human', reviews: [{ pairId: evaluation.artifact.pairs[0]!.id, verdict: 'tie', reason: 'Оба варианта сохраняют факты' }] });
    expect(existsSync(join(calibrated, 'calibration.json'))).toBe(true);
    expect(hash(readFileSync(join(evaluation.dir, 'evaluation.json')))).toBe(beforeHash);
    expect(() => calibrate(root, evaluation.artifact.evaluationId, { reviewer: 'human', reviews: [{ pairId: 'missing', verdict: 'A', reason: 'x' }] })).toThrow('Неизвестная');
  });
  it('слепое A/B и vision получают реальные изображения; порядок и цена сохранены без модификации baseline/current', async () => {
    phase = 'judge';
    const judges = structuredClone(config);
    judges.judges.text = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/judge-text-v1', providerEndpoint: 'fixture/isolated' });
    judges.judges.vision = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/judge-vision-v1', providerEndpoint: 'fixture/isolated' });
    const hashes = [baseline, current].map((r) => hash(readFileSync(join(root, r.manifest.runId, 'integrity.json')))), posts = stub.bodies.length;
    const evaluation = await evaluateSaved(root, baseline.manifest.runId, current.manifest.runId, judges, { budgetUsd: 0.1, apiBaseUrl: stub.baseUrl });
    expect(evaluation.calls).toHaveLength(3); expect(evaluation.calls.every((c) => c.role === 'judge')).toBe(true);
    for (const pair of evaluation.artifact.pairs) { expect(pair.status).toBe('evaluated'); expect(pair.winner).toBe(pair.order.A); expect(pair.callIds).toHaveLength(1); }
    const bodies = stub.bodies.slice(posts);
    const vision = bodies.find((b) => b.model === 'vendor/judge-vision-v1')!;
    const messages = vision.messages as Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
    const imageMessages = messages[0]!.content.filter((m) => m.type === 'image_url'); expect(imageMessages).toHaveLength(4);
    for (const image of imageMessages) expect(Buffer.from(image.image_url!.url.split(',')[1]!, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    for (const body of bodies) {
      const messages = body.messages as Array<{ content: unknown }>;
      expect(JSON.stringify(messages)).not.toContain('vendor/pilot-v1'); expect(JSON.stringify(messages)).not.toContain(baseline.manifest.runId); expect(JSON.stringify(messages)).not.toContain(current.manifest.runId);
    }
    expect([baseline, current].map((r) => hash(readFileSync(join(root, r.manifest.runId, 'integrity.json'))))).toEqual(hashes);
    const comparison = saveComparison(root, baseline.manifest.runId, current.manifest.runId, evaluation.artifact.evaluationId).comparison;
    expect(comparison.current.totals.judgeCalls).toBe(3); expect(comparison.current.totals.actualCosts.judgeTotal.value).toBe(0.0015);
    expect(comparison.current.totals.incurredCostUsd).toBe(0.004); expect(comparison.judging!.pairs).toHaveLength(3);
    expect(comparison.current.byAttempt[`${current.manifest.runId}/maintenance-notice-a1`]).toMatchObject({ callCount: 2, judgeCalls: 1, incurredCostUsd: 0.001 });
    expect(comparison.current.categories.find((c) => c.id === 'writing')!.primaryIncurredCostUsd.value).toBe(0.001);
    expect(loadEvaluation(root, evaluation.artifact.evaluationId).calls).toHaveLength(3);
  });
  it('смена порядка выявляет спор, а неверный вердикт сохраняет pending', async () => {
    const judges = structuredClone(config); judges.judges.text = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/judge-text-v1', providerEndpoint: 'fixture/isolated' });
    phase = 'judge';
    const swapped = await evaluateSaved(root, baseline.manifest.runId, current.manifest.runId, judges, { budgetUsd: 0.1, apiBaseUrl: stub.baseUrl, swapOrder: true, limitPairs: 2 });
    expect(swapped.artifact.orderDisputes).toContain('maintenance-notice-a1');
    expect(swapped.artifact.pairs.filter((p) => p.taskId === 'maintenance-notice').map((p) => p.order.A).sort()).toEqual(['baseline', 'current']);
    phase = 'bad-judge';
    const bad = await evaluateSaved(root, baseline.manifest.runId, current.manifest.runId, judges, { budgetUsd: 0.1, apiBaseUrl: stub.baseUrl, limitPairs: 1 });
    expect(bad.calls).toHaveLength(1); expect(bad.artifact.pairs[0]).toMatchObject({ status: 'pending', verdict: null });
  });
  it('manual импортирует только заданные ответы, usage/генерационное время неизвестны, промпты/сессии валидируются', async () => {
    const manual = loadConfig(join(projectRoot, 'configs/pilot-manual.json')), templatePath = join(temp, 'manual-template.json'); manualTemplate(manual, templatePath);
    expect(() => manualTemplate(manual, templatePath)).toThrow(); // История/черновик пользователя не перезаписываются.
    const t = pilotSuite(manual).tasks.find((t) => t.id === 'pagination')!;
    const input = parseManual({ version: 1, model: 'declared-web-model', clientVersion: 'webchat-date', executionMode: 'model-only',
      answers: [{ taskId: t.id, index: 1, promptHash: hash(taskPrompt(t)), response: responses[t.id]!.correct, sessionId: 'new-session-1', newSession: true, tools: [], elapsedMs: null }] }, manual);
    manual.candidate = connectionSchema.parse({ ...manual.candidate, model: input.model });
    const posts = stub.bodies.length, imported = (await runPilot(manual, { resultsDir: root, connection: new ManualConnection(manual.candidate, input) })).run;
    expect(stub.bodies).toHaveLength(posts); expect(imported.calls).toHaveLength(1); expect(imported.attempts.filter((a) => a.status === 'not_evaluated')).toHaveLength(4);
    expect(imported.calls[0]).toMatchObject({ billingMode: 'manual', usage: { inputTotal: null, outputTotal: null }, generationElapsedMs: null, elapsedKind: 'import-processing' });
    expect(compareRuns(imported, imported).regressionEligible).toBe(false);
    const broken = structuredClone(input); broken.answers[0]!.promptHash = '0'.repeat(64); expect(() => parseManual(broken, manual)).toThrow('промпт');
    const reused = structuredClone(input); reused.answers.push({ ...reused.answers[0]!, taskId: 'contact-form', promptHash: hash(taskPrompt(pilotSuite(manual).tasks[0]!)) });
    expect(() => parseManual(reused, manual)).toThrow('сессию');
    writeFileSync(join(temp, 'manual-result-id.txt'), imported.manifest.runId); // Только собственный временный fixture.
  });
  it('квота одного судьи останавливает остальные модели судей без fallback', async () => {
    const judges = structuredClone(config);
    judges.judges.text = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/judge-text-v1', providerEndpoint: 'fixture/isolated' });
    judges.judges.vision = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/judge-vision-v1', providerEndpoint: 'fixture/isolated' });
    phase = 'quota'; const posts = stub.bodies.length;
    try {
      const evaluation = await evaluateSaved(root, baseline.manifest.runId, current.manifest.runId, judges, { budgetUsd: 0.1, apiBaseUrl: stub.baseUrl });
      expect(stub.bodies).toHaveLength(posts + 1); expect(evaluation.calls).toHaveLength(1);
      expect(evaluation.calls[0]!.status).toBe('quota_exhausted');
      expect(evaluation.artifact.pairs.every((p) => p.status === 'pending' && p.reason.includes('429'))).toBe(true);
    } finally { phase = 'judge'; }
  });
  it('кандидатский HTTP 429 тоже останавливает весь promptfoo запуск без скрытых повторов', async () => {
    phase = 'quota'; const posts = stub.bodies.length;
    try {
      const run = (await runPilot(config, { resultsDir: root, budgetUsd: 0.1, apiBaseUrl: stub.baseUrl })).run;
      expect(stub.bodies).toHaveLength(posts + 1); expect(run.calls).toHaveLength(1);
      expect(run.attempts.every((a) => a.status === 'quota_exhausted' && a.assessments.every((s) => s.score === null))).toBe(true);
      expect(run.manifest.realBudget.reservedUsd).toBeGreaterThan(0);
    } finally { phase = 'judge'; }
  });
});
