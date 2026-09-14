const {stopChild}=require('./stop-child.cjs');
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base=p.dirname(p.dirname(p.dirname(process.resourcesPath))),res=process.resourcesPath,probe=fs.mkdtempSync(base+'/probe-run-');
fs.mkdirSync(probe,{recursive:true});app.setPath('userData',probe+'/electron-profile');app.setPath('sessionData',probe+'/electron-cache');app.setPath('logs',probe+'/logs');
const report={electron:process.versions.electron,electronNode:process.versions.node,packaged:app.isPackaged,checks:[]};
const check=(name,value)=>{assert(value,name);report.checks.push(name);fs.writeFileSync(probe+'/checkpoint.json',JSON.stringify(report,null,2));};
let child,win,keychainCreated=false,backendStopped=false;
const keychain=probe+'/isolated.keychain-db';
const env={PATH:res+'/node/bin:'+res+'/git/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',LANG:'en_US.UTF-8',GIT_EXEC_PATH:res+'/git/libexec/git-core',GIT_TEMPLATE_DIR:res+'/git/share/git-core/templates',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
function exec(file,args,cwd=probe){return cp.execFileSync(file,args,{cwd,env,encoding:'utf8',timeout:20000}).trim();}
function message(type){return new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(new Error(type+' timeout')),45000);const onMessage=m=>{if(m.type==='error'||m.type===type){clearTimeout(timeout);child.off('message',onMessage);m.type==='error'?reject(new Error(m.message)):done(m);}};child.on('message',onMessage);});}
app.whenReady().then(async()=>{
 try{
 check('packaged app',app.isPackaged);check('single instance lock',app.requestSingleInstanceLock());
 report.node=exec(res+'/node/bin/node',['--version']);report.pnpm=exec(res+'/node/bin/node',[res+'/pnpm/bin/pnpm.cjs','--version']);report.git=exec(res+'/git/bin/git',['--version']);
 check('managed versions',report.node==='v24.20.0'&&report.pnpm==='9.15.9'&&report.git==='git version 2.53.0');
 const repo=probe+'/repo',worktree=probe+'/worktree';fs.mkdirSync(repo,{recursive:true});
 exec(res+'/git/bin/git',['init','-b','main',repo]);exec(res+'/git/bin/git',['-C',repo,'config','user.name','Spike']);exec(res+'/git/bin/git',['-C',repo,'config','user.email','spike@example.invalid']);fs.writeFileSync(repo+'/evidence.txt','managed-git\n');exec(res+'/git/bin/git',['-C',repo,'add','evidence.txt']);exec(res+'/git/bin/git',['-C',repo,'commit','-m','Record isolated packaging evidence']);exec(res+'/git/bin/git',['-C',repo,'worktree','add','-b','spike-worker',worktree]);check('real managed Git worktree',fs.readFileSync(worktree+'/evidence.txt','utf8')==='managed-git\n');
 const fd=fs.openSync(worktree,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);const helper=res+'/native/secure-files-arm64';let safe;
 try{safe=cp.spawnSync(helper,['write',worktree,'helper.txt',worktree],{input:'secure-helper\n',stdio:['pipe','pipe','pipe',fd],env});check('native helper write',safe.status===0);safe=cp.spawnSync(helper,['read',worktree,'helper.txt',worktree],{stdio:['ignore','pipe','pipe',fd],env});check('native helper read',safe.status===0&&safe.stdout.toString()==='secure-helper\n');safe=cp.spawnSync(helper,['read',worktree,'../repo/evidence.txt',worktree],{stdio:['ignore','pipe','pipe',fd],env});check('native helper rejects escape',safe.status!==0);}finally{fs.closeSync(fd);}
 const password=crypto.randomBytes(24).toString('hex');exec('/usr/bin/security',['create-keychain','-p',password,keychain]);keychainCreated=true;exec('/usr/bin/security',['unlock-keychain','-p',password,keychain]);
 const token=crypto.randomBytes(32).toString('hex');const out=fs.openSync(probe+'/service.log','w');child=cp.fork(res+'/service/desktop-spike.mjs',[],{execPath:res+'/node/bin/node',cwd:res+'/service/apps/web',env,detached:true,stdio:['ignore',out,out,'ipc']});child.on('error',error=>{report.childError=error.code;});const ready=message('ready');child.send({type:'start',token,dataRoot:probe+'/state',helper:res+'/native/keychain-arm64',keychain});const started=await ready;report.backend=started;check('production instrumentation and real Keychain',started.credentials==='ready');
 const url=`http://127.0.0.1:${started.port}`;check('unauthenticated request denied',(await fetch(url)).status===403);
 const headers={'x-agora-spike':token};const settings=await fetch(url+'/api/model-settings?projectId=spike',{headers});check('real dynamic settings API',settings.status===200);report.settingsKeys=Object.keys(await settings.json());check('cross origin denied',(await fetch(url,{headers:{...headers,origin:'https://example.invalid'}})).status===403);check('product writes unavailable in spike',(await fetch(url+'/api/tasks',{method:'POST',headers})).status===405);
 session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));session.defaultSession.webRequest.onBeforeSendHeaders({urls:[url+'/*']},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-agora-spike':token}}));
 win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,target)=>{if(new URL(target).origin!==url)event.preventDefault();});await win.loadURL(url);report.renderer=await win.webContents.executeJavaScript('({title:document.title,requireType:typeof require,nodeType:typeof process,text:document.body.innerText.slice(0,200)})');check('existing React page rendered',report.renderer.text.includes('Agora'));check('renderer has no Node',report.renderer.requireType==='undefined'&&report.renderer.nodeType==='undefined');fs.writeFileSync(probe+'/window.png',(await win.webContents.capturePage()).toPNG());
 const readKey=()=>cp.execFileSync(res+'/native/keychain-arm64',['read','com.agora.spike.112','spike',keychain],{env,timeout:20000});const before=readKey();const stopped=message('stopped');child.send({type:'stop'});await stopped;backendStopped=true;check('backend graceful stop',true);check('Keychain key stable after service stop',before.equals(readKey()));before.fill(0);win.destroy();win=undefined;
 report.status='passed';
 }catch(error){report.status='failed';report.error=String(error.message);}
 finally{
   if(win)win.destroy();
   let terminated=false;
   try{
     const cleanup=await stopChild(child,{sendStop:!backendStopped});
     terminated=true;
     report.forcedTermination=cleanup.forced;
     if(cleanup.forced){report.cleanupError='probe exceeded graceful shutdown deadline';report.status='failed';}
   }catch{report.cleanupError='probe termination failed';report.status='failed';}
   if(keychainCreated&&terminated){try{exec('/usr/bin/security',['delete-keychain',keychain]);report.keychainRemoved=true;}catch{report.cleanupError='temporary Keychain cleanup failed';report.status='failed';}}
   fs.writeFileSync(probe+'/result.json',JSON.stringify(report,null,2)+'\n');
   fs.writeFileSync(base+'/last-probe.txt',probe);
   app.exit(report.status==='passed'?0:1);
 }
});
