import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { aggregate } from './aggregate.js';
import type { RunSummary } from './aggregate.js';
import type { AttemptRecord, SavedRun } from './types.js';
import { finalizeIntegrity, loadRun, writeJson } from './storage.js';
import { renderComparison } from './report.js';

function automaticRate(attempts: AttemptRecord[], threshold: number): number | null {
  const evaluated = attempts.filter((a) => a.checks.length > 0);
  return evaluated.length ? evaluated.filter((a) => {
    const weight = a.checks.reduce((s, c) => s + c.weight, 0);
    return !a.checks.some((c) => c.critical && !c.pass) && a.checks.reduce((s, c) => s + c.score * c.weight, 0) / weight >= threshold;
  }).length / evaluated.length : null;
}
const diff = (baseline: number | null, current: number | null) => baseline === null || current === null ? null : current - baseline;

export function compareRuns(baseline: SavedRun, current: SavedRun) {
  const evaluationCompatible = baseline.manifest.evaluationVersion === current.manifest.evaluationVersion;
  const shellCompatible = baseline.manifest.shellVersion === current.manifest.shellVersion
    && baseline.manifest.environment.implementationHash === current.manifest.environment.implementationHash
    && JSON.stringify(baseline.manifest.environment.dependencies) === JSON.stringify(current.manifest.environment.dependencies)
    && baseline.manifest.environment.node === current.manifest.environment.node
    && baseline.manifest.environment.platform === current.manifest.environment.platform
    && baseline.manifest.environment.arch === current.manifest.environment.arch
    && JSON.stringify(baseline.manifest.browser) === JSON.stringify(current.manifest.browser)
    && JSON.stringify(baseline.manifest.generation) === JSON.stringify(current.manifest.generation);
  const matches = baseline.manifest.suite.tasks.filter((task) => task.readiness === 'enabled' && evaluationCompatible
    && baseline.manifest.taskHashes[task.id] === current.manifest.taskHashes[task.id]
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
      status: delta === null ? 'not_evaluated' : delta < 0 ? 'suspected' : delta > 0 ? 'improved' : 'stable' };
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
    schemaVersion: 1, mode: 'mock', baselineRunId: baseline.manifest.runId, currentRunId: current.manifest.runId,
    comparisonKind: !evaluationCompatible || !matches.length ? 'not_comparable' : shellCompatible ? 'models' : 'systems',
    suiteChanged: baseline.manifest.suiteHash !== current.manifest.suiteHash,
    evaluationCompatible, shellCompatible, excludedTaskIds,
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
    uncertainty: 'Синтетическое демо. Две попытки одной задачи зависимы; независимые единицы — задачи. Статистическая уверенность и причина изменения не оцениваются. Отрицательное изменение — только suspected, требуется свежий повтор.',
    includesJudgeCosts: true,
  };
}
export type Comparison = ReturnType<typeof compareRuns>;

export function saveComparison(root: string, baselineId: string, currentId: string): { dir: string; comparison: Comparison } {
  const comparison = compareRuns(loadRun(root, baselineId), loadRun(root, currentId));
  const parent = join(root, 'comparisons');
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, `compare-${randomUUID()}`);
  mkdirSync(dir);
  writeJson(join(dir, 'comparison.json'), comparison);
  writeFileSync(join(dir, 'report.html'), renderComparison(comparison), { flag: 'wx' });
  finalizeIntegrity(dir);
  return { dir, comparison };
}
