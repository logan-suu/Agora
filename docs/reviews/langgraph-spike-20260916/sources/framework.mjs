// Deterministic framework probes use fixed fictional work, not model doubles for G5.
// Exit injection is confined to disposable child processes without live model calls.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(here,'../runtime/package.json'));
const {StateGraph,Annotation,START,END,Send,Command,interrupt}=require('@langchain/langgraph');
const {SqliteSaver}=require('@langchain/langgraph-checkpoint-sqlite');
const Database=require('better-sqlite3');
const [mode,rootArg]=process.argv.slice(2);
const root=resolve(rootArg);
mkdirSync(root,{recursive:true});
const logPath=join(root,'events.jsonl');
function log(event, data={}) {appendFileSync(logPath,JSON.stringify({at:Date.now(),pid:process.pid,event,...data})+'\n');}
function records(){return existsSync(logPath)?readFileSync(logPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
function atomic(path,value){writeFileSync(path+'.tmp',JSON.stringify(value));renameSync(path+'.tmp',path);}
const cfg={configurable:{thread_id:'fixed-task'},durability:'sync',recursionLimit:32};
const State=Annotation.Root({results:Annotation({reducer:(a,b)=>a.concat(b),default:()=>[]})});
const dbPath=join(root,'checkpoint.sqlite');
let saver;
function openSaver(){saver=SqliteSaver.fromConnString(dbPath);return saver;}
function report(value){atomic(join(root,mode+'.json'),value);console.log(JSON.stringify(value));}

async function rawFailure(wrapped){
  let started;
  const began=new Promise(r=>{started=r;});
  let siblingFinished=false,siblingAborted=false,joinCalls=0;
  const g=new StateGraph(State)
    .addNode('worker',async(input,config)=>{
      if(input.id==='A') {
        await began; await delay(30); log('A-failure');
        if(wrapped)return {results:[{id:'A',kind:'failed'}]};
        throw Error('FIXED_BRANCH_FAILURE');
      }
      log('B-start'); started();
      config.signal?.addEventListener('abort',()=>{siblingAborted=true;log('B-abort-signal');},{once:true});
      // This deliberately observes cancellation without forwarding it to an agent.
      await delay(400); siblingFinished=true;log('B-finish');
      return {results:[{id:'B',kind:'completed'}]};
    })
    .addNode('join',async()=>{joinCalls++;log('join');return {};})
    .addConditionalEdges(START,()=>[new Send('worker',{id:'A'}),new Send('worker',{id:'B'})],['worker'])
    .addEdge('worker','join').addEdge('join',END).compile({checkpointer:openSaver()});
  let returned,error;
  try{returned=await g.invoke({results:[]},cfg);}catch(e){error=e.message;}
  const finishedAtGraphReturn=siblingFinished;
  log('graph-return',{error,finishedAtGraphReturn});
  await delay(500);
  if(wrapped){assert.equal(error,undefined);assert.equal(joinCalls,1);assert.equal(siblingAborted,false);assert.equal(returned.results.length,2);}
  else assert.equal(error,'FIXED_BRANCH_FAILURE');
  report({probe:wrapped?'S01-outcome-adapter':'S01-raw-failure',error:error??null,siblingAborted,finishedAtGraphReturn,siblingFinished,joinCalls,events:records()});
}

async function pendingWrites(){
  class ObservedSaver extends SqliteSaver {
    async putWrites(config,writes,taskId){
      await super.putWrites(config,writes,taskId);
      if(writes.some(([key,value])=>key==='results'&&Array.isArray(value)&&value.some(x=>x.id==='A'))){
        atomic(join(root,'A-durable.json'),{taskId});log('A-pending-write-durable');
      }
    }
  }
  saver=new ObservedSaver(new Database(dbPath));
  const g=new StateGraph(State).addNode('worker',async(input)=>{
    log('call-'+input.id);
    if(input.id==='B'&&mode==='pending-start'){
      for(let i=0;i<100;i++){if(existsSync(join(root,'A-durable.json'))){log('controlled-process-exit');process.exit(73);}await delay(20);}
      throw Error('A_PENDING_WRITE_NOT_OBSERVED');
    }
    return {results:[{id:input.id,kind:'completed'}]};
  }).addNode('join',()=>{log('join');return {};})
    .addConditionalEdges(START,()=>[new Send('worker',{id:'A'}),new Send('worker',{id:'B'})],['worker'])
    .addEdge('worker','join').addEdge('join',END).compile({checkpointer:saver});
  if(mode==='pending-inspect'){
    const snapshot=await g.getState(cfg);
    report({probe:'S02-read-only-restart',next:snapshot.next,tasks:snapshot.tasks.map(t=>({id:t.id,name:t.name,error:t.error,hasResult:t.result!==undefined})),counts:records().filter(x=>x.event.startsWith('call-')).length});return;
  }
  const out=await g.invoke(mode==='pending-start'?{results:[]}:null,cfg);
  assert.equal(mode,'pending-resume');
  assert.equal(records().filter(x=>x.event==='call-A').length,1);
  assert.equal(records().filter(x=>x.event==='call-B').length,2);
  assert.deepEqual(out.results.map(x=>x.id).sort(),['A','B']);
  assert.equal(records().filter(x=>x.event==='join').length,1);
  report({probe:'S02-pending-writes',aCalls:1,bCalls:2,results:out.results,events:records()});
}

async function gate(){
  const g=new StateGraph(State).addNode('gate',()=>{
    log('gate-entry');
    const canonical=join(root,'resolution.json');
    const input=interrupt({gateId:'gate-1'});
    assert.equal(existsSync(canonical),true);
    const receipt=JSON.parse(readFileSync(canonical,'utf8'));
    assert.deepEqual(input,{receiptId:receipt.id});
    log('gate-resolved');return {results:[{id:receipt.id}]};
  }).addNode('finish',()=>{log('finish');return {};})
    .addEdge(START,'gate').addEdge('gate','finish').addEdge('finish',END).compile({checkpointer:openSaver()});
  if(mode==='gate-inspect'){
    const before=records().length,snapshot=await g.getState(cfg);
    assert.deepEqual(snapshot.next,['gate']);assert.equal(records().length,before);
    report({probe:'S03-read-only-wait',next:snapshot.next,interrupts:snapshot.tasks.flatMap(t=>t.interrupts??[])});return;
  }
  if(mode==='gate-start'){
    const out=await g.invoke({results:[]},cfg);assert.equal(out.__interrupt__.length,1);
    assert.equal(records().filter(x=>x.event==='finish').length,0);
    report({probe:'S03-interrupt',interrupts:out.__interrupt__});return;
  }
  atomic(join(root,'resolution.json'),{id:'resolution-1',gateId:'gate-1'});
  let out,error;
  try{out=await g.invoke(new Command({resume:{receiptId:'resolution-1'}}),cfg);}catch(e){error=e.message;}
  if(mode==='gate-resume'){
    assert.equal(error,undefined);assert.equal(records().filter(x=>x.event==='gate-entry').length,2);
    assert.equal(records().filter(x=>x.event==='finish').length,1);
    assert.deepEqual(out.results,[{id:'resolution-1'}]);
  }
  else assert.equal(records().filter(x=>x.event==='finish').length,1);
  report({probe:mode==='gate-resume'?'S03-resume':'S03-duplicate-resume',error:error??null,out:out??null,events:records()});
}

async function effectReplay(){
  const receiptPath=join(root,'business-receipt.json');
  class CrashSaver extends SqliteSaver {
    async putWrites(config,writes,taskId){
      if(mode==='effect-start'&&existsSync(receiptPath)&&writes.some(([key])=>key==='results')){
        log('exit-before-output-write');process.exit(74);
      }
      return super.putWrites(config,writes,taskId);
    }
  }
  saver=new CrashSaver(new Database(dbPath));
  const g=new StateGraph(State).addNode('effect',()=>{
    log('node-entry');
    if(existsSync(receiptPath)){
      const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
      assert.equal(receipt.input,'fixed-input');assert.equal(receipt.count,1);
      assert.equal(readFileSync(join(root,'effect.txt'),'utf8'),'one-fixed-effect\n');
      log('receipt-reused');return {results:[{id:receipt.id}]};
    }
    if(mode.startsWith('gap-')&&existsSync(join(root,'effect.txt'))){
      log('unreceipted-effect-detected');throw Error('NEEDS_ATTENTION_UNPROVEN_EFFECT');
    }
    appendFileSync(join(root,'effect.txt'),'one-fixed-effect\n');log('external-effect');
    if(mode==='gap-start'){log('exit-before-business-receipt');process.exit(75);}
    atomic(receiptPath,{id:'effect-1',input:'fixed-input',count:1});log('business-committed');
    return {results:[{id:'effect-1'}]};
  }).addEdge(START,'effect').addEdge('effect',END).compile({checkpointer:saver});
  if(mode==='effect-corrupt')atomic(receiptPath,{id:'effect-1',input:'wrong-input',count:1});
  let out,error;
  try{out=await g.invoke(mode==='effect-start'||mode==='gap-start'?{results:[]}:null,cfg);}catch(e){error=e.message;}
  if(mode==='gap-resume'){assert.equal(error,'NEEDS_ATTENTION_UNPROVEN_EFFECT');assert.equal(records().filter(x=>x.event==='external-effect').length,1);}
  else if(mode==='effect-corrupt'){assert.ok(error);assert.equal(records().filter(x=>x.event==='external-effect').length,1);}
  else{assert.equal(error,undefined);assert.deepEqual(out.results,[{id:'effect-1'}]);assert.equal(records().filter(x=>x.event==='external-effect').length,1);}
  report({probe:mode.startsWith('gap-')?'S05-unreceipted-effect-rejected':mode==='effect-corrupt'?'S05-mismatched-receipt-rejected':'S05-receipt-replay',error:error??null,out:out??null,events:records()});
}

async function streaming(){
  const LocalState=Annotation.Root({visible:Annotation(),privateFact:Annotation()});
  const events=[];
  const g=new StateGraph(LocalState).addNode('work',async(_,config)=>{
    config.writer?.({kind:'safe-progress',step:1});await delay(80);
    return {visible:'done',privateFact:'FIXED_INTERNAL_SENTINEL'};
  }).addEdge(START,'work').addEdge('work',END).compile({checkpointer:openSaver()});
  for await(const chunk of await g.stream({}, {...cfg,streamMode:['custom','values']}))events.push(chunk);
  assert.ok(events.some(([kind,value])=>kind==='custom'&&value.kind==='safe-progress'));
  assert.ok(events.some(([kind,value])=>kind==='values'&&value.privateFact==='FIXED_INTERNAL_SENTINEL'));
  report({probe:'S07-raw-stream-boundary',customBeforeFinalValues:events.findIndex(x=>x[0]==='custom')<events.findIndex(x=>x[1]?.visible==='done'),rawValuesExposeInternalState:true,events});
}

try {
  if(mode==='raw'||mode==='wrapped')await rawFailure(mode==='wrapped');
  else if(mode.startsWith('pending-'))await pendingWrites();
  else if(mode.startsWith('gate-'))await gate();
  else if(mode.startsWith('effect-')||mode.startsWith('gap-'))await effectReplay();
  else if(mode==='stream')await streaming();
  else throw Error('unknown mode');
} catch(error){log('probe-failed',{name:error.name,message:error.message});console.error(error);process.exitCode=1;}
finally{if(saver?.db.open)saver.db.close();}
