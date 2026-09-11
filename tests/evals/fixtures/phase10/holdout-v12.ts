/** New business contracts frozen after the legacy holdouts became debugging evidence.
 * Only goal/background are model-visible; references and acceptance stay isolated.
 */
const common = `Create a new modular JavaScript library. The initial repository contains only TASK.md; implementation and test files do not exist yet. Use five ES modules, Node built-in tests and no dependencies or network. Follow EXACTLY the given executionPlan: A/B/C/D are independent implementation assignments; E imports and composes all four. Do not implement another worker's assignment. All functions are pure and must not mutate inputs. Ignore extra object fields unless stated otherwise. Do not invent behavior outside the specified input domains. TESTER writes and commits cumulative *.test.mjs tests and runs node --test --test-reporter=tap. REVIEWER checks the cumulative tested artifact; use the normal Leader completion gate. No server or CLI.`;
const plan = (titles: string[]) => ({
  version: 1,
  subtasks: titles.map((title, index) => ({
    id: 'ABCDE'[index],
    title,
    dependsOn: index === 4 ? ['A', 'B', 'C', 'D'] : [],
  })),
});
const shipmentPlan = plan([
  'Implement baseCost in base.mjs',
  'Implement zoneCharge in zone.mjs',
  'Implement handlingFlags in handling.mjs',
  'Implement couponCredit in coupon.mjs',
  'Compose quoteShipment in quote.mjs',
]);
const availabilityPlan = plan([
  'Implement parseMinute in minute.mjs',
  'Implement unionBlocks in union.mjs',
  'Implement coverageMinutes in coverage.mjs',
  'Implement chooseGaps in gaps.mjs',
  'Compose daySummary in summary.mjs',
]);

