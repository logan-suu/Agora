// Deterministic native packaging probe. No model or product data is accessed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { copyTracedFile, reviewTraceFile, auditResources } from '../../../apps/desktop/dist/build-resources.js';
import { signValidationBundle } from '../../../apps/desktop/scripts/sign.mjs';
const root = resolve('test-outputs/langgraph-spike-round2');
const source = join(root, 'runtime');
const out = join(root, 'package-probe');
await mkdir(out);
const app = join(out, 'stage/LangGraphProbe.app');
const service = join(app, 'Contents/Resources/service');
await mkdir(service, { recursive: true });
const entrySource = `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import { StateGraph, Annotation, START, END, interrupt, Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
const [mode, db] = process.argv.slice(2);
const counter = db + '.calls.json';
const saver = SqliteSaver.fromConnString(db);
const shape = Annotation.Root({ value: Annotation() });
const graph = new StateGraph(shape).addNode('work',async()=>{
 const calls=existsSync(counter)?JSON.parse(readFileSync(counter,'utf8')):0;
 writeFileSync(counter,JSON.stringify(calls+1)); return {value:42};
}).addNode('gate',async()=>{const receipt=interrupt({reason:'fixture'});assert.equal(receipt,'continue');return {value:43};})
.addEdge(START,'work').addEdge('work','gate').addEdge('gate',END).compile({checkpointer:saver});
const cfg={configurable:{thread_id:'native-package'},durability:'sync'};
try{
 if(mode==='start'){const r=await graph.invoke({value:0},cfg);assert.equal(r.__interrupt__.length,1);}
 else if(mode==='inspect'){assert.deepEqual((await graph.getState(cfg)).next,['gate']);}
 else if(mode==='resume'){await graph.invoke(new Command({resume:'continue'}),cfg);assert.deepEqual((await graph.getState(cfg)).next,[]);}
 else if(mode==='finished'){assert.equal((await graph.getState(cfg)).values.value,43);}
 else throw Error('unknown mode');
 assert.equal(JSON.parse(readFileSync(counter,'utf8')),1);
 console.log(JSON.stringify({mode,pid:process.pid,node:process.version,abi:process.versions.modules,next:(await graph.getState(cfg)).next,calls:1}));
}finally{saver.db.close();}
`;
await writeFile(join(source, 'probe.mjs'), entrySource);
const require = createRequire(resolve('apps/web/package.json'));
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const trace = await nodeFileTrace([join(source, 'probe.mjs')], { base: source, processCwd: source });
const classifications = [];
for (const name of trace.fileList) {
  if (name !== 'probe.mjs') assert.equal(reviewTraceFile(name), 'runtime');
  classifications.push(name);
}
assert(classifications.some(name => name.endsWith('/better_sqlite3.node')));
const sorted = await Promise.all(classifications.map(async name => ({ name, link: (await lstat(join(source, name))).isSymbolicLink() })));
for (const item of sorted.sort((a,b)=>Number(a.link)-Number(b.link))) await copyTracedFile(source, service, join(source,item.name));
const macos = join(app, 'Contents/MacOS'); await mkdir(macos);
const nodeSource = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64/node/bin/node';
const node = join(macos, 'probe-node'); await cp(nodeSource,node);
await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe-node</string><key>CFBundleIdentifier</key><string>local.agora.langgraph.packaging-probe</string><key>CFBundleName</key><string>LangGraphProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
const result = { startedAt: new Date().toISOString(), scope: 'Minimal Node app; production trace allowlist/copy/signing; no Electron UI, notarization or product upgrade', tracedFiles: classifications, warnings: [...trace.warnings].map(w=>w.message), runs: [], sign: await signValidationBundle(app) };
const db = join(out,'external-state.sqlite');
function run(appPath,mode){
 const stdout=execFileSync(join(appPath,'Contents/MacOS/probe-node'),[join(appPath,'Contents/Resources/service/probe.mjs'),mode,db],{cwd:'/private/tmp',encoding:'utf8'});
 result.runs.push({...JSON.parse(stdout.trim()),appPath});
}
run(app,'start');
await writeFile(join(root,'results/package-prepared.json'),JSON.stringify(result,null,2));
