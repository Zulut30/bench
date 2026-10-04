import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '../src/connections/config.js';

export function fakeCli(dir: string, provider: ProviderId, scenario: string, protectedFile: string, answer?: string) {
  const executable = join(dir, `${provider}-${scenario}.cjs`), clientHome = join(dir, `${provider}-${scenario}-home`);
  const record = join(provider === 'gemini-cli' ? join(clientHome, '.gemini') : clientHome, 'requests.jsonl');
  mkdirSync(clientHome);
  if (provider === 'gemini-cli') {
    mkdirSync(join(clientHome, '.gemini'));
    writeFileSync(join(clientHome, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: scenario === 'wrong-auth' ? 'gemini-api-key' : 'oauth-personal' } } }));
    if (scenario !== 'no-auth') writeFileSync(join(clientHome, '.gemini', 'oauth_creds.json'), 'NOT A TOKEN; diagnostic must never read this file');
  }
  const source = `#!/usr/bin/env node
const fs=require('node:fs');
const provider=${JSON.stringify(provider)}, scenario=${JSON.stringify(scenario)}, args=process.argv.slice(2);
const json=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
if(args.includes('--version')) { console.log('fake-cli fixture-1'); process.exit(0); }
if(args.includes('--help')) { console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --output-format --model --safe-mode --restricted --tools --strict-mcp-config --no-session-persistence --setting-sources --effort'); process.exit(0); }
if(args[0]==='login' || args[0]==='auth') {
  if(provider==='codex-cli') console.log(scenario==='no-auth'?'Not logged in':scenario==='wrong-auth'?'Logged in using API key':'Logged in using ChatGPT');
  else json({loggedIn:scenario!=='no-auth',authMethod:scenario==='wrong-auth'?'api_key':'claude.ai',email:'DO-NOT-PERSIST',access_token:'DO-NOT-PERSIST'});
  process.exit(scenario==='no-auth'?1:0);
}
let input=''; process.stdin.on('data',b=>input+=b); process.stdin.on('end',()=>{
 let protectedReadable=true; try { fs.readFileSync(${JSON.stringify(protectedFile)}); } catch { protectedReadable=false; }
 fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({args,input,cwd:process.cwd(),files:fs.readdirSync(process.cwd()),secretEnvNames:Object.keys(process.env).filter(k=>/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN|SECRET/.test(k)),protectedReadable})+'\\n');
 if(scenario==='timeout') { setInterval(()=>{},1000); return; }
 if(scenario==='bad-json') { console.log('{broken'); return; }
 const failed=scenario==='auth-error'||scenario==='quota'||scenario==='model-error';
 const message=scenario==='quota'?'Usage quota exhausted':scenario==='model-error'?'Unknown model, unavailable':'Authentication required';
 const output=${JSON.stringify(answer ?? '{"total":4,"page":2,"pageSize":2,"items":[{"id":2,"amount":20},{"id":3,"amount":30}]}')};
 if(provider==='codex-cli') {
  if(failed) { json({type:'error',message}); process.exitCode=1; return; }
  json({type:'thread.started',thread_id:'new-'+Math.random()}); json({type:'turn.started'});
  json({type:'item.completed',item:{type:'agent_message',text:output,usage:{input_tokens:999999}}});
  json({type:'turn.completed',...(scenario==='no-usage'?{}:{usage:{input_tokens:100,cached_input_tokens:50,output_tokens:20,reasoning_output_tokens:5}})});
 } else if(provider==='claude-code') {
  json({type:'system',subtype:'init',model:'pinned-v1',tools:[]});
  json({type:'assistant',message:{usage:{input_tokens:999999}}});
  json({type:'result',subtype:failed?'error_during_execution':'success',is_error:failed,result:failed?message:output,num_turns:1,session_id:'new-'+Math.random(),total_cost_usd:0.002,
    ...(scenario==='no-usage'?{}:{usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:0,output_tokens:5},modelUsage:{'pinned-v1':{inputTokens:30,outputTokens:5}}})});
 } else {
  if(failed) { json({error:{message,code:scenario==='quota'?429:scenario==='auth-error'?401:404}}); process.exitCode=1; return; }
  json({session_id:'new-'+Math.random(),response:output,...(scenario==='no-usage'?{}:{stats:{models:{'pinned-v1':{api:{totalRequests:1},tokens:{prompt:100,input:40,candidates:20,thoughts:5,tool:10,cached:60,total:135},roles:{main:{tokens:{prompt:100}}}}}}})});
 }
});
`;
  writeFileSync(executable, source); chmodSync(executable, 0o755); return { executable, record, clientHome };
}
