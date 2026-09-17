import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('POSIX sandbox requires macOS or Linux');
const directory = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(directory, { recursive: true });
const names = [
  'secure-files',
  ...(process.platform === 'darwin'
    ? [
        'local-root-inspection',
        'local-root-initialization',
        'local-file-transaction',
        'local-command-bootstrap',
        'local-process-control',
      ]
    : []),
];
for (const name of names) {
  const target = `${directory}${name}-${process.platform}-${process.arch}`;
  execFileSync(
    process.env.CC || 'cc',
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      ...(process.platform === 'darwin' ? ['-mmacosx-version-min=15.0'] : []),
      fileURLToPath(new URL(`../native/${name}.c`, import.meta.url)),
      '-o',
      `${target}.tmp`,
    ],
    { stdio: 'inherit' },
  );
  renameSync(`${target}.tmp`, target);
}
