import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/connections/config.js';
import { candidateFiles, diagnoseSandbox, executeSandbox } from '../src/sandbox.js';
import { projectRoot } from '../src/runner.js';
import { join } from 'node:path';
const settings = loadConfig(join(projectRoot, 'configs/pilot-mock.json')).sandbox;
afterEach(() => vi.unstubAllEnvs());
describe('Контейнер: недоверенный код отделён от генерации и скрытых проверок', () => {
  it('блокирует traversal, абсолютные/дублированные пути, лишние/отсутствующие файлы и большие ответы', () => {
    const output = (path: string, content = '') => JSON.stringify({ files: [{ path, content }] });
    for (const path of ['../checker.mjs', '/opt/checker/checker.mjs', 'sub/solution.ts', 'x..ts']) expect(() => candidateFiles(output(path), [path])).toThrow();
    expect(() => candidateFiles(output('extra.ts'), ['solution.ts'])).toThrow();
    expect(() => candidateFiles(output('solution.ts', 'x'.repeat(256001)), ['solution.ts'])).toThrow('размер');
    expect(() => candidateFiles(output('solution.ts', '\0'), ['solution.ts'])).toThrow();
    expect(() => candidateFiles(JSON.stringify({ files: [{ path: 'solution.ts', content: '' }, { path: 'solution.ts', content: '' }] }), ['solution.ts'])).toThrow('путь');
    expect(() => candidateFiles('x'.repeat(600001), ['solution.ts'])).toThrow('600 KB');
    expect(candidateFiles(output('solution.ts', 'export {};'), ['solution.ts'])).toHaveLength(1);
  });
  it('процесс не видит ключей, auth/project/hidden checks, не может менять checker/deps и выйти в сеть', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'isolation-secret-fixture');
    const content = `import { readFileSync, writeFileSync } from 'node:fs';
export async function probe() {
  const readable=(p:string)=>{try{readFileSync(p);return true}catch{return false}};
  const writable=(p:string)=>{try{writeFileSync(p,'tamper');return true}catch{return false}};
  let network=false;try{await fetch('https://example.com',{signal:AbortSignal.timeout(500)});network=true}catch{}
  return {uid:process.getuid!(),env:process.env,project:readable(${JSON.stringify(join(projectRoot, 'package.json'))}),
    auth:readable('/Users/zulut/.codex/auth.json'),checks:readable('/opt/checker/checker.mjs'),checkerWritable:writable('/opt/checker/checker.mjs'),
    depsWritable:writable('/opt/deps/execute.mjs'),network,caps:readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\w+)/m)?.[1],
    cpu:readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),memory:readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()};
}`;
    const result = await executeSandbox('probe', [{ path: 'solution.ts', content }], settings, 20000);
    expect(result.results.every(r => r.pass)).toBe(true);
    const out = (result.logs.find(l => typeof l === 'object' && l && 'probe' in l) as { probe: Record<string, unknown> }).probe;
    expect(out).toMatchObject({ uid: 10001, project: false, auth: false, checks: false, checkerWritable: false, depsWritable: false, network: false,
      caps: '0000000000000000', cpu: '100000 100000', memory: '805306368', pids: '128' });
    expect(JSON.stringify(out)).not.toContain('isolation-secret-fixture'); expect(out.env).toMatchObject({ HOME: '/candidate/work', PORT: '3000' });
    expect(Object.keys(out.env as object).some(k => /API_KEY|TOKEN|SECRET|DOCKER/.test(k))).toBe(false);
  });
  it('останавливает зависший код и сохраняет работоспособность контейнерных проверок', async () => {
    await expect(executeSandbox('probe', [{ path: 'solution.ts', content: 'export async function probe(){for(;;){}}' }], settings, 800)).rejects.toThrow(/timeout|124|Контейнер/);
    expect(await diagnoseSandbox(settings)).toMatchObject({ status: 'ok' });
    const result = await executeSandbox('probe', [{ path: 'solution.ts', content: 'export function probe(){ console.log("x".repeat(1100000)); return true; }' }], settings, 20000);
    expect(result.results.every(r => r.pass)).toBe(false); expect(JSON.stringify(result).length).toBeLessThan(100000);
  });
});
