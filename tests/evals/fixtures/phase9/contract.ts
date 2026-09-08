/** Versioned public task contract; the model receives GOAL, never the scripted implementations. */
export const PLAN = {
  version: 1,
  subtasks: [
    { id: 'A', title: 'Implement normalizeRecords in normalize.mjs', dependsOn: [] },
    { id: 'B', title: 'Implement validateScore in validate.mjs', dependsOn: [] },
    { id: 'C', title: 'Implement stableRank in rank.mjs', dependsOn: [] },
    { id: 'D', title: 'Implement paginate in paginate.mjs', dependsOn: [] },
    { id: 'E', title: 'Compose processRecords in pipeline.mjs', dependsOn: ['A', 'B', 'C', 'D'] },
  ],
};

export const GOAL = `Build a modular API system with five independent ES-module source files and Node built-in tests, without dependencies or network access. Use exactly this executionPlan DAG: ${JSON.stringify(PLAN)}. Do not split or rename these subtasks. A/B/C/D are one ready wave; E depends on all four. Keep all previously committed tests.
Public contract:
A: normalize.mjs exports normalizeRecords(records). Require an array of objects with string id, string name and numeric score; invalid shapes throw TypeError. Return new objects containing exactly id/name/score, with id trimmed and name trimmed and consecutive whitespace collapsed to one space. Preserve score; do not mutate input. Empty input returns [].
B: validate.mjs exports validateScore(value). Return the value when it is a finite number in inclusive range 0..100; otherwise throw RangeError, including for strings, NaN and infinities.
C: rank.mjs exports stableRank(records). Return a new array sorted by score descending; preserve input order on equal scores. Do not mutate input. Empty input returns [].
D: paginate.mjs exports paginate(records,page,pageSize). page/pageSize must be positive integers, otherwise throw RangeError. Return {items: records.slice((page-1)*pageSize,page*pageSize), total:records.length,page,pageSize}. Out-of-range pages have empty items.
E: pipeline.mjs exports processRecords(records,options={}). options.page defaults to 1 and options.pageSize defaults to 2. Normalize, validate EVERY normalized score, rank, then paginate, using imports from all four modules. Return the pagination object. Invalid scores even outside the requested page must throw. Preserve input data. No CLI, server, package installation or additional architecture required.
TESTER must write and commit actual *.test.mjs tests using node:test/assert, execute them via sandbox_run, and retain cumulative tests. REVIEWER reviews the cumulative tested artifact. Completion requires the normal Leader completion gate.`;

/** Scripted external-LLM fixture only, excluded from the model's workspace and projection. */
export const IMPLEMENTATIONS: Record<string, { file: string; source: string }> = {
  A: {
    file: 'normalize.mjs',
    source: `export function normalizeRecords(records){if(!Array.isArray(records))throw new TypeError('records');return records.map(r=>{if(!r||typeof r.id!=='string'||typeof r.name!=='string'||typeof r.score!=='number')throw new TypeError('record');return {id:r.id.trim(),name:r.name.trim().replace(/\\s+/g,' '),score:r.score};});}`,
  },
  B: {
    file: 'validate.mjs',
    source: `export function validateScore(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)throw new RangeError('score');return value;}`,
  },
  C: {
    file: 'rank.mjs',
    source: `export function stableRank(records){return [...records].sort((a,b)=>b.score-a.score);}`,
  },
  D: {
    file: 'paginate.mjs',
    source: `export function paginate(records,page,pageSize){if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1)throw new RangeError('page');return {items:records.slice((page-1)*pageSize,page*pageSize),total:records.length,page,pageSize};}`,
  },
  E: {
    file: 'pipeline.mjs',
    source: `import {normalizeRecords} from './normalize.mjs';import {validateScore} from './validate.mjs';import {stableRank} from './rank.mjs';import {paginate} from './paginate.mjs';export function processRecords(records,{page=1,pageSize=2}={}){const normalized=normalizeRecords(records);normalized.forEach(r=>validateScore(r.score));return paginate(stableRank(normalized),page,pageSize);}`,
  },
};

const CHECKS: Record<string, string> = {
  A: `import {normalizeRecords} from './normalize.mjs';test('normalize shape and immutability',()=>{const x=[{id:' a ',name:' Alice   Smith ',score:0,extra:true}];assert.deepEqual(normalizeRecords(x),[{id:'a',name:'Alice Smith',score:0}]);assert.equal(x[0].id,' a ');assert.deepEqual(normalizeRecords([]),[]);});test('normalize rejects invalid shape',()=>{for(const x of [null,{},[null],[{id:1,name:'n',score:1}],[{id:'x',name:'n',score:'1'}]])assert.throws(()=>normalizeRecords(x),TypeError);});`,
  B: `import {validateScore} from './validate.mjs';test('score boundaries',()=>{for(const x of [0,1.25,100])assert.equal(validateScore(x),x);});test('invalid scores',()=>{for(const x of [-1,101,NaN,Infinity,'3',null])assert.throws(()=>validateScore(x),RangeError);});`,
  C: `import {stableRank} from './rank.mjs';test('stable immutable ranking',()=>{const x=[{id:'a',score:2},{id:'b',score:3},{id:'c',score:3}];assert.deepEqual(stableRank(x).map(r=>r.id),['b','c','a']);assert.deepEqual(x.map(r=>r.id),['a','b','c']);assert.deepEqual(stableRank([]),[]);});`,
  D: `import {paginate} from './paginate.mjs';test('page shape and overflow',()=>{assert.deepEqual(paginate([1,2,3],2,2),{items:[3],total:3,page:2,pageSize:2});assert.deepEqual(paginate([],3,2),{items:[],total:0,page:3,pageSize:2});});test('page validation',()=>{for(const pair of [[0,1],[1,0],[1.5,2],[1,NaN],['1',2]])assert.throws(()=>paginate([],pair[0],pair[1]),RangeError);});`,
  E: `import {processRecords} from './pipeline.mjs';test('composed pipeline',()=>{const x=[{id:' a ',name:' A   B ',score:2},{id:'b',name:'B',score:5},{id:'c',name:'C',score:5}];assert.deepEqual(processRecords(x),{items:[{id:'b',name:'B',score:5},{id:'c',name:'C',score:5}],total:3,page:1,pageSize:2});assert.deepEqual(processRecords(x,{page:2,pageSize:2}).items,[{id:'a',name:'A B',score:2}]);assert.equal(x[0].id,' a ');assert.deepEqual(processRecords([]).items,[]);});test('validate beyond selected page',()=>assert.throws(()=>processRecords([{id:'a',name:'A',score:1},{id:'b',name:'B',score:-1}],{pageSize:1}),RangeError));`,
};

export function acceptanceSource(ids: readonly string[]): string {
  return `import {test} from 'node:test';import assert from 'node:assert/strict';\n${[
    ...new Set(ids),
  ]
    .sort()
    .map((id) => {
      const source = CHECKS[id];
      if (!source) throw new Error(`unknown fixture subtask ${id}`);
      return source;
    })
    .join('\n')}\n`;
}
