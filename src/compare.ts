import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { aggregate } from './aggregate.js';
import type { RunSummary } from './aggregate.js';
import type { AttemptRecord, SavedRun } from './types.js';
import { finalizeIntegrity, loadRun, writeJson } from './storage.js';
import { renderComparison } from './report.js';
import { loadEvaluation } from './judges.js';
import { hash } from './storage.js';
import { readFileSync } from 'node:fs';
import type { JudgedPair } from './judges.js';

function automaticRate(attempts: AttemptRecord[], threshold: number): number | null {
  const evaluated = attempts.filter((a) => a.checks.length > 0);
  return evaluated.length ? evaluated.filter((a) => {
    const weight = a.checks.reduce((s, c) => s + c.weight, 0);
    return !a.checks.some((c) => c.critical && !c.pass) && a.checks.reduce((s, c) => s + c.score * c.weight, 0) / weight >= threshold;
  }).length / evaluated.length : null;
}
const diff = (baseline: number | null, current: number | null) => baseline === null || current === null ? null : current - baseline;
function comparableTask(task: SavedRun['manifest']['suite']['tasks'][number]) { return hash(JSON.stringify({ ...task, limits: { ...task.limits, attempts: undefined } })); }

export function compareRuns(baseline: SavedRun, current: SavedRun) {
  const evaluationCompatible = baseline.manifest.evaluationVersion === current.manifest.evaluationVersion;
  const shellCompatible = baseline.manifest.shellVersion === current.manifest.shellVersion
    && baseline.manifest.environment.implementationHash === current.manifest.environment.implementationHash
    && JSON.stringify(baseline.manifest.environment.dependencies) === JSON.stringify(current.manifest.environment.dependencies)
    && baseline.manifest.environment.lockfileHash === current.manifest.environment.lockfileHash
    && baseline.manifest.environment.node === current.manifest.environment.node
    && baseline.manifest.environment.platform === current.manifest.environment.platform
    && baseline.manifest.environment.arch === current.manifest.environment.arch
    && JSON.stringify(baseline.manifest.browser) === JSON.stringify(current.manifest.browser)
    && JSON.stringify(baseline.manifest.execution ?? null) === JSON.stringify(current.manifest.execution ?? null)
    && JSON.stringify(baseline.manifest.generation) === JSON.stringify(current.manifest.generation);
  const conditions = (run: SavedRun) => run.manifest.conditions ? {
    provider: run.manifest.conditions.provider, executionMode: run.manifest.conditions.executionMode,
    clientVersion: run.manifest.conditions.clientVersion, authMethod: run.manifest.conditions.authMethod,
    tools: run.manifest.conditions.tools, configHash: run.manifest.conditions.configHash, isolation: run.manifest.conditions.isolation,
  } : { provider: 'mock' };
  const route = (run: SavedRun) => [...new Set(run.calls.filter((c) => c.role === 'candidate' && c.status === 'ok')
    .map((c) => `${c.returnedProvider ?? c.provider}/${c.returnedModel ?? c.requestedModel}; endpoint=${'candidate' in run.manifest.config ? run.manifest.config.candidate.providerEndpoint ?? 'client' : 'mock'}`))].sort();
  const routeChanged = JSON.stringify(route(baseline)) !== JSON.stringify(route(current));
  const routeVerified = (run: SavedRun) => run.manifest.mode === 'mock' || run.manifest.mode !== 'manual'
    && run.calls.some((c) => c.role === 'candidate' && c.status === 'ok')
    && run.calls.filter((c) => c.role === 'candidate' && c.status === 'ok')
      .every((c) => c.returnedModel !== null && (run.manifest.mode !== 'openrouter' || c.returnedProvider != null));
  const routesVerified = routeVerified(baseline) && routeVerified(current);
  const conditionsCompatible = JSON.stringify(conditions(baseline)) === JSON.stringify(conditions(current));
  const modelShell = (run: SavedRun) => run.manifest.conditions ? {
    ...conditions(run), configHash: undefined,
    settings: run.manifest.conditions.diagnostic.config.settings ?? null,
    endpoint: 'candidate' in run.manifest.config ? run.manifest.config.candidate.providerEndpoint : null,
    promptTransport: 'candidate' in run.manifest.config ? run.manifest.config.candidate.promptTransport : null,
    limits: 'limits' in run.manifest.config ? { ...run.manifest.config.limits, attempts: undefined } : null,
  } : conditions(run);
  const modelComparisonCompatible = shellCompatible && JSON.stringify(modelShell(baseline)) === JSON.stringify(modelShell(current));
  const regressionEligible = shellCompatible && conditionsCompatible && routesVerified && !routeChanged && baseline.manifest.mode !== 'manual';
  const matches = baseline.manifest.suite.tasks.filter((task) => task.readiness === 'enabled' && evaluationCompatible
    && current.manifest.suite.tasks.some(t => t.id === task.id && comparableTask(t) === comparableTask(task))
    && baseline.manifest.promptHashes[task.id] === current.manifest.promptHashes[task.id]
    && task.materials.every((m) => baseline.manifest.materialHashes[`${task.id}/${m.id}`] === current.manifest.materialHashes[`${task.id}/${m.id}`])
    && current.manifest.suite.tasks.some((t) => t.id === task.id && t.readiness === 'enabled'));
  const pairedBaseline: AttemptRecord[] = [];
  const pairedCurrent: AttemptRecord[] = [];
  const allPairedBaseline: AttemptRecord[] = [];
  const allPairedCurrent: AttemptRecord[] = [];
  const tasks = matches.map((task) => {
    const before = baseline.attempts.filter((a) => a.taskId === task.id);
    const after = current.attempts.filter((a) => a.taskId === task.id);
    const pairs = before.flatMap((a) => {
      const other = after.find((b) => b.index === a.index);
      return other ? [{ before: a, after: other }] : [];
    });
    // Одинаковые задания допускают сравнение систем. Строгость окружения нужна для сигнала, а не для A/B.
    const usable = pairs.filter((p) => p.before.checks.length > 0 && p.after.checks.length > 0);
    allPairedBaseline.push(...pairs.map((p) => p.before));
    allPairedCurrent.push(...pairs.map((p) => p.after));
    pairedBaseline.push(...usable.map((p) => p.before));
    pairedCurrent.push(...usable.map((p) => p.after));
    const baselineRate = automaticRate(usable.map((p) => p.before), task.passThreshold);
    const currentRate = automaticRate(usable.map((p) => p.after), task.passThreshold);
    const delta = diff(baselineRate, currentRate);
    return { taskId: task.id, title: task.title, primaryCategory: task.primaryCategory,
      pairedAttempts: usable.length, skippedPairs: pairs.length - usable.length,
      baselineAutomatedPassRate: baselineRate, currentAutomatedPassRate: currentRate,
      deltaPercentagePoints: delta === null ? null : delta * 100,
      baselineAttemptScores: usable.map((p) => p.before.checks.reduce((s, c) => s + c.score * c.weight, 0) / p.before.checks.reduce((s, c) => s + c.weight, 0)),
      currentAttemptScores: usable.map((p) => p.after.checks.reduce((s, c) => s + c.score * c.weight, 0) / p.after.checks.reduce((s, c) => s + c.weight, 0)),
      status: delta === null ? 'not_evaluated' : !regressionEligible ? 'comparison_only' : delta < 0 ? 'suspected' : delta > 0 ? 'improved' : 'stable' };
  });
  const comparableSuite = { ...baseline.manifest.suite, tasks: matches };
  const matchingCalls = (run: SavedRun, attempts: AttemptRecord[]) => run.calls.filter((c) => attempts.some((a) => a.attemptId === c.attemptId));
  // Расходы включают технически неудачные и пропущенные попытки того же парного набора.
  const before: RunSummary = aggregate(matchingCalls(baseline, allPairedBaseline), allPairedBaseline, comparableSuite, baseline.manifest.timezone);
  const after: RunSummary = aggregate(matchingCalls(current, allPairedCurrent), allPairedCurrent, comparableSuite, current.manifest.timezone);
  const beforeQuality = aggregate([], pairedBaseline, comparableSuite, baseline.manifest.timezone);
  const afterQuality = aggregate([], pairedCurrent, comparableSuite, current.manifest.timezone);
  const excludedTaskIds = [...new Set([...baseline.manifest.suite.tasks, ...current.manifest.suite.tasks].map((t) => t.id))].filter((id) => !matches.some((t) => t.id === id));
  return {
    schemaVersion: 1, mode: baseline.manifest.mode === 'mock' && current.manifest.mode === 'mock' ? 'mock' : 'measurement', baselineRunId: baseline.manifest.runId, currentRunId: current.manifest.runId,
    comparisonKind: !evaluationCompatible || !matches.length ? 'not_comparable' : modelComparisonCompatible ? 'models' : 'systems',
    suiteChanged: baseline.manifest.suiteHash !== current.manifest.suiteHash,
    evaluationCompatible, shellCompatible, conditionsCompatible, modelComparisonCompatible, regressionEligible, routeChanged, routesVerified,
    routes: { baseline: route(baseline), current: route(current) }, excludedTaskIds,
    environmentDifferences: [...new Set([...Object.keys(baseline.manifest.environment), ...Object.keys(current.manifest.environment)])]
      .filter((key) => key !== 'commit' && JSON.stringify(baseline.manifest.environment[key as keyof typeof baseline.manifest.environment]) !== JSON.stringify(current.manifest.environment[key as keyof typeof current.manifest.environment]))
      .map((key) => ({ field: key, baseline: baseline.manifest.environment[key as keyof typeof baseline.manifest.environment], current: current.manifest.environment[key as keyof typeof current.manifest.environment] })),
    systemConditions: { baseline: conditions(baseline), current: conditions(current) },
    regression: { eligible: regressionEligible, suspectedTaskIds: tasks.filter((t) => t.status === 'suspected').map((t) => t.taskId), requiresFreshRun: tasks.some((t) => t.status === 'suspected') },
    matchingTaskCount: matches.length, observedTaskCount: tasks.filter((t) => t.pairedAttempts > 0).length,
    pairedAttemptCount: pairedBaseline.length, tasks, baseline: before, current: after,
    categories: beforeQuality.categories.map((c) => {
      const other = afterQuality.categories.find((a) => a.id === c.id)!;
      return { id: c.id, label: c.label, tasks: c.taskCount, baselinePassRate: c.passRate, currentPassRate: other.passRate,
        deltaPassRatePercentagePoints: diff(c.passRate, other.passRate) === null ? null : diff(c.passRate, other.passRate)! * 100,
        baselineAutomatedPassRate: c.automatedPassRate, currentAutomatedPassRate: other.automatedPassRate,
        deltaAutomatedPercentagePoints: diff(c.automatedPassRate, other.automatedPassRate) === null ? null : diff(c.automatedPassRate, other.automatedPassRate)! * 100,
        baselineScore: c.meanScore, currentScore: other.meanScore };
    }),
    costDeltaUsd: diff(before.totals.costs.total.value, after.totals.costs.total.value),
    incurredCostDeltaUsd: diff(before.totals.incurredCostUsd, after.totals.incurredCostUsd),
    uncertainty: `${baseline.manifest.synthetic && current.manifest.synthetic ? 'Синтетическое демо.' : 'Малый диагностический набор.'} Повторы одной задачи зависимы; независимые единицы — задачи. Статистическая уверенность и причина изменения не оцениваются. Отрицательное изменение при совместимых условиях — только suspected; требуется свежий повтор. Несовместимые условия/маршрут исключены из автоматического сигнала.`,
    includesJudgeCosts: true,
    judging: null as { id: string; version: string; pairs: JudgedPair[]; orderDisputes: string[] } | null,
  };
}
export type Comparison = ReturnType<typeof compareRuns>;

