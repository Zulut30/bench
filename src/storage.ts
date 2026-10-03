import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { SavedRun } from './types.js';

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
export function writeJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function appendJsonl(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'a' }); }
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
  const checksums = readJson(join(dir, 'integrity.json')) as Record<string, string>;
  for (const [name, expected] of Object.entries(checksums)) {
    const target = resolve(dir, name);
    const pathFromRoot = relative(resolve(dir), target);
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('Небезопасный путь артефакта');
    if (hash(readFileSync(target)) !== expected) throw new Error(`Артефакт изменён: ${name}`);
  }
  for (const name of ['manifest.json', 'calls.jsonl', 'attempts.jsonl']) {
    if (!checksums[name]) throw new Error(`Нет хеша обязательного артефакта: ${name}`);
  }
  const manifest = readJson(join(dir, 'manifest.json')) as SavedRun['manifest'];
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'mock' || manifest.runId !== runId) throw new Error('Неподдерживаемый manifest');
  return { manifest, calls: readJsonl(join(dir, 'calls.jsonl')), attempts: readJsonl(join(dir, 'attempts.jsonl')) };
}

export async function withProjectLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true });
  const path = join(root, '.bench.lock');
  if (existsSync(path)) throw new Error('Каталог results занят (.bench.lock). Дождитесь текущего запуска; после аварии проверьте PID из файла.');
  try { writeJson(path, { pid: process.pid, startedAt: new Date().toISOString() }); }
  catch { throw new Error('Другой процесс уже удерживает .bench.lock'); }
  try { return await action(); } finally { unlinkSync(path); }
}
