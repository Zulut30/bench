import { z } from 'zod';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Task } from './schema.js';
import type { RunConfig } from './connections/config.js';
import { executeProcess, executablePath } from './connections/process.js';
import { projectRoot } from './runner.js';
import { hash, writeJson } from './storage.js';
import type { CheckResult } from './types.js';

const filesSchema = z.strictObject({ files: z.array(z.strictObject({ path: z.string(), content: z.string() })).min(1).max(12) });
export function candidateFiles(output: string, allowedFiles: string[]) {
  if (Buffer.byteLength(output) > 600_000) throw new Error('Ответ с файлами превышает 600 KB');
  const envelope = filesSchema.parse(JSON.parse(output));
  const seen = new Set<string>(); let size = 0;
  for (const file of envelope.files) {
    if (!allowedFiles.includes(file.path) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.path) || file.path.includes('..') || seen.has(file.path)) throw new Error(`Недопустимый/повторный путь: ${file.path}`);
    const bytes = Buffer.byteLength(file.content); size += bytes;
    if (bytes > 256_000 || size > 512_000 || file.content.includes('\0')) throw new Error('Недопустимый размер/содержимое файла');
    seen.add(file.path);
  }
  if (allowedFiles.some((path) => !seen.has(path))) throw new Error('Отсутствует обязательный файл');
  return envelope.files;
}
function dockerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_CONFIG', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
}
function contextArgs(settings: RunConfig['sandbox']): string[] { return settings.dockerContext ? ['--context', settings.dockerContext] : []; }
export async function diagnoseSandbox(settings: RunConfig['sandbox']) {
  const executable = executablePath('docker');
  if (!executable) return { status: 'isolation_unavailable' as const, reason: 'Нет Docker CLI; контейнерная проверка заблокирована', imageId: null };
  const probe = await executeProcess(executable, [...contextArgs(settings), 'image', 'inspect', settings.image, '--format', '{{.Id}}'], { cwd: projectRoot, env: dockerEnv(), timeoutMs: 10000 });
  const id = probe.stdout.trim();
  return probe.status === 'ok' && probe.code === 0 && /^sha256:[a-f0-9]{64}$/.test(id)
    ? { status: 'ok' as const, reason: 'Docker и заранее собранный образ доступны; запуск без pull', imageId: id }
    : { status: 'isolation_unavailable' as const, reason: 'Нет Docker daemon или фиксированного образа. npm run sandbox:build', imageId: null };
}
const sandboxResponse = z.strictObject({ results: z.array(z.strictObject({ id: z.string(), pass: z.boolean(), score: z.number().min(0).max(1), reason: z.string() })),
  logs: z.array(z.unknown()), screenshots: z.array(z.strictObject({ width: z.union([z.literal(1440), z.literal(390)]), data: z.string().max(5_000_000) })).max(2), environment: z.record(z.string(), z.unknown()) });
export async function executeSandbox(kind: string, files: Array<{ path: string; content: string }>, settings: RunConfig['sandbox'], timeoutMs: number, signal?: AbortSignal) {
  const diagnostic = await diagnoseSandbox(settings); if (diagnostic.status !== 'ok') throw new Error(diagnostic.reason);
  const executable = executablePath('docker')!, name = `bench-check-${randomUUID()}`;
  const args = [...contextArgs(settings), 'run', '--rm', '-i', '--name', name, '--pull', 'never', '--network', 'none', '--read-only',
    '--cpus', '1', '--memory', '768m', '--memory-swap', '768m', '--pids-limit', '128', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'KILL',
    '--security-opt', 'no-new-privileges:true', '--ipc', 'private', '--tmpfs', '/candidate:rw,nosuid,nodev,size=32m,mode=0700', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=8388608:8388608', diagnostic.imageId!];
  try {
    const result = await executeProcess(executable, args, { cwd: projectRoot, env: dockerEnv(), input: JSON.stringify({ kind, files, timeoutMs }), timeoutMs, ...(signal ? { signal } : {}) });
    if (result.status !== 'ok' || result.code !== 0) throw new Error(`Контейнер: ${result.status}, exit ${result.code}, ${result.stderr.slice(0, 2000)}`);
    return { ...sandboxResponse.parse(JSON.parse(result.stdout)), imageId: diagnostic.imageId };
  } finally {
    // Уничтожается только контейнер с UUID этой проверки, включая дочерние процессы после timeout/Ctrl+C.
    await executeProcess(executable, [...contextArgs(settings), 'rm', '-f', name], { cwd: projectRoot, env: dockerEnv(), timeoutMs: 5000 });
  }
}
export async function evaluateCode(task: Task, output: string, dir: string, attemptId: string, settings: RunConfig['sandbox'], signal?: AbortSignal): Promise<CheckResult[]> {
  if (!task.execution) throw new Error('Нет контракта исполнения');
  const base = task.checks.filter(c => c.evaluator === 'practical-code');
  let files;
  try { files = candidateFiles(output, task.execution.allowedFiles); }
  catch (error) { return base.map(c => ({ ...c, pass: false, score: 0, reason: `Неверный контракт файлов: ${String(error)}`, evidence: [] })); }
  const result = await executeSandbox(task.execution.kind, files, settings, task.execution.timeoutMs, signal);
  const log = `checks/${attemptId}-container.json`; writeJson(join(dir, log), { ...result, screenshots: result.screenshots.map(s => ({ width: s.width, sha256: hash(Buffer.from(s.data, 'base64')) })) });
  const evidence = [log];
  for (const screenshot of result.screenshots) {
    const png = Buffer.from(screenshot.data, 'base64'); if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Контейнер вернул неверный PNG');
    const path = `screenshots/${attemptId}-${screenshot.width}.png`; writeFileSync(join(dir, path), png, { flag: 'wx' }); evidence.push(path);
  }
  const passed = result.results.length > 0 && result.results.every(r => r.pass);
  return base.map(c => ({ id: c.id, category: c.category, critical: c.critical, weight: c.weight, pass: passed,
    score: result.results.length ? result.results.reduce((s, r) => s + r.score, 0) / result.results.length : 0,
    reason: result.results.map(r => `${r.id}: ${r.pass ? 'passed' : 'failed'} — ${r.reason}`).join('; '), evidence }));
}
