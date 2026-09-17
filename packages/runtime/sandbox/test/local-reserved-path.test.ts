// Admission-only checks: no project files or native commands are opened.
import { expect, it } from 'vitest';
import { inspectLocalFileBytes } from '../src/local-file-transaction';

it.each(['.ENV', '.Env.local', '.GiT/config', 'src/.AGORA-OPERATIONS/item'])(
  'rejects reserved path spelling before filesystem admission: %s',
  (path) => {
    expect(() =>
      inspectLocalFileBytes({ root: '', chain: [], stagingIdentity: '0:0' }, path, '/unused'),
    ).toThrow('invalid_file_change');
  },
);
