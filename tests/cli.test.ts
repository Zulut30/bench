import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, connectionSchema } from '../src/connections/config.js';
import { executeProcess } from '../src/connections/process.js';
import { projectRoot } from '../src/runner.js';
import { loadRun, readJsonl } from '../src/storage.js';
import { fakeCli } from './fake-cli.js';
const roots: string[]=[];
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'bench-cli-test-'));roots.push(d);return d;};
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
const env=()=>({ PATH:process.env.PATH??'', HOME:process.env.HOME??'', LANG:'C.UTF-8', DOCKER_CONTEXT:process.env.DOCKER_CONTEXT??'',
  PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??chromium.executablePath().replace(/[\\/](?:chromium|chromium_headless_shell)-\d+[\\/].*$/,''), NODE_NO_WARNINGS:'1' });
const command=(args:string[])=>executeProcess(process.execPath,['--import','tsx',join(projectRoot,'src/cli.ts'),...args],{cwd:projectRoot,env:env(),timeoutMs:60000});
function fixture(dir:string, scenario:string) {
  const fake=fakeCli(dir,'codex-cli',scenario,join(projectRoot,'package.json'));
  const config=loadConfig(join(projectRoot,'configs/pilot-codex-cli.json'));config.taskIds=['pagination'];config.limits.maxRetries=0;
  if(scenario==='timeout')config.limits.timeoutMs=300;
  config.candidate=connectionSchema.parse({provider:'codex-cli',model:'pinned-v1',executable:fake.executable,clientHome:fake.clientHome});
  const path=join(dir,'local-config.json');writeFileSync(path,JSON.stringify(config));return{...fake,path};
}
describe('CLI: коды, JSON события, Ctrl+C и resume',()=>{
  it.each([['quota',5],['timeout',6],['bad-json',3]] as const)('%s завершает нужным кодом без повторной генерации',async(scenario,code)=>{
    const dir=temp(),fake=fixture(dir,scenario),root=join(dir,'results');
    const result=await command(['run','--provider','codex-cli','--config',fake.path,'--results-dir',root]);
    expect(result.code,result.stderr).toBe(code);expect(readJsonl(fake.record)).toHaveLength(1);
    expect(result.stderr.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l)).some(e=>e.event==='call_state'&&e.state==='dispatched')).toBe(true);
  });
  it('ошибка аргументов → 2; явный mock dry-run/diagnose → 0 и без генераций',async()=>{
    expect((await command(['run'])).code).toBe(2);
    expect((await command(['diagnose','--provider','mock'])).code).toBe(0);
    const dir=temp(),result=await command(['dry-run','--provider','mock','--profile','standard','--results-dir',join(dir,'results')]);
    expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({noGenerations:true,journalModified:false});
    expect(existsSync(join(dir,'results'))).toBe(false);
  });
  it('SIGINT сохраняет состояние, exit 130; resume/экспорт частичного запуска не посылают запрос снова',async()=>{
    const dir=temp(),fake=fixture(dir,'timeout'),root=join(dir,'results');
    const config=loadConfig(fake.path);config.limits.timeoutMs=60000;writeFileSync(fake.path,JSON.stringify(config));
    const child=spawn(process.execPath,['--import','tsx',join(projectRoot,'src/cli.ts'),'run','--provider','codex-cli','--config',fake.path,'--results-dir',root],{cwd:projectRoot,env:env(),stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr+=s;}); child.stdout.resume();
    const closed=new Promise<number|null>(done=>child.once('close',done));
    try{
      const deadline=Date.now()+15000;
      while(!existsSync(fake.record)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
      expect(existsSync(fake.record),stderr).toBe(true);child.kill('SIGINT');expect(await closed,stderr).toBe(130);
      expect(stderr).toContain('"event":"interrupted"');const id=readdirSync(root).find(p=>p.includes('-pilot-'))!;
      expect(existsSync(join(root,id,'manifest.json'))).toBe(false);
      const exported=await command(['export','--run',id,'--results-dir',root,'--output',join(dir,'partial-export')]);expect(exported.code,exported.stderr).toBe(0);
      expect(existsSync(join(dir,'partial-export',id,'recovery-state.json'))).toBe(true);
      const resumed=await command(['resume','--run',id,'--results-dir',root]);expect(resumed.code,resumed.stderr).toBe(6);
      expect(readJsonl(fake.record)).toHaveLength(1);expect(loadRun(root,id).calls).toHaveLength(1);
      expect(readFileSync(join(root,id,'events.jsonl'),'utf8')).toContain('dispatched');
    }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGINT');await closed;}}
  });
});
