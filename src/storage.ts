import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { SavedRun } from './types.js';
import type { StateStore } from './state.js';

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
// Публикация целого файла атомарна; link не заменяет уже существующий артефакт.
export function immutableWrite(path: string, content: string | Buffer): void {
  const next = `${path}.${randomUUID()}.tmp`, fd = openSync(next, 'wx');
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(next, path); } finally { unlinkSync(next); }
}
export function writeJson(path: string, value: unknown): void { immutableWrite(path, JSON.stringify(value, null, 2) + '\n'); }
export function writeOnce(path: string, content: string): void {
  if (existsSync(path)) { if (readFileSync(path, 'utf8') !== content) throw new Error(`Сохранённый артефакт отличается: ${path}`); return; }
  immutableWrite(path, content);
}
export function writeJsonOnce(path: string, value: unknown): void { writeOnce(path, JSON.stringify(value, null, 2) + '\n'); }
export function appendJsonl(path: string, value: unknown): void {
  const fd = openSync(path, 'a');
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}
export function atomicJson(path: string, value: unknown): void {
  const next = `${path}.${randomUUID()}.tmp`;
  writeJson(next, value);
  renameSync(next, path);
}
export function createRunDir(root: string, scenario: string): { runId: string; dir: string } {
  mkdirSync(root, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const dir = join(root, runId);
  mkdirSync(dir);
  for (const name of ['responses', 'checks', 'screenshots', 'prompts']) mkdirSync(join(dir, name));
  writeFileSync(join(dir, 'calls.jsonl'), '', { flag: 'wx' });
  return { runId, dir };
}
export function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? filesUnder(join(root, entry.name)).map((name) => `${entry.name}/${name}`)
    : entry.isFile() ? [entry.name] : []).sort();
}
export function finalizeIntegrity(dir: string): void {
  writeJson(join(dir, 'integrity.json'), Object.fromEntries(filesUnder(dir).map((name) => [name, hash(readFileSync(join(dir, name)))])));
}
export function loadRun(root: string, runId: string): SavedRun {
  if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(runId)) throw new Error('Неверный ID запуска');
  const dir = join(root, runId);
  verifyIntegrity(dir, ['manifest.json', 'calls.jsonl', 'attempts.jsonl']);
  const manifest = readJson(join(dir, 'manifest.json')) as SavedRun['manifest'];
  if (![1, 2].includes(manifest.schemaVersion) || manifest.runId !== runId || !['mock', 'openrouter', 'codex-cli', 'claude-code', 'gemini-cli', 'manual'].includes(manifest.mode)) throw new Error('Неподдерживаемый manifest');
  return { manifest, calls: readJsonl(join(dir, 'calls.jsonl')), attempts: readJsonl(join(dir, 'attempts.jsonl')) };
}
export function verifyIntegrity(dir: string, required: string[] = []): void {
  const checksums = readJson(join(dir, 'integrity.json')) as Record<string, string>;
  for (const [name, expected] of Object.entries(checksums)) {
    const target = resolve(dir, name);
    const pathFromRoot = relative(resolve(dir), target);
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('Небезопасный путь артефакта');
    if (hash(readFileSync(target)) !== expected) throw new Error(`Артефакт изменён: ${name}`);
  }
  for (const name of required) {
    if (!checksums[name]) throw new Error(`Нет хеша обязательного артефакта: ${name}`);
  }
}

export async function withProjectLock<T>(root: string, action: (store: StateStore) => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true });
  const path = join(root, '.bench.lock');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
  if (existsSync(path)) {
    const old = readJson(path) as { pid?: number };
    if (!Number.isSafeInteger(old.pid) || alive(old.pid!)) throw new Error('Каталог results занят (.bench.lock)');
    // Старый маркер сохраняется; снятие только после проверки отсутствующего PID.
    renameSync(path, `${path}.stale-${randomUUID()}`);
  }
  const { StateStore } = await import('./state.js'); const store = new StateStore(root), token = randomUUID();
  try {
    store.transaction(() => {
      const lease = store.db.prepare('SELECT pid FROM leases WHERE name=?').get('project') as { pid: number } | undefined;
      if (lease && alive(lease.pid)) throw new Error('Каталог results занят (.bench.lock / SQLite lease)');
      store.db.prepare('INSERT INTO leases VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET pid=excluded.pid,token=excluded.token').run('project', process.pid, token);
    });
    try { return await action(store); }
    finally { store.transaction(() => { store.db.prepare('DELETE FROM leases WHERE name=? AND token=?').run('project', token); }); }
  } finally { store.close(); }
}