export function saveComparison(root: string, baselineId: string, currentId: string, evaluationId?: string): { dir: string; comparison: Comparison } {
  const baseline = loadRun(root, baselineId), current = loadRun(root, currentId);
  const evaluation = evaluationId ? loadEvaluation(root, evaluationId) : null;
  if (evaluation && (evaluation.artifact.baselineRunId !== baselineId || evaluation.artifact.currentRunId !== currentId
    || evaluation.artifact.baselineIntegrityHash !== hash(readFileSync(join(root, baselineId, 'integrity.json')))
    || evaluation.artifact.currentIntegrityHash !== hash(readFileSync(join(root, currentId, 'integrity.json'))))) throw new Error('Оценка относится к другой паре или изменённым запускам');
  const comparison = compareRuns(baseline, evaluation ? { ...current, calls: [...current.calls, ...evaluation.calls] } : current);
  if (evaluation) comparison.judging = { id: evaluation.artifact.evaluationId, version: evaluation.artifact.judgeVersion, pairs: evaluation.artifact.pairs, orderDisputes: evaluation.artifact.orderDisputes };
  const parent = join(root, 'comparisons');
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, `compare-${randomUUID()}`);
  mkdirSync(dir);
  writeJson(join(dir, 'comparison.json'), comparison);
  writeFileSync(join(dir, 'report.html'), renderComparison(comparison), { flag: 'wx' });
  finalizeIntegrity(dir);
  return { dir, comparison };
}
