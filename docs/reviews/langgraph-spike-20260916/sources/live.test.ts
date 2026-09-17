// Isolated Graph/Harness/MCP seam experiment with real OpenCode Go requests.
// A small test-owned lifecycle adapter is not the production WorkerRuntime/D4 composition.
// Only fictional fixture text is sent to the model. No generated code is executed.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { createToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { expect, it } from 'vitest';
import { resolveLiveTestModel } from '../../../tests/helpers/live-model';

const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(here,'../runtime/package.json'));
const {StateGraph,Annotation,START,END,Send,Command,interrupt}=require('@langchain/langgraph');
const {SqliteSaver}=require('@langchain/langgraph-checkpoint-sqlite');
const mode=process.env.LG_SPIKE_MODE??'initial';
const root=resolve(`test-outputs/langgraph-spike-20260916/results/${mode==='failure'?'live-failure':'live'}`);
const scope={projectId:'graph-spike-project',taskId:'graph-spike-task'};
const cfg={configurable:{thread_id:'fixed-live-task'},durability:'sync',recursionLimit:32};
mkdirSync(root,{recursive:true});
function log(event:string,data:Record<string,unknown>={}){appendFileSync(join(root,'events.jsonl'),JSON.stringify({at:Date.now(),pid:process.pid,event,...data})+'\n');}
function atomic(path:string,data:unknown){writeFileSync(path+'.tmp',JSON.stringify(data,null,2));renameSync(path+'.tmp',path);}
function events(){return existsSync(join(root,'events.jsonl'))?readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];}
const spec=PHASE0_ROSTER.find(r=>r.role==='CODER');
if(!spec)throw Error('CODER missing');
const sessionsRoot=join(root,'harness-sessions');
const scheduler=new GlobalScheduler({cap:2});
const sources=new Map<string,HarnessExecutor>();
const activeCalls=new Set<Promise<unknown>>();
const toolReady=new Set<string>();
let releaseTools:()=>void;
const readyBarrier=new Promise<void>(resolve=>{releaseTools=resolve;});
let announceFirstTool:()=>void;
const firstTool=new Promise<void>(resolve=>{announceFirstTool=resolve;});

function fixtureView(workerId:string,resuming:boolean){
  const text=resuming
    ? 'Read note.txt with fs_read, then use fs_write to write answer.txt containing exactly the token in note.txt with no commentary or extra whitespace. End with one short completion sentence.'
    : 'You must use fs_read to read note.txt before answering. Do not guess its contents. After reading, use fs_write to create answer.txt containing exactly its token. End with one short sentence.';
  const state=createInitialAppState(scope.taskId,text,scope.projectId);
  state.phase='coding';
  state.requirements=[{id:'r-'+workerId,story:text,nonGoals:[],acceptance:['Use actual file tools; do not invent file contents.']}];
  state.subtasks=[{id:'s-'+workerId,title:text,ownerRole:'CODER',dependsOn:[],status:'in_progress'}];
  return project(state,'CODER',PHASE0_ROSTER);
}

