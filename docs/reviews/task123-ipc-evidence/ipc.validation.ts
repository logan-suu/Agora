// Supplemental L03 mechanism evidence uses the exact production policy builder.
// It contacts only a disposable Unix listener and looks up (never messages or
// queries) the securityd Mach port; no Keychain item or real secret is accessed.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync,statfsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {expect,it} from 'vitest';
import {buildLocalCommandPolicy} from '../../../packages/runtime/sandbox/src/local-command-policy';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
it('denies the securityd Mach route and Unix connections for native parent and child',async()=>{
 const base=mkdtempSync('/private/tmp/agora-task123-validation-'),identity=lstatSync(base);
 const evidence:Record<string,unknown>={base,identity:{dev:identity.dev,ino:identity.ino},startedAt:new Date().toISOString(),scope:'L03 supplemental actual IPC policy qualification; no Keychain secrets',sources:{}};
 const folder=resolve('test-outputs/reviews/task123-ipc-evidence');
 mkdirSync(folder,{recursive:true});
 const report=resolve(folder,`${base.split('-').at(-1)}.json`);
 writeFileSync(report,JSON.stringify(evidence,null,2));
 let failure:unknown;let server:ReturnType<typeof createServer>|undefined;
 try {
  const source=resolve('docs/reviews/task123-ipc-evidence/probe.c'),exe=join(base,'probe');
  evidence.sources=Object.fromEntries([source,resolve('docs/reviews/task123-ipc-evidence/ipc.validation.ts'),resolve('packages/runtime/sandbox/src/local-command-policy.ts')].map(p=>[p,hash(readFileSync(p))]));
  execFileSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-mmacosx-version-min=15.0',source,'-o',exe]);
  const input=join(base,'input'),sourceRoot=join(base,'source'),output=join(base,'output');
  for(const p of [input,sourceRoot,output])mkdirSync(p,{mode:0o700});
  const socket=join(input,'listener');let connected=0;
  server=createServer(s=>{connected++;s.end()});
  await new Promise<void>((yes,no)=>{server?.once('error',no);server?.listen(socket,yes)});
  const baseline=spawnSync(exe,[socket],{encoding:'utf8',timeout:5000,env:{}});
  evidence.baseline=baseline;
  expect(baseline.status).toBe(0);
  const original=baseline.stdout.trim().split('\n').map(s=>JSON.parse(s));
  expect(original).toHaveLength(2);
  for(const event of original)expect(event).toMatchObject({securitydLookup:0,unixConnected:true});
  await new Promise<void>((yes,no)=>{const deadline=Date.now()+2000;const check=()=>{if(connected===2)yes();else if(Date.now()>deadline)no(Error('baseline_socket_incomplete'));else setTimeout(check,10)};check()});
  const policy=buildLocalCommandPolicy({executable:exe,sourceRoot,inputRoot:input,outputRoot:output,deniedRoots:[]});
  evidence.policy=policy;
  const confined=spawnSync('/usr/bin/sandbox-exec',['-p',policy,exe,socket],{encoding:'utf8',timeout:5000,env:{HOME:output,TMPDIR:output},cwd:output});
  evidence.confined=confined;
  expect(confined.status).toBe(0);
  const denied=confined.stdout.trim().split('\n').map(s=>JSON.parse(s));
  expect(denied.map(e=>e.actor)).toEqual(['parent','child']);
  for(const event of denied){expect(event.securitydLookup).toBe(1100);expect(event.unixConnected).toBe(false);expect([1,13]).toContain(event.unixErrno)}
  await new Promise<void>(yes=>setImmediate(yes));
  expect(connected).toBe(2);
  evidence.connected=connected;
 }catch(e){failure=e;evidence.failure=String(e)}finally{
  if(server)await new Promise<void>((yes,no)=>server?.close(e=>e?no(e):yes()));
  evidence.files=Object.fromEntries(readdirSync(base,{recursive:true}).map(String).filter(p=>lstatSync(join(base,p)).isFile()).map(p=>[p,hash(readFileSync(join(base,p)))]));
  writeFileSync(report,JSON.stringify(evidence,null,2));
  const handles=spawnSync('/usr/sbin/lsof',['-nP','+D',base],{encoding:'utf8'}),mounts=spawnSync('/sbin/mount',[],{encoding:'utf8'}),now=lstatSync(base);
  if(handles.status!==1||handles.stdout||handles.stderr||mounts.status!==0||mounts.stdout.includes(base)||now.dev!==identity.dev||now.ino!==identity.ino||realpathSync(base)!==base)throw Error('ipc_fixture_cleanup_unproven');
  const before=statfsSync(base);rmSync(base,{recursive:true});const after=statfsSync('/private/tmp');
  evidence.cleanup={deleted:true,noHandles:true,noMounts:true,availableBytesDelta:after.bavail*after.bsize-before.bavail*before.bsize};
  writeFileSync(report,JSON.stringify(evidence,null,2));
 }
 if(failure)throw failure;
},30000);
