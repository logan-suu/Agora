/** Fresh thermal task; earlier inventory attempts remain development evidence. */
const plan = {
  version: 1,
  subtasks: [
    { id: 'A', title: 'Implement validateReadings in validate.mjs', dependsOn: [] },
    { id: 'B', title: 'Implement fahrenheitTenths in convert.mjs', dependsOn: [] },
    { id: 'C', title: 'Implement excessDose in dose.mjs', dependsOn: [] },
    { id: 'D', title: 'Implement actionForDose in action.mjs', dependsOn: [] },
    { id: 'E', title: 'Compose inspectionReport in report.mjs', dependsOn: ['A', 'B', 'C', 'D'] },
  ],
};

export const THERMAL_HOLDOUT = {
  'thermal-inspection': {
    plan,
    goal: `Build a modular JavaScript API library for a synthetic thermal inspection exercise. The initial repository contains only TASK.md; implementation and test files do not exist yet. Use five ES modules, no dependencies or network, and exactly this executionPlan: ${JSON.stringify(plan)}. A/B/C/D are independent assignments; E imports all four. Implement only the assigned subtask. Preserve inputs, ignore extra object fields, and do not invent unspecified behavior. TESTER commits cumulative *.test.mjs tests and runs node --test --test-reporter=tap. REVIEWER checks the cumulative validated artifact and uses the normal Leader completion gate. No server or CLI.
A: validate.mjs exports validateReadings(readings). Require an array. Each reading must be a non-null non-array object with a string id whose trimmed value is nonempty, integer celsius from -50 through 100, and integer minutes from 0 through 120. Duplicate trimmed id values are invalid; comparison is case-sensitive. Any invalid input throws TypeError. Return the original readings array unchanged by identity. Empty array is valid.
B: convert.mjs exports fahrenheitTenths(celsius). Require integer celsius from -50 through 100, otherwise RangeError. Return celsius*18+320, the exact integer number of tenths of a Fahrenheit degree. Do not return degrees or round to whole degrees.
C: dose.mjs exports excessDose(celsius, minutes). Validate both arguments using the same ranges as A, otherwise RangeError. Return Math.max(0,celsius-30)*minutes. Validate minutes even when celsius<=30. This is a synthetic score, not medical or safety guidance.
D: action.mjs exports actionForDose(dose). Require integer dose from 0 through 8400, otherwise RangeError. Initially return 'none' for 0, 'monitor' for 1 through 199, and 'intervene' for 200 or more. Follow any later structured Leader requirement superseding this threshold.
E: report.mjs exports inspectionReport(readings). Validate ALL readings via A before computing. In original order use B, C and D to return exactly {readings:[{id:reading.id.trim(),celsius:reading.celsius,fahrenheitTenths,dose,action}],totalDose:sum of doses}. Include zero-dose readings. Empty input returns {readings:[],totalDose:0}. No automatic defaults. Observe current structured Leader requirements.`,
    requirementUpdate:
      '/requirement intervention-threshold ' +
      JSON.stringify({
        story: 'Raise the synthetic intervention threshold from 200 to 400 dose units.',
        acceptance: [
          'actionForDose returns none for 0, monitor for 1 through 399 inclusive, and intervene for 400 through 8400.',
          'inspectionReport must use the updated imported action function. Validation, conversion, dose formula and ordering remain unchanged.',
        ],
        nonGoals: ['Do not change exported APIs or the five-subtask executionPlan.'],
      }),
    background: [
      'Temperature inputs are integer Celsius degrees.',
      'Conversion returns integer tenths of Fahrenheit degrees.',
      'Dose counts only the amount above 30 Celsius.',
      'Trimmed identifiers are unique and case-sensitive.',
      'Preserve cumulative tests and input order.',
      'Follow the current structured Leader intervention threshold.',
    ],
    files: ['validate.mjs', 'convert.mjs', 'dose.mjs', 'action.mjs', 'report.mjs'],
    tests: `import{test}from'node:test';import assert from'node:assert/strict';import{validateReadings}from'./validate.mjs';import{fahrenheitTenths}from'./convert.mjs';import{excessDose}from'./dose.mjs';import{actionForDose}from'./action.mjs';import{inspectionReport}from'./report.mjs';
const row=(id='x',extra={})=>({id,celsius:40,minutes:30,...extra});
test('validation identity and empty',()=>{const x=[row()],before=structuredClone(x);assert.equal(validateReadings(x),x);assert.deepEqual(x,before);const e=[];assert.equal(validateReadings(e),e);});
test('invalid reading shapes and fields',()=>{for(const x of [null,{},[null],[[]],[{}],[row(' ')],[row(1)],[row('x',{celsius:-51})],[row('x',{celsius:101})],[row('x',{celsius:1.5})],[row('x',{minutes:-1})],[row('x',{minutes:121})],[row('x',{minutes:'30'})],[row('x',{celsius:NaN})]])assert.throws(()=>validateReadings(x),TypeError);});
test('trimmed identifiers and boundaries',()=>{assert.throws(()=>validateReadings([row(' x '),row('x')]),TypeError);const x=[row('x',{celsius:-50,minutes:0}),row('X',{celsius:100,minutes:120})];assert.equal(validateReadings(x),x);});
test('integer tenths conversion',()=>{for(const [c,f]of [[-50,-580],[-40,-400],[-1,302],[0,320],[1,338],[30,860],[100,2120]])assert.equal(fahrenheitTenths(c),f);});
test('invalid conversion inputs',()=>{for(const c of [-51,101,1.5,NaN,Infinity,'1',null,[1],undefined])assert.throws(()=>fahrenheitTenths(c),RangeError);});
test('dose formula and zero cases',()=>{for(const [c,m,d]of [[-50,120,0],[30,120,0],[31,1,1],[40,30,300],[100,120,8400],[100,0,0]])assert.equal(excessDose(c,m),d);});
test('invalid dose inputs even below threshold',()=>{for(const x of [[-51,0],[101,0],[30,-1],[0,121],[0,1.5],[0,'1'],[NaN,0],[1,Infinity],[null,1]])assert.throws(()=>excessDose(...x),RangeError);});
test('updated action threshold and invalid dose',()=>{for(const [d,a]of [[0,'none'],[1,'monitor'],[199,'monitor'],[200,'monitor'],[399,'monitor'],[400,'intervene'],[8400,'intervene']])assert.equal(actionForDose(d),a);for(const d of [-1,8401,0.5,NaN,Infinity,'1',null,[1],undefined])assert.throws(()=>actionForDose(d),RangeError);});
test('composition preserves order and updated actions',()=>{const x=[row(' b '),row('a',{celsius:50,minutes:20})],before=structuredClone(x);assert.deepEqual(inspectionReport(x),{readings:[{id:'b',celsius:40,fahrenheitTenths:1040,dose:300,action:'monitor'},{id:'a',celsius:50,fahrenheitTenths:1220,dose:400,action:'intervene'}],totalDose:700});assert.deepEqual(x,before);});
test('zero and empty reports',()=>{assert.deepEqual(inspectionReport([]),{readings:[],totalDose:0});assert.deepEqual(inspectionReport([row('z',{celsius:-50,minutes:120})]),{readings:[{id:'z',celsius:-50,fahrenheitTenths:-580,dose:0,action:'none'}],totalDose:0});});
test('composed validation',()=>{assert.throws(()=>inspectionReport([row('x'),row(' x ')]),TypeError);assert.throws(()=>inspectionReport([row('x'),row('y',{minutes:NaN})]),TypeError);assert.throws(()=>inspectionReport(null),TypeError);});
`,
    reference: {
      'validate.mjs': `const int=(n,a,b)=>Number.isInteger(n)&&n>=a&&n<=b;export function validateReadings(xs){if(!Array.isArray(xs))throw new TypeError();const seen=new Set();for(const x of xs){if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.id!=='string'||!x.id.trim()||!int(x.celsius,-50,100)||!int(x.minutes,0,120)||seen.has(x.id.trim()))throw new TypeError();seen.add(x.id.trim());}return xs;}`,
      'convert.mjs': `export function fahrenheitTenths(c){if(!Number.isInteger(c)||c< -50||c>100)throw new RangeError();return c*18+320;}`,
      'dose.mjs': `export function excessDose(c,m){if(!Number.isInteger(c)||c< -50||c>100||!Number.isInteger(m)||m<0||m>120)throw new RangeError();return Math.max(0,c-30)*m;}`,
      'action.mjs': `export function actionForDose(d){if(!Number.isInteger(d)||d<0||d>8400)throw new RangeError();return d===0?'none':d>=400?'intervene':'monitor';}`,
      'report.mjs': `import{validateReadings}from'./validate.mjs';import{fahrenheitTenths}from'./convert.mjs';import{excessDose}from'./dose.mjs';import{actionForDose}from'./action.mjs';export function inspectionReport(xs){validateReadings(xs);const readings=xs.map(x=>{const dose=excessDose(x.celsius,x.minutes);return{id:x.id.trim(),celsius:x.celsius,fahrenheitTenths:fahrenheitTenths(x.celsius),dose,action:actionForDose(dose)};});return{readings,totalDose:readings.reduce((n,x)=>n+x.dose,0)};}`,
    },
  },
} as const;