export const FRESH_HOLDOUTS = {
  'shipment-quotes': {
    plan: shipmentPlan,
    goal: `${common} executionPlan=${JSON.stringify(shipmentPlan)}
A: base.mjs exports baseCost(weightGrams). Require a safe integer from 1 through 100000 inclusive, otherwise throw RangeError. Return Math.ceil(weightGrams / 500) * 125 integer cents.
B: zone.mjs exports zoneCharge(zone). Exact strings 'local', 'regional', 'remote' return 0, 240, 650 respectively; all other values throw TypeError.
C: handling.mjs exports handlingFlags(options). Require a non-null non-array object with boolean fragile and boolean cold, otherwise throw TypeError. Return a new array containing 'fragile' when true, then 'cold' when true, in that order. Both false returns []. Ignore extra fields.
D: coupon.mjs exports couponCredit(code, subtotalCents). Require a nonnegative safe integer subtotalCents, otherwise RangeError. Exact codes 'NONE', 'SAVE10', 'LESS300' return 0, Math.floor(subtotalCents / 10), Math.min(300, subtotalCents) respectively; invalid code throws TypeError. When both arguments are invalid, validate subtotalCents first.
E: quote.mjs exports quoteShipment(input). Require a non-null non-array object, otherwise TypeError. Input has weightGrams, zone, options, coupon. Use A, B, C, D. Handling costs initially 200 cents per 'fragile' flag plus 450 cents per 'cold' flag. subtotal = base + zone + handling; compute coupon credit on this subtotal. Return exactly {baseCents, zoneCents, handling, handlingCents, creditCents, totalCents: subtotal-creditCents}. Pass required fields to imported functions without inventing defaults. Observe later structured Leader requirements; they may supersede the cold-handling price only.`,
    requirementUpdate:
      '/requirement cold-price ' +
      JSON.stringify({
        story: 'Charge 500 cents for cold handling in quoteShipment instead of the initial 450.',
        acceptance: [
          'Use 500 cents for the cold flag in the composed quote, including the subtotal used to compute coupon credit.',
          'Keep fragile handling at 200 cents and all module APIs and other rules unchanged.',
        ],
        nonGoals: ['Do not change handlingFlags output or the fixed executionPlan.'],
      }),
    background: [
      'Shipment weights use grams.',
      'All returned prices use integer cents.',
      'Coupon credit is computed after handling charges.',
      'Handling flags have a fixed order.',
      'Retain cumulative tests.',
      'Follow the current structured Leader price requirement.',
    ],
    files: ['base.mjs', 'zone.mjs', 'handling.mjs', 'coupon.mjs', 'quote.mjs'],
    tests: `import {test} from 'node:test';import assert from 'node:assert/strict';
import {baseCost} from './base.mjs';import {zoneCharge} from './zone.mjs';import {handlingFlags} from './handling.mjs';import {couponCredit} from './coupon.mjs';import {quoteShipment} from './quote.mjs';
test('weight boundaries',()=>{for(const [w,c] of [[1,125],[499,125],[500,125],[501,250],[1000,250],[100000,25000]])assert.equal(baseCost(w),c);});
test('invalid weights',()=>{for(const w of [0,-1,100001,1.5,NaN,Infinity,'500',null,undefined])assert.throws(()=>baseCost(w),RangeError);});
test('zones',()=>{assert.equal(zoneCharge('local'),0);assert.equal(zoneCharge('regional'),240);assert.equal(zoneCharge('remote'),650);});
test('invalid zones',()=>{for(const z of ['LOCAL',' local','',0,null,undefined])assert.throws(()=>zoneCharge(z),TypeError);});
test('flags ordering and freshness',()=>{const x={fragile:true,cold:true,extra:1},before=structuredClone(x);assert.deepEqual(handlingFlags(x),['fragile','cold']);assert.deepEqual(x,before);assert.notEqual(handlingFlags(x),handlingFlags(x));assert.deepEqual(handlingFlags({fragile:false,cold:false}),[]);assert.deepEqual(handlingFlags({fragile:false,cold:true}),['cold']);assert.deepEqual(handlingFlags({fragile:true,cold:false}),['fragile']);});
test('invalid options',()=>{for(const x of [null,[],{},true,{fragile:true},{fragile:1,cold:false},{fragile:false,cold:'false'}])assert.throws(()=>handlingFlags(x),TypeError);});
test('coupon calculation',()=>{assert.equal(couponCredit('NONE',1000),0);assert.equal(couponCredit('SAVE10',999),99);assert.equal(couponCredit('LESS300',125),125);assert.equal(couponCredit('LESS300',1000),300);for(const c of ['NONE','SAVE10','LESS300'])assert.equal(couponCredit(c,0),0);});
test('invalid coupon inputs and precedence',()=>{for(const n of [-1,0.5,NaN,Infinity,'10',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>couponCredit('NONE',n),RangeError);for(const c of ['',null,'none'])assert.throws(()=>couponCredit(c,0),TypeError);assert.throws(()=>couponCredit('bad',-1),RangeError);});
test('basic quote',()=>{assert.deepEqual(quoteShipment({weightGrams:1,zone:'local',options:{fragile:false,cold:false},coupon:'NONE'}),{baseCents:125,zoneCents:0,handling:[],handlingCents:0,creditCents:0,totalCents:125});});
test('updated cold price and subtotal coupon',()=>{const x={weightGrams:501,zone:'regional',options:{fragile:true,cold:true},coupon:'SAVE10'},before=structuredClone(x);assert.deepEqual(quoteShipment(x),{baseCents:250,zoneCents:240,handling:['fragile','cold'],handlingCents:700,creditCents:119,totalCents:1071});assert.deepEqual(x,before);});
test('credit saturation and remote handling',()=>{assert.equal(quoteShipment({weightGrams:500,zone:'local',options:{fragile:false,cold:false},coupon:'LESS300'}).totalCents,0);assert.deepEqual(quoteShipment({weightGrams:500,zone:'remote',options:{fragile:false,cold:true},coupon:'NONE'}),{baseCents:125,zoneCents:650,handling:['cold'],handlingCents:500,creditCents:0,totalCents:1275});});
test('composed validation',()=>{for(const x of [null,[],false])assert.throws(()=>quoteShipment(x),TypeError);const x={weightGrams:1,zone:'local',options:{fragile:false,cold:false},coupon:'NONE'};assert.throws(()=>quoteShipment({...x,weightGrams:0}),RangeError);assert.throws(()=>quoteShipment({...x,zone:'bad'}),TypeError);assert.throws(()=>quoteShipment({...x,options:{}}),TypeError);assert.throws(()=>quoteShipment({...x,coupon:'bad'}),TypeError);});
`,
    reference: {
      'base.mjs': `export function baseCost(w){if(!Number.isSafeInteger(w)||w<1||w>100000)throw new RangeError();return Math.ceil(w/500)*125;}`,
      'zone.mjs': `export function zoneCharge(z){if(z==='local')return 0;if(z==='regional')return 240;if(z==='remote')return 650;throw new TypeError();}`,
      'handling.mjs': `export function handlingFlags(x){if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.fragile!=='boolean'||typeof x.cold!=='boolean')throw new TypeError();return [...(x.fragile?['fragile']:[]),...(x.cold?['cold']:[])];}`,
      'coupon.mjs': `export function couponCredit(c,n){if(!Number.isSafeInteger(n)||n<0)throw new RangeError();if(c==='NONE')return 0;if(c==='SAVE10')return Math.floor(n/10);if(c==='LESS300')return Math.min(300,n);throw new TypeError();}`,
      'quote.mjs': `import{baseCost}from'./base.mjs';import{zoneCharge}from'./zone.mjs';import{handlingFlags}from'./handling.mjs';import{couponCredit}from'./coupon.mjs';export function quoteShipment(x){if(!x||typeof x!=='object'||Array.isArray(x))throw new TypeError();const baseCents=baseCost(x.weightGrams),zoneCents=zoneCharge(x.zone),handling=handlingFlags(x.options),handlingCents=(handling.includes('fragile')?200:0)+(handling.includes('cold')?500:0),subtotal=baseCents+zoneCents+handlingCents,creditCents=couponCredit(x.coupon,subtotal);return{baseCents,zoneCents,handling,handlingCents,creditCents,totalCents:subtotal-creditCents};}`,
    },
  },
  'daily-availability': {
    plan: availabilityPlan,
    goal: `${common} executionPlan=${JSON.stringify(availabilityPlan)}
A: minute.mjs exports parseMinute(value). Require an exact five-character HH:MM string with two decimal digits per component, hour 00..23 and minute 00..59. Invalid input throws TypeError. Return hour*60+minute.
B: union.mjs exports unionBlocks(blocks). Require an array of two-element arrays [start,end], with integer 0<=start<end<=1440, otherwise TypeError. Return a new array of new pairs, sorted by start, merging all overlapping OR touching intervals. Empty returns []. Never mutate input arrays.
C: coverage.mjs exports coverageMinutes(blocks). Given VALID sorted disjoint intervals already returned by B, sum end-start. Empty returns 0. No additional validation behavior is required.
D: gaps.mjs exports chooseGaps(blocks, minimum). Given VALID sorted disjoint intervals from B and integer minimum from 1 through 1440, return the complement gaps inside [0,1440] whose length is >=minimum, sorted by start as new [start,end] pairs. Invalid minimum throws RangeError. Empty blocks and minimum 1440 returns [[0,1440]].
E: summary.mjs exports daySummary(events, minimum). Require events to be an array of non-null non-array objects with start and end strings accepted by A, otherwise TypeError. Convert each event to a minute interval; end must be strictly greater than start, otherwise TypeError (overnight events are invalid). Use A/B/C/D and return exactly {busy: merged intervals, minutes: total covered minutes, available: selected complement gaps}. Preserve the original events. For empty events use the full-day complement.`,
    background: [
      'A day contains 1440 minutes.',
      'Input time strings never use 24:00.',
      'Busy intervals merge when they touch.',
      'Only sufficiently long free gaps are returned.',
      'Pure functions preserve all input arrays.',
      'Preserve cumulative tests across both waves.',
    ],
    files: ['minute.mjs', 'union.mjs', 'coverage.mjs', 'gaps.mjs', 'summary.mjs'],
    tests: String.raw`import {test} from 'node:test';import assert from 'node:assert/strict';
import{parseMinute}from'./minute.mjs';import{unionBlocks}from'./union.mjs';import{coverageMinutes}from'./coverage.mjs';import{chooseGaps}from'./gaps.mjs';import{daySummary}from'./summary.mjs';
test('time boundaries',()=>{for(const [s,n]of [['00:00',0],['01:05',65],['12:30',750],['23:59',1439]])assert.equal(parseMinute(s),n);});
test('invalid time formats',()=>{for(const s of ['1:05','01:5','24:00','23:60','-1:00','01:00 ',' 01:00','01:00\n','',null,65])assert.throws(()=>parseMinute(s),TypeError);});
test('merge overlap touching duplicate and order',()=>{const x=[[50,60],[10,20],[20,40],[15,30],[10,20],[55,70]],before=structuredClone(x);assert.deepEqual(unionBlocks(x),[[10,40],[50,70]]);assert.deepEqual(x,before);const y=[[0,1440]],z=unionBlocks(y);assert.notEqual(y,z);assert.notEqual(y[0],z[0]);assert.deepEqual(unionBlocks([]),[]);});
test('invalid blocks',()=>{for(const x of [null,{},[null],[[]],[[0]],[[0,1,2]],[[-1,2]],[[2,2]],[[2,1]],[[0,1441]],[[0,1.5]],[['0',1]]])assert.throws(()=>unionBlocks(x),TypeError);});
test('coverage',()=>{assert.equal(coverageMinutes([]),0);assert.equal(coverageMinutes([[0,10],[20,40]]),30);assert.equal(coverageMinutes([[0,1440]]),1440);});
test('gap thresholds and endpoints',()=>{const x=[[100,200],[300,400]],before=structuredClone(x);assert.deepEqual(chooseGaps(x,100),[[0,100],[200,300],[400,1440]]);assert.deepEqual(chooseGaps(x,101),[[400,1440]]);assert.deepEqual(x,before);assert.deepEqual(chooseGaps([],1440),[[0,1440]]);assert.deepEqual(chooseGaps([[0,1440]],1),[]);});
test('invalid minimum',()=>{for(const n of [0,-1,1441,1.2,NaN,'1',undefined])assert.throws(()=>chooseGaps([],n),RangeError);});
test('composed unsorted overlapping events',()=>{const x=[{start:'12:00',end:'13:00'},{start:'09:00',end:'10:30'},{start:'10:30',end:'11:00'},{start:'09:30',end:'10:00'}],before=structuredClone(x);assert.deepEqual(daySummary(x,60),{busy:[[540,660],[720,780]],minutes:180,available:[[0,540],[660,720],[780,1440]]});assert.deepEqual(x,before);});
test('empty day',()=>{assert.deepEqual(daySummary([],1440),{busy:[],minutes:0,available:[[0,1440]]});});
test('invalid events',()=>{for(const x of [null,{},[null],[[]],[{}],[{start:'10:00',end:'10:00'}],[{start:'23:00',end:'01:00'}],[{start:'24:00',end:'23:59'}]])assert.throws(()=>daySummary(x,1),TypeError);});
test('end of day and composed minimum',()=>{assert.deepEqual(daySummary([{start:'00:00',end:'23:59'}],1),{busy:[[0,1439]],minutes:1439,available:[[1439,1440]]});assert.deepEqual(daySummary([{start:'00:00',end:'23:59'}],2).available,[]);assert.throws(()=>daySummary([],0),RangeError);});
`,
    reference: {
      'minute.mjs': `export function parseMinute(s){if(typeof s!=='string'||s.length!==5||!/^\\d{2}:\\d{2}$/.test(s))throw new TypeError();const h=Number(s.slice(0,2)),m=Number(s.slice(3));if(h>23||m>59)throw new TypeError();return h*60+m;}`,
      'union.mjs': `export function unionBlocks(xs){if(!Array.isArray(xs)||xs.some(x=>!Array.isArray(x)||x.length!==2||!Number.isInteger(x[0])||!Number.isInteger(x[1])||x[0]<0||x[0]>=x[1]||x[1]>1440))throw new TypeError();const out=[];for(const [s,e]of xs.map(x=>[...x]).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&s<=last[1])last[1]=Math.max(last[1],e);else out.push([s,e]);}return out;}`,
      'coverage.mjs': `export function coverageMinutes(xs){return xs.reduce((n,[s,e])=>n+e-s,0);}`,
      'gaps.mjs': `export function chooseGaps(xs,n){if(!Number.isInteger(n)||n<1||n>1440)throw new RangeError();const out=[];let cursor=0;for(const[s,e]of xs){if(s-cursor>=n)out.push([cursor,s]);cursor=e;}if(1440-cursor>=n)out.push([cursor,1440]);return out;}`,
      'summary.mjs': `import{parseMinute}from'./minute.mjs';import{unionBlocks}from'./union.mjs';import{coverageMinutes}from'./coverage.mjs';import{chooseGaps}from'./gaps.mjs';export function daySummary(xs,n){if(!Array.isArray(xs))throw new TypeError();const raw=xs.map(x=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new TypeError();const s=parseMinute(x.start),e=parseMinute(x.end);if(e<=s)throw new TypeError();return[s,e];});const busy=unionBlocks(raw);return{busy,minutes:coverageMinutes(busy),available:chooseGaps(busy,n)};}`,
    },
  },
} as const;
