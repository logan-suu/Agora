import { FRESH_HOLDOUTS } from './holdout-v12';
import { REPLACEMENT_HOLDOUTS } from './holdout-v13';
import { THERMAL_HOLDOUT } from './holdout-v14';

/** Freeze before model exposure. References and acceptance code never enter agent workspaces. */
const common = `Build a modular API system using five independent ES modules and Node built-in tests, with no dependencies or network. Use EXACTLY the specified executionPlan; do not rename or split subtasks. A/B/C/D are independent, E imports and composes all four. Preserve cumulative tests. TESTER must write and commit *.test.mjs tests and run node --test --test-reporter=tap. REVIEWER reviews the cumulative verified artifact; completion requires the normal Leader gate. Pure functions must not mutate inputs. Invalid inputs specified below must throw the specified error. Do not add a server or CLI.`;
function plan(titles: string[]) {
  return {
    version: 1,
    subtasks: titles.map((title, i) => ({
      id: 'ABCDE'[i],
      title,
      dependsOn: i === 4 ? ['A', 'B', 'C', 'D'] : [],
    })),
  };
}
const orderPlan = plan([
  'Implement validateOrders in validate.mjs',
  'Implement normalizeOrder in normalize.mjs',
  'Implement latestOrders in dedupe.mjs',
  'Implement flagsFor in flags.mjs',
  'Compose auditOrders in audit.mjs',
]);
const shiftPlan = plan([
  'Implement normalizeShift in normalize.mjs',
  'Implement overlaps in overlap.mjs',
  'Implement qualified in skills.mjs',
  'Implement groupShifts in groups.mjs',
  'Compose reportShifts in report.mjs',
]);

