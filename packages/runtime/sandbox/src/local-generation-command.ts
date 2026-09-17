/** Fixed copy-and-run wrapper. The program and all of its descendants still
 * execute under the command Seatbelt policy; this does not grant source writes. */
import { isWorkspaceRelativePath } from '@agora/core-domain';
export function localGenerationArguments(inputRoot: string, outputRoot: string, argv: string[]) {
  const entry = argv[0];
  if (!entry?.startsWith('@input/') || !isWorkspaceRelativePath(entry.slice(7)))
    throw Error('invalid_generation_entry');
  const source = `const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const input=${JSON.stringify(inputRoot)};const root=path.join(${JSON.stringify(outputRoot)},'project');fs.cpSync(input,root,{recursive:true,errorOnExist:true,force:false,dereference:false});function writable(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory()){fs.chmodSync(file,0o700);writable(file)}else if(item.isFile())fs.chmodSync(file,fs.statSync(file).mode&0o111?0o700:0o600);else throw Error('unsupported_generation_input')}}writable(root);process.chdir(root);const args=${JSON.stringify(argv)};args[0]=path.join(root,args[0].slice(7));const run=cp.spawnSync(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit'});if(run.error)throw run.error;if(run.signal)process.kill(process.pid,run.signal);else process.exit(run.status??1);`;
  return ['-e', source];
}
