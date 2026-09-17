/** Read-only metadata inspection. The caller supplies a trusted selector result
 * and a verified managed helper; this function never creates a grant or staging.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative } from 'node:path';

export interface SelectedLocalRootInspection {
  schemaVersion: 'local-root-inspection-v1';
  path: string;
  filesystem: 'apfs';
  local: true;
  volumeId: string;
  chain: { path: string; identity: string; uid: number; mode: number }[];
}
const safePath = (path: string) =>
  isAbsolute(path) &&
  path !== '/' &&
  normalize(path) === path &&
  ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function pin(path: string) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsupported_workspace');
  return {
    path,
    identity: `${info.dev}:${info.ino}`,
    uid: Number(info.uid),
    mode: Number(info.mode),
  };
}
function helperVersion(path: string) {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.nlink !== 1n || s.mode & 0o022n || !(s.mode & 0o111n))
    throw new Error('sandbox_unavailable');
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}:${s.uid}`;
}
export function inspectSelectedLocalRoot(
  path: string,
  helper: string,
): SelectedLocalRootInspection {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('sandbox_unavailable');
  if (!safePath(path) || realpathSync(path) !== path) throw new Error('unsupported_workspace');
  if (!safePath(helper) || realpathSync(helper) !== helper) throw new Error('sandbox_unavailable');
  const helperRelative = relative(path, helper);
  if (
    helperRelative === '' ||
    (!helperRelative.startsWith('../') && helperRelative !== '..' && !isAbsolute(helperRelative))
  )
    throw new Error('untrusted_runtime_path');
  const components = path.split('/');
  if (
    components.some(
      (part, i) =>
        components[i - 1] === 'Library' && ['CloudStorage', 'Mobile Documents'].includes(part),
    )
  )
    throw new Error('unsupported_workspace');
  const chain: SelectedLocalRootInspection['chain'] = [];
  for (let current = path; ; current = dirname(current)) {
    chain.unshift(pin(current));
    if (current === '/') break;
  }
  if (chain.length > 128) throw new Error('unsupported_workspace');
  const helperBefore = helperVersion(helper);
  const policy = [
    '(version 1)',
    '(deny default)',
    `(allow process-exec (literal ${JSON.stringify(helper)}))`,
    '(allow sysctl-read)',
    // Volume UUID queries are checked against the filesystem mount root by XNU.
    '(allow file-read-metadata (mount-relative-literal "/"))',
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
    `(allow file-read* file-map-executable (literal ${JSON.stringify(helper)}))`,
    ...chain.map((p) => `(allow file-read* (literal ${JSON.stringify(p.path)}))`),
  ].join('\n');
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, helper, path], {
    cwd: '/',
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', HOME: '/', TMPDIR: '/' },
    maxBuffer: 65536,
    timeout: 5000,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.status === 66 ? 'unsupported_workspace' : 'root_inspection_failed', {
      cause: { exitCode: result.status, diagnostic: result.stderr.toString('utf8').slice(0, 1024) },
    });
  let data: SelectedLocalRootInspection;
  try {
    data = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw new Error('root_inspection_failed');
  }
  if (
    !data ||
    Object.keys(data).sort().join(',') !== 'chain,filesystem,local,schemaVersion,volumeId' ||
    data.schemaVersion !== 'local-root-inspection-v1' ||
    data.filesystem !== 'apfs' ||
    data.local !== true ||
    !/^[a-f0-9]{32}$/.test(data.volumeId) ||
    !Array.isArray(data.chain) ||
    data.chain.length !== chain.length
  )
    throw new Error('root_inspection_failed');
  for (let i = 0; i < chain.length; i++) {
    const expected = chain[i],
      actual = data.chain[i];
    if (
      !expected ||
      !actual ||
      Object.keys(actual).sort().join(',') !== 'identity,mode,uid' ||
      actual.identity !== expected.identity ||
      actual.uid !== expected.uid ||
      actual.mode !== expected.mode ||
      JSON.stringify(pin(expected.path)) !== JSON.stringify(expected)
    )
      throw new Error('root_identity_changed');
  }
  if (helperVersion(helper) !== helperBefore) throw new Error('sandbox_unavailable');
  return {
    schemaVersion: 'local-root-inspection-v1',
    path,
    filesystem: 'apfs',
    local: true,
    volumeId: data.volumeId,
    chain,
  };
}
