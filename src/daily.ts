import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunConfig } from './connections/config.js';
import { StateStore } from './state.js';
import { finalizeIntegrity, loadRun, readJson, verifyIntegrity, writeJson } from './storage.js';
import { projectRoot } from './runner.js';
import { runPilot } from './pilot.js';
import type { Comparison } from './compare.js';
import { saveComparison } from './compare.js';

export function resumePlan(root: string, runId: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(runId)) throw new Error('Неверный ID');
  const store = new StateStore(root);
  try { return store.run<{ kind?: string; baselineId?: string; currentId?: string; config: RunConfig; suite: unknown; startedAt: string; budgetUsd: number | null }>(runId).plan; }
  finally { store.close(); }
}
export function exportRun(root: string, runId: string, destination: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(runId)) throw new Error('Неверный ID запуска');
  const output = resolve(destination), source = resolve(root, runId);
  if (existsSync(output) || output === source || output.startsWith(source + '/')) throw new Error('Export требует новую папку вне исходного запуска');
  const complete = existsSync(join(source, 'integrity.json'));
  if (complete) verifyIntegrity(source);
  else if (!existsSync(source)) throw new Error('Нет папки запуска');
  mkdirSync(output, { recursive: true });
  cpSync(source, join(output, runId), { recursive: true, errorOnExist: true, force: false });
  if (!complete) {
    const store = new StateStore(root);
    try { writeJson(join(output, runId, 'recovery-state.json'), { ...store.run(runId), calls: store.intents(runId), events: store.events(runId), budget: store.budget('api') ?? null }); }
    finally { store.close(); }
    finalizeIntegrity(join(output, runId));
  }
  writeJson(join(output, 'export.json'), { format: 'immutable-json-jsonl-html', runId, complete,
    sourceIntegrity: complete ? readJson(join(source, 'integrity.json')) : null, createdAt: new Date().toISOString() });
  verifyIntegrity(join(output, runId)); return join(output, runId, complete ? 'report.html' : 'recovery-state.json');
}
export async function rerunSuspected(root: string, comparisonId: string, options: { attempts?: number; budgetUsd?: number; signal?: AbortSignal; log?: (event: Record<string, unknown>) => void } = {}) {
  if (!/^compare-[a-f0-9-]{36}$/.test(comparisonId)) throw new Error('Неверный ID сравнения');
  const dir = join(root, 'comparisons', comparisonId); verifyIntegrity(dir, ['comparison.json']);
  const comparison = readJson(join(dir, 'comparison.json')) as Comparison;
  const source = loadRun(root, comparison.currentRunId), tasks = comparison.tasks.filter(t => t.status === 'suspected').map(t => t.taskId);
  if (!comparison.regressionEligible || !tasks.length) throw new Error('Нет совместимого suspected-сигнала для свежего повтора');
  if (!('candidate' in source.manifest.config)) throw new Error('Legacy demo повторяется командой demo; для monitoring нужен run');
  const config = structuredClone(source.manifest.config); config.taskIds = tasks; config.limits.attempts = options.attempts ?? 3;
  const result = await runPilot(config, { resultsDir: root, ...options });
  const followup = saveComparison(root, comparison.currentRunId, result.run.manifest.runId);
  return { ...result, comparison: followup, independentTaskCount: tasks.length, note: 'Свежие ответы без promptfoo cache. Повторы зависимы; отрицательная разница остаётся suspected, причина не установлена.' };
}
export const defaultResults = join(projectRoot, 'results');
