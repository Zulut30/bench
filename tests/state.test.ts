import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProcess } from '../src/connections/process.js';
import { BudgetLedger } from '../src/budget.js';
import { StateStore, SqliteBudgetLedger } from '../src/state.js';
import { CallExecutor } from '../src/call-executor.js';
import { loadConfig, connectionSchema } from '../src/connections/config.js';
import { projectRoot, taskPrompt } from '../src/runner.js';
import { hash, readJson, readJsonl, withProjectLock, filesUnder } from '../src/storage.js';
import { recoveryConnection } from './state-worker.js';
import { task } from './helpers.js';
import { runPilot } from '../src/pilot.js';
import { chromium } from 'playwright';
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'bench-durable-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config = loadConfig(join(projectRoot, 'configs/pilot-openrouter.json')); config.taskIds = ['pagination']; config.limits.maxRetries = 0;
config.candidate = connectionSchema.parse({ provider: 'openrouter', model: 'vendor/pilot-v1', providerEndpoint: 'fixture/isolated' });
async function worker(root: string, phase: string, tag = '') {
  return executeProcess(process.execPath, ['--import', 'tsx', join(projectRoot, 'tests/state-worker.ts'), root, phase, tag], {
    cwd: projectRoot, env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? chromium.executablePath().replace(/[\\/](?:chromium|chromium_headless_shell)-\d+[\\/].*$/, '') }, timeoutMs: 30000 });
}
describe('SQLite — реальные параллельные процессы и SIGKILL', () => {
  it('не позволяет двум процессам зарезервировать один и тот же остаток', async () => {
    const root = temp(), store = new StateStore(root); store.close();
    const results = await Promise.all([worker(root, 'reserve', 'a'), worker(root, 'reserve', 'b')]);
    expect(results.every(r => r.code === 0), JSON.stringify(results)).toBe(true);
    expect(results.map(r => JSON.parse(r.stdout)).filter(d => d.allowed)).toHaveLength(1);
    const db = new StateStore(root); expect(db.budget('api')!.runs.parallel!.reservedMicroUsd).toBe(10000); db.close();
  });
  it('мигрирует JSON идемпотентно, сохраняет оригинал и блокирует последующее изменение старого журнала', () => {
    const root = temp(), ledger = new BudgetLedger({ perRequestUsd: 1, perTaskUsd: 1, runUsd: 1, monthUsd: 1 }, 'UTC', undefined, undefined, 'api');
    const d = ledger.reserve('old', 'task', { perCallUsd: 0.1, attemptUsd: 0.1 }, new Date()); if (!d.allowed) throw Error('fixture'); ledger.charge(d.reservationId, null); ledger.finish(d.reservationId);
    const path = join(root, '.api-budget.json'); writeFileSync(path, JSON.stringify(ledger.snapshot())); const before = hash(readFileSync(path));
    for (let i=0;i<2;i++) { const s = new StateStore(root); expect(s.budget('api')).toEqual(ledger.snapshot()); s.close(); }
    expect(hash(readFileSync(path))).toBe(before); writeFileSync(path, JSON.stringify({ ...ledger.snapshot(), frozenReason: 'external change' }));
    expect(() => new StateStore(root)).toThrow('после миграции');
  });
  it('откатывает состояние и резерв одной транзакцией при сбое записи', () => {
    const root = temp(), store = new StateStore(root), ledger = new SqliteBudgetLedger(store, config.apiBudget, config.timezone);
    expect(() => store.transaction(() => { ledger.reserve('rollback', 'task', { perCallUsd: 0.01, attemptUsd: 0.01 }, new Date()); throw Error('disk failure'); })).toThrow('disk failure');
    expect(store.budget('api')).toBeUndefined(); store.close();
  });
  it.each(['planned','reserved','dispatched','received','completed','failed','in_doubt'] as const)('SIGKILL после %s; безопасное восстановление без дубликатов', async phase => {
    const root = temp(), crashed = await worker(root, phase); expect(crashed.code).toBeNull(); expect(readFileSync(join(root,'crashed.txt'),'utf8')).toBe(phase);
    const { runId, dir } = readJson(join(root, 'worker-info.json')) as { runId: string; dir: string };
    const sentBefore = existsSync(join(root,'requests.jsonl')) ? readJsonl(join(root,'requests.jsonl')).length : 0;
    await withProjectLock(root, async store => {
      store.recover(runId); const connection = recoveryConnection(root, phase === 'failed');
      const ledger = new SqliteBudgetLedger(store, { ...config.apiBudget, runUsd: 0.1 }, config.timezone);
      const executor = new CallExecutor(runId, dir, config, connection, await connection.diagnose(), ledger, 'candidate', undefined, { store });
      const restored = await executor.execute(task(), 'pagination-a1', 1, taskPrompt(task()));
      const sentAfter = existsSync(join(root,'requests.jsonl')) ? readJsonl(join(root,'requests.jsonl')).length : 0;
      if (phase === 'dispatched' || phase === 'received' || phase === 'in_doubt') {
        expect(restored.status).toBe('in_doubt'); expect(sentAfter).toBe(sentBefore); expect(ledger.snapshot().runs[runId]!.reservedMicroUsd).toBe(10000);
        expect(executor.calls[0]!.incurredCostUsd).toBeNull(); expect(executor.calls[0]!.usage.total).toBeNull();
        if (phase === 'received') expect(store.intents(runId)[0]!.generationId).toBe('gen-fixture');
      } else {
        expect(restored.status).toBe(phase === 'failed' ? 'technical_error' : 'ok'); expect(sentAfter).toBe(1);
        expect(ledger.snapshot().runs[runId]).toEqual({ spentMicroUsd: 10, reservedMicroUsd: 0 });
        expect(readJsonl(join(dir,'calls.jsonl'))).toHaveLength(1);
        const before = filesUnder(dir).map(p => hash(readFileSync(join(dir,p))));
        const second = await executor.execute(task(), 'pagination-a1', 1, taskPrompt(task())); expect(second.status).toBe(restored.status);
        expect(filesUnder(dir).map(p => hash(readFileSync(join(dir,p))))).toEqual(before); expect(readJsonl(join(root,'requests.jsonl'))).toHaveLength(1);
      }
    });
  });
  it('авария финализации восстанавливает тот же запуск/ответ/отчёт без генерации', async () => {
    const root = temp(), crashed = await worker(root,'finalizing'); expect(crashed.code, crashed.stderr).toBeNull();
    const id = readdirSync(root).find(p => p.includes('-pilot-'))!;
    const calls = readFileSync(join(root,id,'calls.jsonl')), requests = readFileSync(join(root,'requests.jsonl'));
    const result = await runPilot(config, { resultsDir: root, budgetUsd: 0.1, resumeId: id, connection: recoveryConnection(root) });
    expect(result.run.manifest.runId).toBe(id); expect(result.run.attempts[0]!.status).toBe('passed');
    expect(readFileSync(join(root,id,'calls.jsonl'))).toEqual(calls); expect(readFileSync(join(root,'requests.jsonl'))).toEqual(requests);
    const checksum = hash(readFileSync(join(root,id,'integrity.json')));
    await runPilot(config,{resultsDir:root,budgetUsd:0.1,resumeId:id,connection:recoveryConnection(root)}); expect(hash(readFileSync(join(root,id,'integrity.json')))).toBe(checksum);
  });
  it('восстанавливает оборванные response/JSONL из SQLite, сохраняя повреждённые байты для аудита', async () => {
    const root=temp(),crashed=await worker(root,'completed');expect(crashed.code).toBeNull();
    const {runId,dir}=readJson(join(root,'worker-info.json')) as {runId:string;dir:string};
    const db=new StateStore(root),record=db.intents(runId)[0]!.record!;db.close();
    writeFileSync(join(dir,record.artifacts[0]!),'{"items":');writeFileSync(join(dir,'calls.jsonl'),'{"runId":');
    await withProjectLock(root,async store=>{
      const connection=recoveryConnection(root),ledger=new SqliteBudgetLedger(store,{...config.apiBudget,runUsd:0.1},config.timezone);
      const executor=new CallExecutor(runId,dir,config,connection,await connection.diagnose(),ledger,'candidate',undefined,{store});
      expect((await executor.execute(task(),'pagination-a1',1,taskPrompt(task()))).status).toBe('ok');
      expect(readJsonl(join(dir,'calls.jsonl'))).toHaveLength(1);
      const preserved=filesUnder(dir).filter(p=>p.includes('.interrupted-'));expect(preserved).toHaveLength(2);
      expect(preserved.map(p=>readFileSync(join(dir,p),'utf8'))).toEqual(expect.arrayContaining(['{"items":','{"runId":']));
      expect(readJsonl(join(root,'requests.jsonl'))).toHaveLength(1);
    });
  });
  it('после аварии reserved новый более дорогой тариф блокируется до транспорта', async () => {
    const root=temp();await worker(root,'reserved');const {runId,dir}=readJson(join(root,'worker-info.json')) as {runId:string;dir:string};
    await withProjectLock(root,async store=>{
      const connection=recoveryConnection(root);connection.upperBound=()=>({perCallUsd:0.02,attemptUsd:0.02});
      const ledger=new SqliteBudgetLedger(store,{...config.apiBudget,runUsd:0.1},config.timezone);
      const executor=new CallExecutor(runId,dir,config,connection,await connection.diagnose(),ledger,'candidate',undefined,{store});
      expect((await executor.execute(task(),'pagination-a1',1,taskPrompt(task())))).toMatchObject({status:'budget_exhausted',callIds:[]});
      expect(existsSync(join(root,'requests.jsonl'))).toBe(false);expect(store.intents(runId)[0]!.state).toBe('failed');
      expect(ledger.snapshot().runs[runId]).toEqual({spentMicroUsd:0,reservedMicroUsd:0});
    });
  });
});
