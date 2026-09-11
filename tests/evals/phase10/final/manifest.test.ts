import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GroupRegistry } from './manifest';

it('pre-registers attempts, refuses drift and preserves interrupted executions without rerunning them', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'group-')), 'group.json');
  const manifest = {
    schemaVersion: 1,
    trials: [{ id: 'a' }, { id: 'b' }],
    frozen: { image: 'digest' },
  };
  const registry = new GroupRegistry(path, manifest);
  registry.start('a', '/private/run-a');
  expect(JSON.parse(readFileSync(path, 'utf8')).attempts[0].status).toBe('started');
  expect(() => registry.start('a', '/private/new-run')).toThrow('started');
  expect(() => new GroupRegistry(path, { ...manifest, frozen: { image: 'changed' } })).toThrow(
    'drift',
  );
  const resumed = new GroupRegistry(path, manifest);
  expect(resumed.pending()).toEqual(['b']);
  resumed.finish('a', { runId: 'r', lifecycle: 'final', overallStatus: 'fail' });
  expect(resumed.pending()).toEqual(['b']);
  expect(() => resumed.finish('a', {})).toThrow('started');
});