export const LEGACY_HOLDOUTS = {
  'order-audit': {
    plan: orderPlan,
    goal: `${common} executionPlan=${JSON.stringify(orderPlan)}
A: validate.mjs exports validateOrders(rows). rows must be an array. Every row must be a non-null non-array object with non-empty trimmed string id, string amount matching /^-?\\d+\\.\\d{2}$/ whose integer cents fit Number.isSafeInteger, and string at in exact YYYY-MM-DDTHH:mm:ss.sssZ form whose Date ISO round-trip equals the input. Invalid shape/field throws TypeError. Return rows unchanged by identity; ignore extra fields. Empty array is valid.
B: normalize.mjs exports normalizeOrder(row). Given one VALID row from A, return exactly {id:row.id.trim(),cents:Math.round(Number(row.amount)*100),timeMs:Date.parse(row.at)}. Do not mutate row.
C: dedupe.mjs exports latestOrders(rows). Given normalized rows, retain one per id with greatest timeMs; on equal timeMs retain the LAST occurrence. Return a new array in the order ids FIRST appeared. Empty returns [].
D: flags.mjs exports flagsFor(cents). For finite safe integer cents, return ['refund'] for negative, ['zero'] for zero, ['large'] for >=10000, otherwise []; invalid values throw RangeError.
E: audit.mjs exports auditOrders(rows). Validate ALL rows first, normalize every row, deduplicate, and return {rows: latest.map(r=>({...r,flags:flagsFor(r.cents)})),totalCents:sum of retained cents}. Use all four imported modules. Initially preserve the dedupe encounter order. Observe any later structured Leader requirement before final completion; it supersedes this presentation-order clause only. Empty input returns {rows:[],totalCents:0}.`,
    requirementUpdate:
      '/requirement audit-order ' +
      JSON.stringify({
        story:
          'Return final audit rows sorted by id ascending using JavaScript code-unit comparison.',
        acceptance: [
          'auditOrders must sort its final rows by trimmed id ascending, regardless of input order; latestOrders itself retains first-encounter order.',
          'All validation, deduplication, flags and totals remain unchanged.',
        ],
        nonGoals: ['Do not change module APIs or the fixed executionPlan.'],
      }),
    background: [
      'Amounts are exact two-decimal strings; no currency conversion is needed.',
      'UTC timestamps must round-trip without normalization.',
      'Deduplication ties select the last occurrence.',
      'Empty batches are valid.',
      'Retain cumulative module tests.',
      'Follow the latest structured Leader requirement.',
    ],
    files: ['validate.mjs', 'normalize.mjs', 'dedupe.mjs', 'flags.mjs', 'audit.mjs'],
    tests: `import {test} from 'node:test';import assert from 'node:assert/strict';import {validateOrders} from './validate.mjs';import {normalizeOrder} from './normalize.mjs';import {latestOrders} from './dedupe.mjs';import {flagsFor} from './flags.mjs';import {auditOrders} from './audit.mjs';
const t='2026-01-01T00:00:00.000Z'; const row=(id,amount='1.00',at=t)=>({id,amount,at});
test('validation identity and empty',()=>{const x=[row(' x ')];assert.equal(validateOrders(x),x);assert.deepEqual(validateOrders([]),[]);});
test('invalid shapes',()=>{for(const x of [null,{},[null],[[]],[row(' ')],[row(1)],[{id:'x',amount:1,at:t}]])assert.throws(()=>validateOrders(x),TypeError);});
test('invalid amounts',()=>{for(const a of ['1','1.0','1.000',' 1.00','+1.00','NaN','Infinity','9007199254740992.00'])assert.throws(()=>validateOrders([row('x',a)]),TypeError);});
test('invalid dates',()=>{for(const at of ['2026-02-30T00:00:00.000Z','2026-01-01','2026-01-01T00:00:00Z','x'])assert.throws(()=>validateOrders([row('x','1.00',at)]),TypeError);});
test('normalization',()=>{const x={...row(' x ','-1.25'),extra:true};assert.deepEqual(normalizeOrder(x),{id:'x',cents:-125,timeMs:Date.parse(t)});assert.equal(x.id,' x ');});
test('dedupe latest tie and order',()=>{const x=[{id:'b',cents:1,timeMs:2},{id:'a',cents:2,timeMs:1},{id:'b',cents:3,timeMs:1},{id:'a',cents:4,timeMs:1}];const before=structuredClone(x);assert.deepEqual(latestOrders(x),[x[0],x[3]]);assert.deepEqual(x,before);assert.deepEqual(latestOrders([]),[]);});
test('flags boundaries',()=>{for(const [n,f] of [[-1,['refund']],[0,['zero']],[1,[]],[9999,[]],[10000,['large']]])assert.deepEqual(flagsFor(n),f);});
test('invalid flag input',()=>{for(const n of ['1',1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>flagsFor(n),RangeError);});
test('updated sorted audit and totals',()=>{const x=[row(' b ','100.00'),row('a','1.00'),row('a','-2.00','2026-01-02T00:00:00.000Z')];const before=structuredClone(x);const out=auditOrders(x);assert.deepEqual(out,{rows:[{id:'a',cents:-200,timeMs:Date.parse(x[2].at),flags:['refund']},{id:'b',cents:10000,timeMs:Date.parse(t),flags:['large']}],totalCents:9800});assert.deepEqual(x,before);});
test('audit empty and invalid discarded duplicate',()=>{assert.deepEqual(auditOrders([]),{rows:[],totalCents:0});assert.throws(()=>auditOrders([row('a','bad'),row('a')]),TypeError);});
`,
    reference: {
      'validate.mjs': `export function validateOrders(rows){if(!Array.isArray(rows))throw new TypeError('rows');for(const r of rows){if(!r||Array.isArray(r)||typeof r!=='object'||typeof r.id!=='string'||!r.id.trim()||typeof r.amount!=='string'||! /^-?\\d+\\.\\d{2}$/.test(r.amount)||!Number.isSafeInteger(Math.round(Number(r.amount)*100))||typeof r.at!=='string'||!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(r.at)||!Number.isFinite(Date.parse(r.at))||new Date(r.at).toISOString()!==r.at)throw new TypeError('row');}return rows;}`,
      'normalize.mjs': `export function normalizeOrder(r){return {id:r.id.trim(),cents:Math.round(Number(r.amount)*100),timeMs:Date.parse(r.at)};}`,
      'dedupe.mjs': `export function latestOrders(rows){const m=new Map();for(const r of rows){if(!m.has(r.id)||r.timeMs>=m.get(r.id).timeMs)m.set(r.id,r);}return [...m.values()];}`,
      'flags.mjs': `export function flagsFor(n){if(!Number.isSafeInteger(n))throw new RangeError('cents');return n<0?['refund']:n===0?['zero']:n>=10000?['large']:[];}`,
      'audit.mjs': `import {validateOrders} from './validate.mjs';import {normalizeOrder} from './normalize.mjs';import {latestOrders} from './dedupe.mjs';import {flagsFor} from './flags.mjs';export function auditOrders(input){const rows=latestOrders(validateOrders(input).map(normalizeOrder)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(r=>({...r,flags:flagsFor(r.cents)}));return {rows,totalCents:rows.reduce((n,r)=>n+r.cents,0)};}`,
    },
  },
  'shift-conflicts': {
    plan: shiftPlan,
    goal: `${common} executionPlan=${JSON.stringify(shiftPlan)}
A: normalize.mjs exports normalizeShift(row). Require non-null non-array object with non-empty trimmed string id/person, integer minutes 0<=start<end<=1440, and required array of non-empty trimmed strings. Invalid input throws TypeError. Return exactly {id,person,start,end,required}, trimming strings and deduplicating required skills in first-encounter order.
B: overlap.mjs exports overlaps(a,b) for valid {start,end} intervals. Return true iff half-open intervals intersect with positive length; touching endpoints do not overlap.
C: skills.mjs exports qualified(required,available), for arrays of skill strings. Return true iff every required skill occurs in available. Extra/duplicate skills do not affect the result; empty required is always qualified.
D: groups.mjs exports groupShifts(shifts) for normalized shifts. Return array of {person,shifts} grouped by exact person, groups sorted by JavaScript code-unit person order, preserving shift input order inside each group. Do not mutate inputs; support arbitrary person keys such as __proto__.
E: report.mjs exports reportShifts(rows,skillsByPerson={}). Normalize ALL rows; duplicate trimmed shift id throws RangeError. Use groupShifts, overlaps and qualified. Return {conflicts,unqualified}. conflicts contains exactly one {person,left,right} for each overlapping pair belonging to the SAME person, with left/right set to their lexicographically smaller/larger id; sort conflicts by person then left then right using code-unit comparison. unqualified lists ids of shifts missing at least one required skill, sorted ascending. skillsByPerson maps exact person names to arrays of skills; missing OWN entries mean []. Do not treat inherited properties as skills. Empty input gives empty arrays.`,
    background: [
      'Intervals are half open; adjacent shifts do not conflict.',
      'Qualifications require every listed skill.',
      'A person can have multiple overlapping shifts.',
      'Keep each conflicting pair exactly once.',
      'The final report must be deterministic regardless of input order.',
      'Only the Leader completion decision authorizes finalization.',
    ],
    files: ['normalize.mjs', 'overlap.mjs', 'skills.mjs', 'groups.mjs', 'report.mjs'],
    tests: `import {test} from 'node:test';import assert from 'node:assert/strict';import {normalizeShift} from './normalize.mjs';import {overlaps} from './overlap.mjs';import {qualified} from './skills.mjs';import {groupShifts} from './groups.mjs';import {reportShifts} from './report.mjs';const row=(id,person='p',start=10,end=20,required=[])=>({id,person,start,end,required});
test('normalization immutability',()=>{const x=row(' a ',' p ',0,1440,[' x ','x','y']);assert.deepEqual(normalizeShift(x),row('a','p',0,1440,['x','y']));assert.equal(x.id,' a ');});
test('invalid shapes and intervals',()=>{for(const x of [null,[],{},row(' '),row('a',' '),row('a','p',-1,2),row('a','p',1,1),row('a','p',2,1),row('a','p',0,1441),row('a','p',1.5,2),row('a','p',1,2,[' ']),row('a','p',1,2,[1])])assert.throws(()=>normalizeShift(x),TypeError);});
test('half-open intervals',()=>{assert.equal(overlaps(row('a','p',0,10),row('b','p',10,20)),false);assert.equal(overlaps(row('a','p',0,11),row('b','p',10,20)),true);assert.equal(overlaps(row('a','p',0,100),row('b','p',10,20)),true);assert.equal(overlaps(row('a','p',50,60),row('b','p',0,20)),false);});
test('qualification sets',()=>{assert.equal(qualified([],[]),true);assert.equal(qualified(['a','a'],['a','b']),true);assert.equal(qualified(['a','b'],['a']),false);});
test('groups order and prototype keys',()=>{const x=[row('b','z'),row('a','__proto__'),row('c','z')];const before=structuredClone(x);assert.deepEqual(groupShifts(x),[{person:'__proto__',shifts:[x[1]]},{person:'z',shifts:[x[0],x[2]]}]);assert.deepEqual(x,before);assert.deepEqual(groupShifts([]),[]);});
test('canonical pair report and missing skills',()=>{const x=[row('z','p',0,20,['n']),row('a','p',10,30,['n','s']),row('b','p',20,40),row('x','q',0,40)];const before=structuredClone(x);const expected={conflicts:[{person:'p',left:'a',right:'b'},{person:'p',left:'a',right:'z'}],unqualified:['a']};assert.deepEqual(reportShifts(x,{p:['n']}),expected);assert.deepEqual(reportShifts([...x].reverse(),{p:['n']}),expected);assert.deepEqual(x,before);});
test('own skills and empty report',()=>{assert.deepEqual(reportShifts([]),{conflicts:[],unqualified:[]});assert.deepEqual(reportShifts([row('a','p',1,2,['n'])],Object.create({p:['n']})),{conflicts:[],unqualified:['a']});});
test('duplicate id and invalid row',()=>{assert.throws(()=>reportShifts([row(' a '),row('a','q')]),RangeError);assert.throws(()=>reportShifts([row('a'),null]),TypeError);});
`,
    reference: {
      'normalize.mjs': `export function normalizeShift(r){if(!r||Array.isArray(r)||typeof r!=='object'||typeof r.id!=='string'||!r.id.trim()||typeof r.person!=='string'||!r.person.trim()||!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.start>=r.end||r.end>1440||!Array.isArray(r.required)||r.required.some(s=>typeof s!=='string'||!s.trim()))throw new TypeError('shift');return {id:r.id.trim(),person:r.person.trim(),start:r.start,end:r.end,required:[...new Set(r.required.map(s=>s.trim()))]};}`,
      'overlap.mjs': `export function overlaps(a,b){return a.start<b.end&&b.start<a.end;}`,
      'skills.mjs': `export function qualified(required,available){return required.every(s=>available.includes(s));}`,
      'groups.mjs': `export function groupShifts(rows){const m=new Map();for(const r of rows){if(!m.has(r.person))m.set(r.person,[]);m.get(r.person).push(r);}return [...m].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([person,shifts])=>({person,shifts}));}`,
      'report.mjs': `import {normalizeShift} from './normalize.mjs';import {overlaps} from './overlap.mjs';import {qualified} from './skills.mjs';import {groupShifts} from './groups.mjs';export function reportShifts(input,skills={}){const rows=input.map(normalizeShift);if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new RangeError('duplicate');const conflicts=[];for(const {person,shifts} of groupShifts(rows))for(let i=0;i<shifts.length;i++)for(let j=i+1;j<shifts.length;j++)if(overlaps(shifts[i],shifts[j])){const [left,right]=[shifts[i].id,shifts[j].id].sort();conflicts.push({person,left,right});}const cmp=(a,b)=>a<b?-1:a>b?1:0;conflicts.sort((a,b)=>cmp(a.person,b.person)||cmp(a.left,b.left)||cmp(a.right,b.right));return {conflicts,unqualified:rows.filter(r=>!qualified(r.required,Object.hasOwn(skills,r.person)?skills[r.person]:[])).map(r=>r.id).sort()};}`,
    },
  },
} as const;
export const HOLDOUTS = {
  ...LEGACY_HOLDOUTS,
  ...FRESH_HOLDOUTS,
  ...REPLACEMENT_HOLDOUTS,
  ...THERMAL_HOLDOUT,
} as const;
export type HoldoutName = keyof typeof HOLDOUTS;
