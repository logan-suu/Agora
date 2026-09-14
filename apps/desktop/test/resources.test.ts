import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditResources, copyTracedFile, reviewTraceFile } from '../src/build-resources.js';

const roots: string[] = [];
it('classifies known development inputs and refuses unknown trace additions', () => {
  expect(reviewTraceFile('apps/web/test/channel-stream.test.ts')).toBe('development');
  expect(reviewTraceFile('apps/web/src/app/chat-model.ts')).toBe('development');
  expect(reviewTraceFile('node_modules/.pnpm/next/node_modules/next/dist/server/next.js')).toBe(
    'runtime',
  );
  expect(() => reviewTraceFile('apps/web/test/credentials.json')).toThrow('unknown_trace_resource');
  expect(() => reviewTraceFile('unexpected.txt')).toThrow('unknown_trace_resource');
  expect(() => reviewTraceFile('node_modules/next/unexpected.key')).toThrow(
    'unknown_trace_resource',
  );
  expect(() => reviewTraceFile('apps/web/.env.local')).toThrow('forbidden_resource');
});
it('copies a real file through the platform temporary-directory alias', async () => {
  const source = await root();
  const target = await root();
  await writeFile(join(source, 'entry.js'), 'export const value = 1;');
  await copyTracedFile(source, target, join(source, 'entry.js'));
  expect(await readFile(join(target, 'entry.js'), 'utf8')).toBe('export const value = 1;');
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'agora113-files-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it('rejects secret paths and links outside a production resource tree', async () => {
  const path = await root();
  await writeFile(join(path, '.env.production'), 'not a real secret');
  await expect(auditResources(path)).rejects.toThrow('forbidden_resource');
  await rm(join(path, '.env.production'));
  await symlink('/etc', join(path, 'outside'));
  await expect(auditResources(path)).rejects.toThrow('external_resource_link');
});
it('refuses trace traversal and forbidden files instead of silently filtering them', async () => {
  const source = await root();
  const target = await root();
  await mkdir(join(source, '.data'));
  await writeFile(join(source, '.data/state.json'), '{}');
  await expect(copyTracedFile(source, target, join(source, '.data/state.json'))).rejects.toThrow(
    'forbidden_resource',
  );
  await expect(copyTracedFile(source, target, '/etc/passwd')).rejects.toThrow('external_resource');
});
