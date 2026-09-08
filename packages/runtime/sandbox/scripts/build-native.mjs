import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('POSIX sandbox requires macOS or Linux');
const directory = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(directory, { recursive: true });
const target = `${directory}secure-files-${process.platform}-${process.arch}`;
execFileSync(
  process.env.CC || 'cc',
  [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    fileURLToPath(new URL('../native/secure-files.c', import.meta.url)),
    '-o',
    `${target}.tmp`,
  ],
  { stdio: 'inherit' },
);
renameSync(`${target}.tmp`, target);
