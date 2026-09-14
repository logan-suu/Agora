const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const base='/private/tmp/agora-112-spike',source=base+'/source',bundle=base+'/Agora Spike.app',resources=bundle+'/Contents/Resources',stage=resources+'/service';
cp.execFileSync('/bin/cp',['-cR',base+'/electron/Electron.app',bundle]);fs.mkdirSync(stage,{recursive:true});
const files=new Set(),traces=[];
for(const entry of fs.readdirSync(source+'/apps/web/.next',{recursive:true})){if(!entry.endsWith('.nft.json'))continue;const trace=p.join(source,'apps/web/.next',entry);traces.push(trace);for(const f of JSON.parse(fs.readFileSync(trace)).files)files.add(p.resolve(p.dirname(trace),f));}
const rejected=[];let copied=0;
for(const file of files){const relative=p.relative(source,file);if(relative.startsWith('..')||/(^|\/)\.env|(^|\/)\.data\/|(^|\/)\.git\//.test(relative)){rejected.push(relative);continue;}if(!relative.startsWith('node_modules/')&&!relative.startsWith('packages/')&&!relative.startsWith('apps/web/'))continue;const stat=fs.statSync(file);if(!stat.isFile())continue;const target=p.join(stage,relative);fs.mkdirSync(p.dirname(target),{recursive:true});fs.copyFileSync(file,target);copied++;}
if(rejected.length)throw new Error('Trace contains forbidden paths: '+rejected.length);
fs.cpSync(source+'/apps/web/.next',stage+'/apps/web/.next',{recursive:true,dereference:true,filter:f=>!f.includes('/.next/cache')&&!f.endsWith('.nft.json')});
fs.copyFileSync(source+'/apps/web/package.json',stage+'/apps/web/package.json');
if(fs.existsSync(source+'/apps/web/public'))fs.cpSync(source+'/apps/web/public',stage+'/apps/web/public',{recursive:true});
fs.copyFileSync(source+'/apps/web/scripts/local-process.mjs',stage+'/local-process.mjs');
for(const name of ['node','git','pnpm'])cp.execFileSync('/bin/cp',['-cR',base+'/'+name,resources+'/'+name]);
fs.mkdirSync(resources+'/native',{recursive:true});
for(const arch of ['arm64','x86_64']){const label=arch==='x86_64'?'x64':arch;cp.execFileSync('/usr/bin/clang',['-arch',arch,'-mmacosx-version-min=13.5','-std=c11','-O2','-Wall','-Wextra','-Werror',source+'/packages/runtime/sandbox/native/secure-files.c','-o',resources+'/native/secure-files-'+label]);cp.execFileSync('/usr/bin/clang',['-arch',arch,'-mmacosx-version-min=13.5','-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-framework','Security','-framework','CoreFoundation',source+'/packages/runtime/state/native/keychain.c','-o',resources+'/native/keychain-'+label]);}
fs.mkdirSync(resources+'/app',{recursive:true});fs.writeFileSync(resources+'/app/package.json',JSON.stringify({name:'agora-112-spike',version:'0.0.0',main:'main.cjs'}));
const metadata=JSON.parse(fs.readFileSync(base+'/downloads/packager-metadata.json'));console.log({copied,traces:traces.length,rejected:rejected.length,packager:metadata.version,engines:metadata.engines});
fs.writeFileSync(base+'/stage-result.json',JSON.stringify({copied,traces:traces.length,rejected:rejected.length,sourceCommit:cp.execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8'}).trim(),buildId:fs.readFileSync(source+'/apps/web/.next/BUILD_ID','utf8'),packagerCandidate:metadata.version,packagerEngines:metadata.engines},null,2)+'\n');
