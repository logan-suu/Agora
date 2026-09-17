/** Internal policy primitive, not a registered workspace or execution capability.
 * The authenticated launcher must bind these roots, close inherited descriptors,
 * rebuild the environment, and validate the OS/toolchain before executing it.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

type PolicyScope = {
  executable: string;
  bootstrap?: string;
  sourceRoot: string;
  inputRoot: string;
  outputRoot: string;
  deniedRoots: string[];
  toolRoots?: string[];
};

const within = (a: string, b: string) => {
  const path = relative(a, b);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};
const quote = (path: string) => {
  if ([...path].some((character) => character.charCodeAt(0) < 32 || character === '\x7f'))
    throw new Error('invalid_command_scope');
  return JSON.stringify(path);
};

export function buildLocalCommandPolicy(scope: PolicyScope): string {
  if (process.platform !== 'darwin') throw new Error('sandbox_unavailable');
  const roots = [
    scope.sourceRoot,
    scope.inputRoot,
    scope.outputRoot,
    ...(scope.toolRoots ?? []),
    ...scope.deniedRoots,
  ];
  const executables = [scope.executable, ...(scope.bootstrap ? [scope.bootstrap] : [])];
  for (const path of [...executables, ...roots]) {
    quote(path);
    if (!isAbsolute(path) || path === '/' || realpathSync(path) !== path)
      throw new Error('invalid_command_scope');
  }
  for (const executable of executables) {
    if (!lstatSync(executable).isFile()) throw new Error('invalid_command_executable');
    if (within(scope.outputRoot, executable)) throw new Error('mutable_command_executable');
  }
  for (const root of roots) {
    if (!lstatSync(root).isDirectory()) throw new Error('invalid_command_scope');
    for (const other of roots) {
      if (root !== other && (within(root, other) || within(other, root)))
        throw new Error('overlapping_command_scope');
    }
  }
  if (new Set(roots).size !== roots.length) throw new Error('overlapping_command_scope');
  if (readdirSync(scope.outputRoot).length !== 0) throw new Error('command_output_not_fresh');
  const ancestors = new Set<string>();
  for (const root of [...roots, ...executables]) {
    for (let path = dirname(root); ; path = dirname(path)) {
      ancestors.add(path);
      if (path === '/') break;
    }
  }
  const readonly = [scope.sourceRoot, scope.inputRoot, ...(scope.toolRoots ?? [])];
  const hidden = readonly.flatMap((root) => [join(root, '.git'), join(root, '.agora-operations')]);
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    ...executables.map((path) => `(allow process-exec (literal ${quote(path)}))`),
    '(allow sysctl-read)',
    // System dyld paths are taken from the host dyld-support.sb, not project input.
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
    ...[...ancestors].map((root) => `(allow file-read-metadata (literal ${quote(root)}))`),
    '(allow file-read* (literal "/"))',
    ...executables.map((path) => `(allow file-read* file-map-executable (literal ${quote(path)}))`),
    ...readonly.map((root) => `(allow file-read* (subpath ${quote(root)}))`),
    `(allow file-read* file-write* (subpath ${quote(scope.outputRoot)}))`,
    ...readonly.map((root) => `(deny file-write* (subpath ${quote(root)}))`),
    ...[...scope.deniedRoots, ...hidden].map(
      (root) => `(deny file-read* file-write* (subpath ${quote(root)}))`,
    ),
    '(deny file-read* file-write* (regex #"(^|/)\\.env($|[./])"))',
  ].join('\n');
}
