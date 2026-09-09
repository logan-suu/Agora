import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin')
  throw new Error('Agora local credential setup currently requires macOS.');
const root = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(root, { recursive: true });
const target = `${root}keychain-${process.arch}`;
const { AGORA_CREDENTIALS_KEY: _key, ...env } = process.env;
execFileSync(
  '/usr/bin/clang',
  [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Wno-deprecated-declarations',
    '-framework',
    'Security',
    '-framework',
    'CoreFoundation',
    fileURLToPath(new URL('../native/keychain.c', import.meta.url)),
    '-o',
    `${target}.tmp`,
  ],
  { stdio: 'inherit', env },
);
renameSync(`${target}.tmp`, target);
