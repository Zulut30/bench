import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPilot } from '../src/pilot.js';
import { reconcileRun } from '../src/reconcile.js';
import { loadConfig, connectionSchema } from '../src/connections/config.js';
import { readBudget, StateStore } from '../src/state.js';
import { hash, loadRun } from '../src/storage.js';
import { projectRoot } from '../src/runner.js';
import { answer, httpFixture } from './http-fixture.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
describe('GET сверка не вызывает генерацию и не меняет историю', () => {
  it('неизвестный usage удерживает резерв; terminal total_cost сверяется идемпотентно отдельным артефактом', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'reconciliation-fixture-key');
    const root = mkdtempSync(join(tmpdir(), 'bench-reconcile-test-')); roots.push(root);
    let terminal = false, cost: number | null = null, gets = 0;
    const stub = await httpFixture(({ body, response }) => answer(response, body, '{"total":4,"page":2,"pageSize":2,"items":[{"id":2,"amount":20},{"id":3,"amount":30}]}', { id: 'gen-reconcile-fixture', usage: undefined }),
      { generation: (_request, response) => { gets++; response.end(JSON.stringify({ data: { id: 'gen-reconcile-fixture', model: 'vendor/pilot-v1', total_cost: cost, finish_reason: terminal ? 'stop' : null } })); } });
    try {
      const config = loadConfig(join(projectRoot, 'configs/pilot-openrouter.json')); config.taskIds = ['pagination']; config.limits.maxRetries = 0;
      config.candidate = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/pilot-v1', providerEndpoint: 'fixture/isolated' });
      const { run, dir } = await runPilot(config, { resultsDir: root, budgetUsd: 0.1, apiBaseUrl: stub.baseUrl });
      const initial = hash(readFileSync(join(dir, 'integrity.json'))), held = readBudget(root)!.runs[run.manifest.runId]!.reservedMicroUsd;
      expect(held).toBeGreaterThan(0); expect(run.calls[0]!.incurredCostUsd).toBeNull();
      const unknown = await reconcileRun(root, run.manifest.runId, { apiBaseUrl: stub.baseUrl }); expect(unknown.report.results[0]?.status).toBe('in_doubt');
      expect(readBudget(root)!.runs[run.manifest.runId]!.reservedMicroUsd).toBe(held);
      terminal = true; cost = 0.00017;
      const known = await reconcileRun(root, run.manifest.runId, { apiBaseUrl: stub.baseUrl }); expect(known.report.results[0]?.status).toBe('reconciled');
      expect(readBudget(root)!.runs[run.manifest.runId]).toEqual({ spentMicroUsd: 170, reservedMicroUsd: 0 });
      const again = await reconcileRun(root, run.manifest.runId, { apiBaseUrl: stub.baseUrl }); expect(again.report.results[0]?.status).toBe('already_reconciled');
      expect(gets).toBe(2); expect(stub.bodies).toHaveLength(1); expect(hash(readFileSync(join(dir, 'integrity.json')))).toBe(initial);
      expect(loadRun(root, run.manifest.runId).calls[0]!.incurredCostUsd).toBeNull(); // Исторический unknown не переписывается.
      expect(readFileSync(join(known.dir, 'reconciliation.json'), 'utf8')).not.toContain('reconciliation-fixture-key');
      const store = new StateStore(root); expect(store.reconciliation(run.calls[0]!.callId)).toMatchObject({ costUsd: 0.00017 }); store.close();
      await expect(reconcileRun(root, run.manifest.runId, { input: { calls: [{ callId: 'foreign', generationId: 'gen-x' }] } })).rejects.toThrow('уникальные');
    } finally { await stub.close(); }
  });
});
