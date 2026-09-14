import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {keychainStore} from './local-process.mjs';
const root=fileURLToPath(new URL('./',import.meta.url)),web=resolve(root,'apps/web');
const next=createRequire(resolve(web,'package.json'))('next');
let app,http,token;
const sockets=new Set();
process.on('message',async msg=>{
 try {
 if(msg.type==='start'){
 token=msg.token;
 process.env.AGORA_DATA_ROOT=msg.dataRoot;process.env.NODE_ENV='production';process.env.AGORA_LOCAL_LAUNCH='1';process.env.NEXT_MANUAL_SIG_HANDLE='true';
 let complete;const credentialsReady=new Promise(r=>complete=r);
 globalThis.__agoraLocalBootstrap={system:keychainStore(msg.helper,{keychain:msg.keychain,service:'com.agora.spike.112',account:'spike'}),adopt:false,draining:false,drains:new Set(),credentialsReady:complete};
 const conf=createRequire(import.meta.url)(resolve(web,'.next/required-server-files.json')).config;
 app=next({dev:false,dir:web,hostname:'127.0.0.1',port:0,conf});await app.prepare();await credentialsReady;
 if(globalThis.__agoraLocalBootstrap.credentialStatus!=='ready')throw new Error('credentials not ready');
 const handler=app.getRequestHandler();
 http=createServer((req,res)=>{const origin='http://'+req.headers.host;if(req.headers['x-agora-spike']!==token||req.headers.host!==`127.0.0.1:${http.address().port}`||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}handler(req,res);});
 http.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise((r,j)=>{http.once('error',j);http.listen(0,'127.0.0.1',r);});process.send({type:'ready',port:http.address().port,node:process.version,credentials:globalThis.__agoraLocalBootstrap.credentialStatus});
 }else if(msg.type==='stop'){
 globalThis.__agoraLocalBootstrap.draining=true;
 await Promise.all([...globalThis.__agoraLocalBootstrap.drains].map(f=>f()));
 for(const s of sockets)s.destroy();await new Promise(r=>http.close(r));await app.close();process.send({type:'stopped'});process.disconnect();
 }
 }catch(error){process.send?.({type:'error',message:String(error.message)});process.exitCode=1;}
});