async function executeWorker(workerId:string,resuming:boolean){
  const label=resuming?'resume':'initial';
  const receiptFile=join(root,`${workerId}-${label}.json`);
  if(existsSync(receiptFile)) {log('receipt-reused',{workerId,label});return JSON.parse(readFileSync(receiptFile,'utf8'));}
  const cwd=join(root,'workspaces',workerId);
  mkdirSync(cwd,{recursive:true});
  if(!resuming)writeFileSync(join(cwd,'note.txt'),`FICTIONAL_${workerId}_TOKEN`);
  const live=await resolveLiveTestModel();
  const lease=await scheduler.acquire(scope.projectId,scope.taskId,workerId);
  log('lease-acquired',{workerId,label,active:scheduler.activeCount,leaseId:lease.leaseId});
  const registry=new WorktreeRegistry();registry.register(cwd);
  const catalog=await createToolCatalog({registry,sandbox:new LocalTempSandbox(),getWorktree:async()=>({path:cwd,branch:`fixture-${workerId}`})});
  const tools=catalog.resolve(['fs.read','fs.write']);
  assert.deepEqual(tools.unavailable,[]);
  const sessionId=resuming?`graph-resume-${workerId}`:`graph-source-${workerId}`;
  const executor=new HarnessExecutor({...spec!,model:live.model},{
    ...live.options,tools:tools.definitions,allowTools:tools.allowNames,
    sessionPersistence:{root:sessionsRoot,cwd,...scope,...(resuming?{resumeSessionId:sessionId}:{})},
    approval:async(exec)=>{
      scheduler.assertActive(lease);log('tool-start',{workerId,label,name:exec.name});
      announceFirstTool();
      if(!resuming&&exec.name==='fs_read'&&!toolReady.has(workerId)){
        toolReady.add(workerId);
        if(toolReady.size===2){
          log('request-cohort-safe-point',{workers:[...toolReady].sort()});
          for(const ex of sources.values())ex.requestSafePoint();
          releaseTools();
        }
        await readyBarrier;
      }
      return {kind:'allow'};
    },
  });
  sources.set(workerId,executor);
  try{
    if(resuming){
      const source=JSON.parse(readFileSync(join(root,`${workerId}-initial.json`),'utf8'));
      await executor.loadSafePoint(source.safePointRef);log('fork-loaded',{workerId,sessionId});
      executor.injectInbox(fixtureView(workerId,true));
    }
    log('harness-step-start',{workerId,label,sessionId,provider:live.options.provider,model:live.model});
    const step=await executor.step({sessionId,view:fixtureView(workerId,resuming)});
    assert.equal(step.reachedSafeBoundary,true);
    if(!resuming){assert.equal(step.kind,'tool');assert.equal(existsSync(join(cwd,'answer.txt')),false);}
    else {assert.equal(step.kind,'done');assert.equal(readFileSync(join(cwd,'answer.txt'),'utf8'),`FICTIONAL_${workerId}_TOKEN`);}
    const safePointRef=await executor.saveSafePoint();
    const record={workerId,label,sessionId,kind:step.kind,safePointRef,toolCalls:events().filter(x=>x.event==='tool-start'&&x.workerId===workerId&&x.label===label).map(x=>x.name)};
    atomic(receiptFile,record);log('safe-point-durable',{workerId,label,kind:step.kind});
    return record;
  }finally{
    await executor.dispose();await catalog.dispose();registry.unregister(cwd);await scheduler.release(lease);
    log('worker-disposed',{workerId,label,active:scheduler.activeCount});
  }
}

