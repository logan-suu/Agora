// Exercise the actual Agora GlobalScheduler with deterministic LangGraph workers.
// Model execution and OS sandbox lifecycle are outside this probe's scope.
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname,join,resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(here,'../runtime/package.json'));
const repoRequire=createRequire(resolve('package.json'));
const ts=repoRequire('typescript');
const source=readFileSync('packages/core/orchestration/src/global-scheduler.ts','utf8');
const emitted=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {GlobalScheduler}=await import('data:text/javascript;base64,'+Buffer.from(emitted).toString('base64'));
const {StateGraph,Annotation,START,END,Send}=require('@langchain/langgraph');
const {SqliteSaver}=require('@langchain/langgraph-checkpoint-sqlite');
const root=resolve('test-outputs/langgraph-spike-20260916/results/scheduler');mkdirSync(root,{recursive:true});
const state=Annotation.Root({results:Annotation({reducer:(a,b)=>a.concat(b),default:()=>[]})});
const scheduler=new GlobalScheduler({cap:2});
const events=[];let requests=0,maxActive=0;let release;
const allQueued=new Promise(r=>{release=r;});
const savers=[];
function makeGraph(project){
  const saver=SqliteSaver.fromConnString(join(root,project+'.sqlite'));savers.push(saver);
  return new StateGraph(state).addNode('worker',async(input)=>{
    requests++;if(requests===12)release();
    const lease=await scheduler.acquire(project,'task',input.worker);
    maxActive=Math.max(maxActive,scheduler.activeCount);events.push({event:'grant',project,worker:input.worker,active:scheduler.activeCount});
    await allQueued;await delay(35);scheduler.assertActive(lease);await scheduler.release(lease);
    events.push({event:'release',project,worker:input.worker,active:scheduler.activeCount});
    return {results:[input.worker]};
  }).addConditionalEdges(START,()=>Array.from({length:4},(_,i)=>new Send('worker',{worker:project+i})),['worker'])
    .addEdge('worker',END).compile({checkpointer:saver});
}
try{
  const outputs=await Promise.all(['A','B','C'].map(project=>makeGraph(project).invoke({results:[]},{configurable:{thread_id:project},durability:'sync'})));
  assert.equal(maxActive,2);assert.equal(scheduler.activeCount,0);assert.ok(outputs.every(x=>x.results.length===4));
  const order=events.filter(x=>x.event==='grant').map(x=>x.project);
  assert.deepEqual(order.slice(2,5),['B','C','A']);
  const one=new GlobalScheduler({cap:1});const live=await one.acquire('X','task','active');const abort=new AbortController();
  let queuedExecuted=false;
  const waiting=one.acquire('Y','task','waiting',abort.signal).then(()=>{queuedExecuted=true;}).catch(e=>({name:e.name}));
  abort.abort();const cancellation=await waiting;await one.release(live);
  assert.equal(queuedExecuted,false);assert.equal(one.activeCount,0);assert.equal(cancellation.name,'AbortError');
  const result={probe:'S08-real-global-scheduler',maxActive,completed:12,order,queuedCancellation:cancellation,queuedExecuted,events};
  writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{for(const saver of savers)if(saver.db.open)saver.db.close();}
