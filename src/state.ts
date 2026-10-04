import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetLedger, budgetStateSchema } from './budget.js';
import type { BudgetAccess, BudgetDecision, BudgetLimits, BudgetState } from './budget.js';
import { hash } from './storage.js';
import type { CallRecord } from './types.js';
import type { ConnectionResult } from './connections/types.js';

export const callStates = ['planned', 'reserved', 'dispatched', 'completed', 'failed', 'in_doubt'] as const;
export type CallState = typeof callStates[number];
export interface CallIntent {
  id: string; runId: string; taskId: string; attemptId: string; role: 'candidate' | 'judge'; retryIndex: number;
  state: CallState; reservationId: string | null; generationId: string | null; promptHash: string;
  result: ConnectionResult | null; record: CallRecord | null; reason: string; updatedAt: string;
}
const transitions: Record<CallState, CallState[]> = {
  planned: ['reserved', 'failed'], reserved: ['dispatched', 'failed'], dispatched: ['completed', 'failed', 'in_doubt'],
  completed: [], failed: [], in_doubt: [],
};
interface Row { json: string }
export class StateStore {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, '.bench.sqlite'), { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS budgets (namespace TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, role TEXT NOT NULL,
        retry_index INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(run_id,attempt_id,role,retry_index));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT, state TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessments (run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id,attempt_id));
      CREATE TABLE IF NOT EXISTS finalizations (run_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliations (call_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);`);
    try { this.migrateJournal('api', '.api-budget.json'); }
    catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T {
    if (this.depth) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  private migrateJournal(namespace: BudgetState['namespace'], name: string) {
    const path = join(this.root, name); if (!existsSync(path)) return;
    const bytes = readFileSync(path), checksum = hash(bytes), initial = budgetStateSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (initial.namespace !== namespace) throw new Error('Неверный namespace старого журнала');
    this.transaction(() => {
      const migrated = this.db.prepare('SELECT hash FROM migrations WHERE path=?').get(name) as { hash: string } | undefined;
      if (migrated) {
        if (migrated.hash !== checksum) throw new Error('Старый JSON-журнал изменён после миграции; остановлен запуск для сверки');
        return;
      }
      if (this.db.prepare('SELECT namespace FROM budgets WHERE namespace=?').get(namespace)) throw new Error('Есть SQLite и не перенесённый JSON-журнал; требуется сверка');
      this.db.prepare('INSERT INTO budgets VALUES (?,?)').run(namespace, JSON.stringify(initial));
      this.db.prepare('INSERT INTO migrations VALUES (?,?)').run(name, checksum);
    });
  }
  budget(namespace: BudgetState['namespace']): BudgetState | undefined {
    const row = this.db.prepare('SELECT json FROM budgets WHERE namespace=?').get(namespace) as Row | undefined;
    return row ? budgetStateSchema.parse(JSON.parse(row.json)) : undefined;
  }
  saveBudget(state: BudgetState) { this.db.prepare('INSERT INTO budgets VALUES (?,?) ON CONFLICT(namespace) DO UPDATE SET json=excluded.json').run(state.namespace, JSON.stringify(state)); }
  createRun(id: string, plan: unknown) { this.db.prepare('INSERT INTO runs VALUES (?,?,?)').run(id, JSON.stringify(plan), 'running'); }
  run<T>(id: string): { plan: T; status: string } {
    const row = this.db.prepare('SELECT plan,status FROM runs WHERE id=?').get(id) as { plan: string; status: string } | undefined;
    if (!row) throw new Error('Нет восстанавливаемого плана в SQLite');
    return { plan: JSON.parse(row.plan) as T, status: row.status };
  }
  finishRun(id: string, status: string) { this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, id); }
  assessment<T>(runId: string, attemptId: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM assessments WHERE run_id=? AND attempt_id=?').get(runId, attemptId) as Row | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  saveAssessment(runId: string, attemptId: string, result: unknown) { this.db.prepare('INSERT INTO assessments VALUES (?,?,?)').run(runId, attemptId, JSON.stringify(result)); }
  finalization<T>(runId: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM finalizations WHERE run_id=?').get(runId) as Row | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  saveFinalization(runId: string, value: unknown) { this.db.prepare('INSERT INTO finalizations VALUES (?,?)').run(runId, JSON.stringify(value)); }
  intents(runId: string): CallIntent[] {
    return (this.db.prepare('SELECT json FROM calls WHERE run_id=? ORDER BY rowid').all(runId) as unknown as Row[]).map((r) => JSON.parse(r.json) as CallIntent);
  }
  intent(runId: string, attemptId: string, role: string, retryIndex: number): CallIntent | undefined {
    const row = this.db.prepare('SELECT json FROM calls WHERE run_id=? AND attempt_id=? AND role=? AND retry_index=?').get(runId, attemptId, role, retryIndex) as Row | undefined;
    return row ? JSON.parse(row.json) as CallIntent : undefined;
  }
  plan(intent: CallIntent) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?)').run(intent.id, intent.runId, intent.attemptId, intent.role, intent.retryIndex, JSON.stringify(intent));
      this.event(intent, 'Запланирован; транспорт ещё не вызван');
    });
  }
  transition(intent: CallIntent, next: CallState, patch: Partial<CallIntent> = {}) {
    this.transaction(() => {
      const current = this.intent(intent.runId, intent.attemptId, intent.role, intent.retryIndex);
      if (!current || !transitions[current.state].includes(next)) throw new Error(`Недопустимый переход ${current?.state} → ${next}`);
      const updated = { ...current, ...patch, state: next, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE calls SET json=? WHERE id=?').run(JSON.stringify(updated), intent.id); Object.assign(intent, updated);
      this.event(updated, updated.reason);
    });
  }
  generation(intent: CallIntent, id: string) {
    this.transaction(() => {
      const current = this.intent(intent.runId, intent.attemptId, intent.role, intent.retryIndex)!;
      if (current.state !== 'dispatched') throw new Error('Generation ID вне dispatched');
      current.generationId = id; this.db.prepare('UPDATE calls SET json=? WHERE id=?').run(JSON.stringify(current), intent.id);
    });
  }
  recover(runId: string) {
    this.transaction(() => {
      for (const intent of this.intents(runId)) if (intent.state === 'dispatched') this.transition(intent, 'in_doubt', { reason: 'Процесс прерван после dispatched; автоматическая повторная отправка запрещена' });
    });
  }
  private event(intent: CallIntent, detail: string) {
    this.db.prepare('INSERT INTO events(run_id,call_id,state,at,detail) VALUES (?,?,?,?,?)').run(intent.runId, intent.id, intent.state, new Date().toISOString(), detail);
  }
  events(runId: string) { return this.db.prepare('SELECT sequence,call_id AS callId,state,at,detail FROM events WHERE run_id=? ORDER BY sequence').all(runId); }
  reconciliation<T>(callId: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM reconciliations WHERE call_id=?').get(callId) as Row | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  saveReconciliation(callId: string, value: unknown) { this.db.prepare('INSERT INTO reconciliations VALUES (?,?)').run(callId, JSON.stringify(value)); }
  uncertainRecord(intent: CallIntent, record: CallRecord, result: ConnectionResult) {
    this.transaction(() => {
      if (intent.state !== 'in_doubt' || intent.record) throw new Error('Нельзя заменить сохранённую запись вызова');
      Object.assign(intent, { record, result }); this.db.prepare('UPDATE calls SET json=? WHERE id=?').run(JSON.stringify(intent), intent.id);
    });
  }
}

export class SqliteBudgetLedger implements BudgetAccess {
  constructor(readonly store: StateStore, private readonly limits: BudgetLimits, readonly timezone: string, readonly namespace: BudgetState['namespace'] = 'api') {}
  private apply<T>(action: (ledger: BudgetLedger) => T): T {
    return this.store.transaction(() => {
      const ledger = new BudgetLedger(this.limits, this.timezone, this.store.budget(this.namespace), undefined, this.namespace);
      const result = action(ledger); this.store.saveBudget(ledger.snapshot()); return result;
    });
  }
  reserve(runId: string, taskId: string, upper: { perCallUsd: number; attemptUsd: number } | null, now: Date): BudgetDecision { return this.apply((ledger) => ledger.reserve(runId, taskId, upper, now)); }
  validateReservation(id: string, upper: { perCallUsd: number; attemptUsd: number } | null, now?: Date): BudgetDecision { return this.apply(ledger => ledger.validateReservation(id, upper, now)); }
  charge(id: string, cost: number | null) { this.apply((ledger) => ledger.charge(id, cost)); }
  finish(id: string) { this.apply((ledger) => ledger.finish(id)); }
  freeze(reason: string) { this.apply((ledger) => ledger.freeze(reason)); }
  reconcile(id: string, cost: number) { this.apply((ledger) => ledger.reconcile(id, cost)); }
  snapshot() { return this.apply((ledger) => ledger.snapshot()); }
}
export function readBudget(root: string): BudgetState | undefined {
  const path = join(root, '.bench.sqlite');
  if (!existsSync(path)) return existsSync(join(root, '.api-budget.json')) ? budgetStateSchema.parse(JSON.parse(readFileSync(join(root, '.api-budget.json'), 'utf8'))) : undefined;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try { const row = db.prepare('SELECT json FROM budgets WHERE namespace=?').get('api') as Row | undefined; return row ? budgetStateSchema.parse(JSON.parse(row.json)) : undefined; }
  finally { db.close(); }
}
