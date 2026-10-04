import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, SqliteBudgetLedger } from '../src/state.js';
import { loadConfig, connectionSchema } from '../src/connections/config.js';
import { projectRoot, taskPrompt } from '../src/runner.js';
import { createRunDir, withProjectLock, appendJsonl } from '../src/storage.js';
import { CallExecutor } from '../src/call-executor.js';
import { emptyResult } from '../src/connections/parsers.js';
import type { ModelConnection } from '../src/connections/types.js';
import { task } from './helpers.js';
import { runPilot } from '../src/pilot.js';
const [root, phase, tag] = process.argv.slice(2) as [string, string, string];
const config = loadConfig(join(projectRoot, 'configs/pilot-openrouter.json'));
config.candidate = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/pilot-v1', providerEndpoint: 'fixture/isolated' });
config.taskIds = ['pagination']; config.limits.maxRetries = 0;
export function recoveryConnection(root: string, failed = false, unknown = false): ModelConnection {
  return { config: config.candidate, tariff: () => null, upperBound: () => ({ perCallUsd: 0.01, attemptUsd: 0.01 }),
    diagnose: async () => ({ provider: 'openrouter', status: 'ok', reason: 'test fixture', version: 'fixture-1', authMethod: 'stub', configuredModel: 'vendor/pilot-v1',
      modelAvailability: 'available', config: {}, executionMode: 'model-only', tools: [] }),
    execute: async request => {
      appendJsonl(join(root, 'requests.jsonl'), { taskId: request.taskId, workspace: request.workspace }); request.onGenerationId?.('gen-fixture');
      return { ...emptyResult(), status: failed ? 'technical_error' : 'ok', reason: failed ? 'fixture failed' : '',
        output: '{"items":[{"id":2,"amount":20},{"id":3,"amount":30}],"total":4,"nextOffset":3}', generationId: 'gen-fixture', incurredCostUsd: unknown ? null : 0.00001,
        returnedModel: 'vendor/pilot-v1', returnedProvider: 'Fixture', agentSteps: 1, internalRetries: 0 };
    } };
}
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '') && phase === 'reserve') {
  const store = new StateStore(root), ledger = new SqliteBudgetLedger(store, { perRequestUsd: 1, perTaskUsd: 1, runUsd: 0.01, monthUsd: 1 }, 'UTC');
  console.log(JSON.stringify(ledger.reserve('parallel', tag, { perCallUsd: 0.01, attemptUsd: 0.01 }, new Date()))); store.close();
} else if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '') && phase) {
  const fault = (point: string) => { if (point === phase) { writeFileSync(join(root, 'crashed.txt'), phase); process.kill(process.pid, 'SIGKILL'); } };
  if (phase === 'finalizing') await runPilot(config, { resultsDir: root, budgetUsd: 0.1, connection: recoveryConnection(root), fault });
  else await withProjectLock(root, async store => {
    const created = createRunDir(root, 'crash'); writeFileSync(join(root, 'worker-info.json'), JSON.stringify(created));
    store.createRun(created.runId, { config, budgetUsd: 0.1 });
    const ledger = new SqliteBudgetLedger(store, { ...config.apiBudget, runUsd: 0.1 }, config.timezone);
    const connection = recoveryConnection(root, phase === 'failed' || phase === 'in_doubt', phase === 'in_doubt'), executor = new CallExecutor(created.runId, created.dir, config, connection, await connection.diagnose(), ledger, 'candidate', undefined, { store, fault });
    await executor.execute(task(), 'pagination-a1', 1, taskPrompt(task()));
  });
}
