/** Closed offline installation adapter. Package resolution is explicit and
 * immutable; package scripts still execute under the ordinary Node boundary. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspaceRelativePath } from '@agora/core-domain';
export type LocalPackagePlan = { name: string; version: string; url: string; integrity: string }[];
export type ManagedPnpm = { root: string; manifestPath: string; version: string };
export function parseLocalPackagePlan(argv: string[]): LocalPackagePlan {
  let value: unknown;
  try {
    value = argv.length === 1 ? JSON.parse(argv[0] as string) : null;
  } catch {
    value = null;
  }
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    value.some(
      (p) =>
        !p ||
        Object.keys(p).sort().join(',') !== 'integrity,name,url,version' ||
        typeof p.name !== 'string' ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(p.name) ||
        !isWorkspaceRelativePath(p.name) ||
        typeof p.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(p.version) ||
        typeof p.url !== 'string' ||
        typeof p.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity),
    ) ||
    new Set(value.map((p) => p.name)).size !== value.length
  )
    throw Error('invalid_installation_plan');
  return structuredClone(value);
}
export function checkLocalPackageManifest(bytes: Buffer, plan: LocalPackagePlan) {
  const pkg = JSON.parse(bytes.toString('utf8'));
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    Array.isArray(pkg) ||
    pkg.workspaces ||
    pkg.pnpm ||
    pkg.optionalDependencies ||
    pkg.peerDependencies ||
    pkg.overrides
  )
    throw Error('unsupported_installation_manifest');
  const deps: Record<string, unknown> = {};
  for (const field of ['dependencies', 'devDependencies']) {
    const entries = pkg[field];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
      throw Error('unsupported_installation_manifest');
    for (const [name, version] of Object.entries(entries)) {
      if (name in deps && deps[name] !== version) throw Error('unsupported_installation_manifest');
      deps[name] = version;
    }
  }
  if (Object.keys(deps).length !== plan.length || plan.some((p) => deps[p.name] !== p.version))
    throw Error('installation_plan_manifest_mismatch');
  return pkg;
}
export async function verifyManagedPnpm(tool: ManagedPnpm, manifestHash: string) {
  if (
    tool.root !== join(dirname(tool.manifestPath), 'pnpm') ||
    (await realpath(tool.root)) !== tool.root
  )
    throw Error('toolchain_identity_mismatch');
  const bytes = await readFile(tool.manifestPath);
  if (createHash('sha256').update(bytes).digest('hex') !== manifestHash)
    throw Error('toolchain_identity_mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.versions?.pnpm !== tool.version || !Array.isArray(manifest.files))
    throw Error('toolchain_identity_mismatch');
  const files = manifest.files.filter((f: { path: string }) => f.path.startsWith('pnpm/'));
  const expected = new Map<string, string>();
  for (const f of files) {
    const relative = f.path.slice(5);
    if (
      !isWorkspaceRelativePath(relative) ||
      f.link ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      expected.has(relative)
    )
      throw Error('toolchain_identity_mismatch');
    expected.set(relative, f.sha256);
  }
  if (!expected.has('bin/pnpm.cjs')) throw Error('toolchain_identity_mismatch');
  async function walk(path: string, prefix: string) {
    for (const name of await readdir(path)) {
      const key = prefix + name,
        target = join(path, name),
        stat = await lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(target, `${key}/`);
      else if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        !expected.has(key) ||
        createHash('sha256')
          .update(await readFile(target))
          .digest('hex') !== expected.get(key)
      )
        throw Error('toolchain_identity_mismatch');
      else expected.delete(key);
    }
  }
  await walk(tool.root, '');
  if (expected.size) throw Error('toolchain_identity_mismatch');
}
export function localInstallationArguments(
  input: string,
  output: string,
  packages: string,
  tool: ManagedPnpm,
  plan: LocalPackagePlan,
  node: string,
) {
  const driver = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const root=path.join(${JSON.stringify(output)},'project');fs.cpSync(${JSON.stringify(input)},root,{recursive:true,errorOnExist:true,force:false});function writable(dir){fs.chmodSync(dir,0o700);for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())writable(p);else if(e.isFile())fs.chmodSync(p,fs.statSync(p).mode&0o111?0o700:0o600);else throw Error('unsupported_installation_input')}}writable(root);process.chdir(root);const original=fs.readFileSync('package.json');const pkg=JSON.parse(original);const plan=${JSON.stringify(plan)};for(const group of ['dependencies','devDependencies'])for(const name of Object.keys(pkg[group]||{}))pkg[group][name]='file:'+path.join(${JSON.stringify(packages)},plan.findIndex(p=>p.name===name)+'.tgz');fs.writeFileSync('package.json',JSON.stringify(pkg));const env={...process.env,PATH:${JSON.stringify(dirname(node))},CI:'true',npm_config_shell_emulator:'true'};const run=cp.spawnSync(process.execPath,[${JSON.stringify(join(tool.root, 'bin/pnpm.cjs'))},'install','--offline','--prod=false','--no-frozen-lockfile','--node-linker=hoisted','--store-dir',path.join(${JSON.stringify(output)},'store'),'--cache-dir',path.join(${JSON.stringify(output)},'cache'),'--package-import-method','copy'],{cwd:root,env,stdio:'inherit'});if(run.error)throw run.error;if(run.status!==0)process.exit(run.status||1);fs.writeFileSync('package.json',original);for(const p of plan){const actual=JSON.parse(fs.readFileSync(path.join('node_modules',p.name,'package.json')));if(actual.name!==p.name||actual.version!==p.version)throw Error('installed_package_mismatch')}`;
  return ['-e', driver];
}