it(`real Graph + two Harness Agents + MCP (${mode})`,async()=>{
  const saver=SqliteSaver.fromConnString(join(root,'checkpoint.sqlite'));
  const State=Annotation.Root({results:Annotation({reducer:(a:unknown[],b:unknown[])=>a.concat(b),default:()=>[]})});
  const graph=new StateGraph(State)
    .addNode('agent',async(input:{workerId:string,resuming:boolean})=>{
      const call=executeWorker(input.workerId,input.resuming);
      activeCalls.add(call);
      let receipt;
      try { receipt=await call; } finally { activeCalls.delete(call); }
      return {results:[{workerId:input.workerId,label:receipt.label,sessionId:receipt.sessionId}]};
    })
    .addNode('gate',()=>{
      assert.equal(scheduler.activeCount,0);
      for(const id of ['A','B'])assert.ok(existsSync(join(root,`${id}-initial.json`)));
      log('gate-entry');
      const value=interrupt({gateId:'fixture-gate'});
      const resolution=JSON.parse(readFileSync(join(root,'resolution.json'),'utf8'));
      assert.deepEqual(value,{receiptId:resolution.id});
      return {};
    })
    .addNode('finish',()=>{log('graph-finish');return {};})
    .addConditionalEdges(START,()=>['A','B'].map(workerId=>new Send('agent',{workerId,resuming:false})),['agent'])
    .addConditionalEdges('agent',(state:{results:{label:string}[]})=>state.results.some(x=>x.label==='resume')?'finish':'gate',['gate','finish'])
    .addConditionalEdges('gate',()=>['A','B'].map(workerId=>new Send('agent',{workerId,resuming:true})),['agent'])
    .addEdge('finish',END).compile({checkpointer:saver});
  try{
    if(mode==='failure'){
      const failureGraph=new StateGraph(State)
        .addNode('worker',async(input:{id:string},config:{signal?:AbortSignal})=>{
          if(input.id==='synthetic-failure'){await firstTool;throw Error('FIXED_SIBLING_FAILURE');}
          config.signal?.addEventListener('abort',()=>log('graph-abort-observed-not-forwarded'),{once:true});
          const call=executeWorker('B',false);activeCalls.add(call);
          try{await call;return {results:[{workerId:'B'}]};}finally{activeCalls.delete(call);}
        })
        .addConditionalEdges(START,()=>[new Send('worker',{id:'real-harness'}),new Send('worker',{id:'synthetic-failure'})],['worker'])
        .addEdge('worker',END).compile({checkpointer:saver});
      await expect(failureGraph.invoke({results:[]},cfg)).rejects.toThrow('FIXED_SIBLING_FAILURE');
      const pendingAtGraphReturn=activeCalls.size;assert.equal(pendingAtGraphReturn,1);
      for(const executor of sources.values())executor.requestSafePoint();releaseTools();
      const drained=await Promise.allSettled([...activeCalls]);
      assert.ok(drained.every(x=>x.status==='fulfilled'));assert.equal(scheduler.activeCount,0);
      assert.equal(JSON.parse(readFileSync(join(root,'B-initial.json'),'utf8')).kind,'tool');
      atomic(join(root,'result.json'),{pendingAtGraphReturn,graphSignalObserved:events().some(x=>x.event==='graph-abort-observed-not-forwarded'),safePointAfterDrain:true,activeLeases:scheduler.activeCount});
      return;
    }
    if(mode==='audit'){
      const checks=[];
      for(const workerId of ['A','B']){
        const source=JSON.parse(readFileSync(join(root,`${workerId}-initial.json`),'utf8'));
        const live=await resolveLiveTestModel();
        const options={...live.options,allowTools:[],sessionPersistence:{root:sessionsRoot,cwd:join(root,'workspaces',workerId),...scope,resumeSessionId:`graph-resume-${workerId}`}};
        const restored=new HarnessExecutor({...spec!,model:live.model},options);
        try{await restored.loadSafePoint(source.safePointRef);}finally{await restored.dispose();}
        const wrong=new HarnessExecutor({...spec!,model:live.model},{...options,sessionPersistence:{...options.sessionPersistence,taskId:'wrong-task',resumeSessionId:`forbidden-${workerId}`}});
        try{await expect(wrong.loadSafePoint(source.safePointRef)).rejects.toThrow(/scope|task|checkpoint/i);}finally{await wrong.dispose();}
        checks.push({workerId,existingChildVerifiedByOfficialLoad:true,wrongScopeRejected:true});
      }
      atomic(join(root,'audit.json'),{checks,noModelStepInvoked:true});return;
    }
    if(mode==='inspect'){
      const count=events().length;const snapshot=await graph.getState(cfg);
      assert.deepEqual(snapshot.next,['gate']);assert.equal(events().length,count);
      atomic(join(root,'inspect.json'),{next:snapshot.next,noNewEvents:true,pid:process.pid});return;
    }
    if(mode==='initial'){
      const out=await graph.invoke({results:[]},cfg);
      assert.equal(out.__interrupt__.length,1);assert.equal(out.results.length,2);
      assert.equal(scheduler.activeCount,0);atomic(join(root,'initial-result.json'),out);
    }else if(mode==='resume'){
      atomic(join(root,'resolution.json'),{id:'fixture-resolution',gateId:'fixture-gate'});
      const out=await graph.invoke(new Command({resume:{receiptId:'fixture-resolution'}}),cfg);
      assert.equal(out.results.length,4);assert.equal(scheduler.activeCount,0);
      assert.equal(events().filter(x=>x.event==='graph-finish').length,1);
      atomic(join(root,'resume-result.json'),out);
    }else if(mode==='duplicate'){
      const calls=events().filter(x=>x.event==='harness-step-start').length;
      await graph.invoke(new Command({resume:{receiptId:'fixture-resolution'}}),cfg);
      assert.equal(events().filter(x=>x.event==='harness-step-start').length,calls);
      assert.equal(events().filter(x=>x.event==='graph-finish').length,1);
      atomic(join(root,'duplicate.json'),{noAdditionalHarnessSteps:true});
    }else throw Error('unknown live probe mode');
    expect(readdirSync(sessionsRoot).length).toBeGreaterThan(0);
  }finally{
    for(const executor of sources.values())executor.requestSafePoint();
    releaseTools();
    const settled=await Promise.allSettled([...activeCalls]);
    log('supervisor-drained',{activeCalls:activeCalls.size,activeLeases:scheduler.activeCount,rejected:settled.filter(x=>x.status==='rejected').length});
    if(saver.db.open)saver.db.close();
  }
});
