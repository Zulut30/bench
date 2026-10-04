import { describe, expect, it } from 'vitest';
import { executeProcess } from '../src/connections/process.js';
import { tmpdir } from 'node:os';

describe('потоковое UTF-8', () => {
  it('сохраняет кириллицу/emoji и JSON при разделении каждого байта stdout и stderr, включая последнюю строку', async () => {
    const expected = JSON.stringify({ output: 'Привет, ёж 🦔' });
    const lines: string[] = [];
    const script = `const a=Buffer.from(${JSON.stringify(expected + '\n' + expected)}), b=Buffer.from('Ошибка: ещё');
      for(let i=0;i<Math.max(a.length,b.length);i++){if(i<a.length)process.stdout.write(a.subarray(i,i+1));if(i<b.length)process.stderr.write(b.subarray(i,i+1));await new Promise(r=>setTimeout(r,2));}`;
    const result = await executeProcess(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(), env: {}, timeoutMs: 5000, onLine: (line) => { lines.push(line); return null; },
    });
    expect(result).toMatchObject({ stdout: expected + '\n' + expected, stderr: 'Ошибка: ещё', status: 'ok', code: 0 });
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ output: 'Привет, ёж 🦔' }, { output: 'Привет, ёж 🦔' }]);
  });
});
