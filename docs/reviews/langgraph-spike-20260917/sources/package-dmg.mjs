// Disk-image phase of the packaging probe; state stays outside the read-only image.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auditResources } from '../../../apps/desktop/dist/build-resources.js';
const root=resolve('test-outputs/langgraph-spike-round2');
const out=join(root,'package-probe');
const result=JSON.parse(await readFile(join(root,'results/package-prepared.json'),'utf8'));
const db=join(out,'external-state.sqlite');
function run(appPath,mode){
 const stdout=execFileSync(join(appPath,'Contents/MacOS/probe-node'),[join(appPath,'Contents/Resources/service/probe.mjs'),mode,db],{cwd:'/private/tmp',encoding:'utf8'});
 result.runs.push({...JSON.parse(stdout.trim()),appPath});
}
const dmg=join(out,'LangGraphProbe.dmg');
const mount=join(out,'mount');await mkdir(mount,{recursive:true});
let mounted=false;
try{
 execFileSync('/usr/bin/hdiutil',['create','-quiet','-srcfolder',join(out,'stage'),'-format','UDZO','-volname','LangGraphProbe',dmg]);
 result.dmgSha256=createHash('sha256').update(await readFile(dmg)).digest('hex');
 execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]);mounted=true;
 const mountedApp=join(mount,'LangGraphProbe.app');
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',mountedApp]);
 run(mountedApp,'inspect');run(mountedApp,'resume');
 const relocated=join(out,'relocated/LangGraphProbe.app');await cp(mountedApp,relocated,{recursive:true});
 execFileSync('/usr/bin/hdiutil',['detach','-quiet',mount]);mounted=false;
 run(relocated,'finished');run(relocated,'resume');
 result.resources=await auditResources(join(relocated,'Contents/Resources'));
 result.passed=true;
}catch(error){result.failure=String(error);throw error;}
finally{
 if(mounted)execFileSync('/usr/bin/hdiutil',['detach','-quiet',mount]);
 result.unmounted=true;result.endedAt=new Date().toISOString();
 await writeFile(join(root,'results/package.json'),JSON.stringify(result,null,2));
}
