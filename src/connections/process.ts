import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ConnectionStatus } from './types.js';

export function executablePath(name: string, excludedRoots: string[] = []): string | null {
  for (const path of name.includes('/') ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).map((p) => join(p, name))) {
    try {
      accessSync(path, constants.X_OK); const target = realpathSync(path);
      if (excludedRoots.some((root) => { const part = relative(realpathSync(root), target); return part === '' || !part.startsWith('../') && part !== '..' && !part.startsWith('/'); })) continue;
      return target;
    } catch { /* Следующий PATH. */ }
  }
  return null;
}
export function clientEnvironment(home: string): NodeJS.ProcessEnv {
  // Клиент сам использует сохранённый подписочный вход. API/OAuth ключи из процесса не передаются.
  return { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap((k) => process.env[k] ? [[k, process.env[k]]] : [])), HOME: home };
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|oauth[-_]?token|credentials|password|secret)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  let text = value.replace(/\bsk-[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]');
  for (const [key, secret] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && secret && secret.length >= 8) text = text.replaceAll(secret, '[REDACTED]');
  return text;
}
export function errorStatus(text: string): ConnectionStatus {
  if (/quota|usage limit|rate.limit|limit reached|hit.*limit|out of.*credits|insufficient.*credit|exhausted|RESOURCE_EXHAUSTED/i.test(text)) return 'quota_exhausted';
  if (/not logged|unauthori[sz]ed|authentication|auth.*required|invalid.*key|login|sign.?in|401|403/i.test(text)) return 'auth_missing';
  if (/model.*(?:not found|unavailable|not available|does not exist)|unknown model|404/i.test(text)) return 'model_unavailable';
  return 'technical_error';
}
export interface ProcessResult { stdout: string; stderr: string; code: number | null; status: ConnectionStatus; }
export async function executeProcess(executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal;
  onLine?: (line: string) => ConnectionStatus | null;
}): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', pending = '', status: ConnectionStatus = 'ok', settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (next: ConnectionStatus) => {
      if (status !== 'ok') return;
      status = next;
      const stop = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Уже остановлен. */ } };
      stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 300);
    };
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    const abort = () => kill('timeout');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (buffer: Buffer) => {
      const data = buffer.toString('utf8'); stdout += data; pending += data;
      if (Buffer.byteLength(stdout) > 8_000_000) { stdout = stdout.slice(0, 8_000_000); kill('limit_exceeded'); }
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) if (line && options.onLine) {
        try { const next = options.onLine(line); if (next) kill(next); } catch { kill('invalid_response'); }
      }
    });
    child.stderr.on('data', (buffer: Buffer) => { stderr += buffer.toString('utf8'); if (stderr.length > 1_000_000) { stderr = stderr.slice(0, 1_000_000); kill('limit_exceeded'); } });
    child.stdin.on('error', () => { /* Клиент может завершиться до чтения stdin. */ });
    const finish = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolveResult({ stdout, stderr, code, status });
    };
    child.on('error', (error) => { stderr = error.message; status = 'client_missing'; finish(null); });
    child.on('close', finish);
    child.stdin.end(options.input ?? '');
  });
}

export function isolatedCommand(executable: string, args: string[], workspace: string, protectedPaths: string[], clientPaths: string[] = []): { executable: string; args: string[] } | null {
  const protectedRoots = [...new Set(protectedPaths.map((p) => realpathSync(p)))];
  const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || !part.startsWith('../') && part !== '..' && !part.startsWith('/'); };
  if (protectedRoots.some((p) => inside(p, realpathSync(executable)))) return null;
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const deny = protectedRoots.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
    // Отдельный корень — недостаточная изоляция для агента с файловыми инструментами.
    const profile = `(version 1)(allow default)(deny file-read* file-write* ${deny})`;
    const path = join(workspace, '.bench-isolation.sb'); writeFileSync(path, profile, { flag: 'wx' });
    return { executable: '/usr/bin/sandbox-exec', args: ['-f', path, executable, ...args] };
  }
  const bwrap = process.platform === 'linux' ? executablePath('bwrap') : null;
  if (!bwrap) return null;
  const binds: string[] = ['--die-with-parent', '--unshare-pid', '--new-session', '--proc', '/proc', '--dev-bind', '/dev', '/dev', '--tmpfs', '/tmp'];
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/etc']) if (existsSync(path)) binds.push('--ro-bind', path, path);
  if (!['/usr/', '/bin/', '/opt/'].some((p) => executable.startsWith(p))) binds.push('--ro-bind', dirname(executable), dirname(executable));
  binds.push('--bind', workspace, workspace);
  const trustedPaths = [...clientPaths, ...['.codex', '.claude', '.claude.json', '.gemini'].map((name) => join(homedir(), name))];
  for (const path of [...new Set(trustedPaths)].filter(existsSync)) {
    if (protectedRoots.some((p) => inside(p, realpathSync(path)))) return null;
    binds.push('--bind', path, path);
  }
  // Закрываем защищённые папки и внутри системного bind/client home, если они там есть.
  for (const path of protectedRoots) binds.push('--tmpfs', path);
  return { executable: bwrap, args: [...binds, '--chdir', workspace, '--', executable, ...args] };
}
