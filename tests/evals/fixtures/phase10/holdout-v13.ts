import { FRESH_HOLDOUTS as PREVIOUS_HOLDOUTS } from './holdout-v12';

/** The shipment pilot is development evidence. This replacement has not seen model I/O. */
const inventoryPlan = {
  version: 1,
  subtasks: [
    { id: 'A', title: 'Implement validateRows in validate.mjs', dependsOn: [] },
    { id: 'B', title: 'Implement restockUnits in units.mjs', dependsOn: [] },
    { id: 'C', title: 'Implement unitPrice in price.mjs', dependsOn: [] },
    { id: 'D', title: 'Implement batchLabel in label.mjs', dependsOn: [] },
    { id: 'E', title: 'Compose restockPlan in plan.mjs', dependsOn: ['A', 'B', 'C', 'D'] },
  ],
};
export const REPLACEMENT_HOLDOUTS = {
  'inventory-restock': {
    plan: inventoryPlan,
    goal: `Build a modular JavaScript API library. The initial repository contains only TASK.md; implementation and test files do not exist yet. Use five ES modules, no dependencies or network, and exactly this executionPlan: ${JSON.stringify(inventoryPlan)}. A/B/C/D are independent implementation assignments; E imports all four. Implement only the assigned subtask. All functions must preserve inputs and ignore extra object fields. Do not invent unspecified behavior. TESTER commits cumulative *.test.mjs tests and runs node --test --test-reporter=tap. REVIEWER checks the cumulative validated artifact and uses the normal Leader completion gate. No server or CLI.
A: validate.mjs exports validateRows(rows). Require an array. Each row must be a non-null non-array object with a string sku whose trimmed value is nonempty; integer onHand and target each from 0 through 1000000; integer packSize from 1 through 1000000; and exact category 'standard', 'chilled', or 'hazardous'. Duplicate trimmed sku values are invalid; comparison is case-sensitive. Any invalid input throws TypeError. Return the original rows array unchanged by identity. Empty array is valid.
B: units.mjs exports restockUnits(onHand, target, packSize). Validate all three arguments against the same numeric ranges as A, but throw RangeError for invalid arguments. Return 0 if onHand>=target; otherwise return Math.ceil((target-onHand)/packSize)*packSize. Validate packSize even when no restocking is needed.
C: price.mjs exports unitPrice(category). Exact categories 'standard', 'chilled', 'hazardous' return 125, 210, 480 integer cents respectively; any other value throws TypeError.
D: label.mjs exports batchLabel(units). Require integer units from 0 through 2000000, otherwise RangeError. Initially return 'none' for 0, 'parcel' for 1..9, and 'freight' for >=10. Follow any later structured Leader requirement superseding this labeling threshold.
E: plan.mjs exports restockPlan(rows). Validate ALL rows via A before computing results. For each row in original order use B, C, D and return exactly {items:[{sku:row.sku.trim(),units,unitCents,costCents:units*unitCents,label}],totalCents:sum of costCents}. Include zero-unit items. Empty rows returns {items:[],totalCents:0}. No automatic defaults. Observe current structured Leader requirements.`,
    requirementUpdate:
      '/requirement freight-threshold ' +
      JSON.stringify({
        story: 'Change batchLabel to use freight only for 20 units or more.',
        acceptance: [
          'batchLabel returns none for 0, parcel for 1 through 19 inclusive, and freight for 20 through 2000000.',
          'restockPlan must reflect the updated imported label function. All validation, rounding, prices and ordering remain unchanged.',
        ],
        nonGoals: ['Do not change exported APIs or the five-subtask executionPlan.'],
      }),
    background: [
      'Stock counts are integers.',
      'Restock quantities round upward to a whole pack.',
      'Duplicate trimmed SKU values are rejected.',
      'Original row order is retained.',
      'Keep cumulative tests.',
      'Follow the current structured Leader labeling threshold.',
    ],
    files: ['validate.mjs', 'units.mjs', 'price.mjs', 'label.mjs', 'plan.mjs'],
    tests: `import{test}from'node:test';import assert from'node:assert/strict';import{validateRows}from'./validate.mjs';import{restockUnits}from'./units.mjs';import{unitPrice}from'./price.mjs';import{batchLabel}from'./label.mjs';import{restockPlan}from'./plan.mjs';
const row=(sku='x',extra={})=>({sku,onHand:1,target:10,packSize:4,category:'standard',...extra});
test('validation identity and empty',()=>{const x=[row()],before=structuredClone(x);assert.equal(validateRows(x),x);assert.deepEqual(x,before);const e=[];assert.equal(validateRows(e),e);});
test('invalid shapes and fields',()=>{for(const x of [null,{},[null],[[]],[{}],[row(' ')],[row(1)],[row('x',{onHand:-1})],[row('x',{target:1.5})],[row('x',{packSize:0})],[row('x',{category:'STANDARD'})],[row('x',{onHand:'1'})],[row('x',{target:1000001})],[row('x',{packSize:1000001})]])assert.throws(()=>validateRows(x),TypeError);});
test('duplicate sku normalization and case',()=>{assert.throws(()=>validateRows([row(' x '),row('x')]),TypeError);assert.equal(validateRows([row('x'),row('X')]).length,2);});
test('restock rounding and boundaries',()=>{for(const [a,b,p,n]of [[1,10,4,12],[10,10,3,0],[12,10,3,0],[0,1,1,1],[0,1000000,999999,1999998],[1000000,0,1000000,0]])assert.equal(restockUnits(a,b,p),n);});
test('invalid restock arguments even for zero need',()=>{for(const x of [[-1,0,1],[0,-1,1],[0,1,0],[1,1,0],[0,1,1.5],[0,1000001,1],[0,1,1000001],[NaN,0,1],[0,Infinity,1],[0,1,'2']])assert.throws(()=>restockUnits(...x),RangeError);});
test('unit prices',()=>{assert.equal(unitPrice('standard'),125);assert.equal(unitPrice('chilled'),210);assert.equal(unitPrice('hazardous'),480);for(const c of ['',null,'Standard',1])assert.throws(()=>unitPrice(c),TypeError);});
test('updated labels',()=>{for(const [n,label]of [[0,'none'],[1,'parcel'],[9,'parcel'],[10,'parcel'],[19,'parcel'],[20,'freight'],[2000000,'freight']])assert.equal(batchLabel(n),label);});
test('invalid label inputs',()=>{for(const n of [-1,2000001,1.5,NaN,Infinity,'1',undefined])assert.throws(()=>batchLabel(n),RangeError);});
test('composition prices and updated threshold',()=>{const x=[row(' b '),row('a',{onHand:0,target:21,packSize:10,category:'chilled'})],before=structuredClone(x);assert.deepEqual(restockPlan(x),{items:[{sku:'b',units:12,unitCents:125,costCents:1500,label:'parcel'},{sku:'a',units:30,unitCents:210,costCents:6300,label:'freight'}],totalCents:7800});assert.deepEqual(x,before);});
test('zero items and empty plan',()=>{assert.deepEqual(restockPlan([]),{items:[],totalCents:0});assert.deepEqual(restockPlan([row('z',{onHand:10,target:0,category:'hazardous'})]),{items:[{sku:'z',units:0,unitCents:480,costCents:0,label:'none'}],totalCents:0});});
test('composed validation',()=>{assert.throws(()=>restockPlan([row('x'),row(' x ')]),TypeError);assert.throws(()=>restockPlan([row('x'),row('y',{target:NaN})]),TypeError);assert.throws(()=>restockPlan(null),TypeError);});
`,
    reference: {
      'validate.mjs': `const int=(n,a,b)=>Number.isInteger(n)&&n>=a&&n<=b;export function validateRows(xs){if(!Array.isArray(xs))throw new TypeError();const seen=new Set();for(const x of xs){if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.sku!=='string'||!x.sku.trim()||!int(x.onHand,0,1000000)||!int(x.target,0,1000000)||!int(x.packSize,1,1000000)||!['standard','chilled','hazardous'].includes(x.category)||seen.has(x.sku.trim()))throw new TypeError();seen.add(x.sku.trim());}return xs;}`,
      'units.mjs': `export function restockUnits(a,b,p){if(!Number.isInteger(a)||a<0||a>1000000||!Number.isInteger(b)||b<0||b>1000000||!Number.isInteger(p)||p<1||p>1000000)throw new RangeError();return a>=b?0:Math.ceil((b-a)/p)*p;}`,
      'price.mjs': `export function unitPrice(c){if(c==='standard')return 125;if(c==='chilled')return 210;if(c==='hazardous')return 480;throw new TypeError();}`,
      'label.mjs': `export function batchLabel(n){if(!Number.isInteger(n)||n<0||n>2000000)throw new RangeError();return n===0?'none':n>=20?'freight':'parcel';}`,
      'plan.mjs': `import{validateRows}from'./validate.mjs';import{restockUnits}from'./units.mjs';import{unitPrice}from'./price.mjs';import{batchLabel}from'./label.mjs';export function restockPlan(xs){validateRows(xs);const items=xs.map(x=>{const units=restockUnits(x.onHand,x.target,x.packSize),unitCents=unitPrice(x.category);return{sku:x.sku.trim(),units,unitCents,costCents:units*unitCents,label:batchLabel(units)};});return{items,totalCents:items.reduce((n,x)=>n+x.costCents,0)};}`,
    },
  },
  // This task has not had a model attempt; only its routing vocabulary changes.
  'daily-availability': {
    ...PREVIOUS_HOLDOUTS['daily-availability'],
    goal: PREVIOUS_HOLDOUTS['daily-availability'].goal.replace(
      'JavaScript library.',
      'JavaScript API library.',
    ),
  },
} as const;
