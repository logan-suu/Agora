// Characterization of a production replay defect, using the real-run fixture.
// Passing this diagnosis does not mean the D9 duplicate-resolution path passes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyMutations, createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import { validateHumanGateWorkerResumes } from '@agora/core-orchestration';
import { it } from 'vitest';
it('locates the completed-worker replay rejection without a model or state write', () => {
  const output=resolve('test-outputs/langgraph-spike-round2/results');
  const f=JSON.parse(readFileSync(`${output}/replay-fixture.json`,'utf8'));
  const actionId=f.leader.msgId;
  const receipt=f.leader.payload.resolution;
  assert.equal(actionId,'graph-native-continue');
  assert.equal(f.leader.payload.intent.gateId,receipt.gateId);
  assert.equal(f.leader.payload.intent.option,receipt.option);
  assert.deepEqual(f.resumed.payload.workerResumes,receipt.workerResumes);
  assert.equal(f.completedWorker.sessionId,receipt.workerResumes[0].resumeSessionId);
  assert.equal(f.completedWorker.safePoint,receipt.workerResumes[0].sourceSafePointRef);
  assert.equal(f.pausedWorker.safePoint,f.completedWorker.safePoint);
  const make=(worker: typeof f.pausedWorker)=>applyMutations(createInitialAppState(f.scope.taskId,'diagnostic',f.scope.projectId),[mergeByIdMutation('workers',worker.workerId,worker)]);
  assert.deepEqual(validateHumanGateWorkerResumes(make(f.pausedWorker),actionId,receipt.safePointRefs,receipt.workerResumes),receipt.workerResumes);
  assert.throws(()=>validateHumanGateWorkerResumes(make(f.completedWorker),actionId,receipt.safePointRefs,receipt.workerResumes),/conflicts with canonical paused workers/);
  writeFileSync(`${output}/diagnosis.json`,JSON.stringify({
    result:'confirmed-production-replay-defect',
    hypotheses:[
      {hypothesis:'incoming parameters or canonical receipt changed',result:'ruled out for this fixture: matching action/gate/option, canonical resumed marker matches receipt'},
      {hypothesis:'worker source or child identity changed unexpectedly',result:'ruled out: stable source ref, exact deterministic child session; live resumed tools and tests passed'},
      {hypothesis:'replay uses paused-only validator after legitimate progress',result:'confirmed: identical receipt accepted against real paused worker, rejected against real done worker'},
    ],
    failingCaller:'apps/web/src/server/message-runtime.ts:1151',
    failingInvariant:'packages/core/orchestration/src/human-gate.ts:385 paused.length !== plans.length',
    productionCodeChanged:false,
  },null,2));
});
