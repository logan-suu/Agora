// Real temporary files exercise the exact allowlist without starting Electron.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { statusAssets } from '../src/status-assets.js';

it('serves only the three packaged status assets with their MIME types', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agora-status-assets-'));
  try {
    const assets = statusAssets(directory);
    for (const [name, type] of [
      ['status.html', 'text/html'],
      ['status.js', 'text/javascript'],
      ['status.css', 'text/css'],
    ] as const) {
      await writeFile(join(directory, name), `body:${name}`);
      const response = await assets.handle(new Request(pathToFileURL(join(directory, name))));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(`${type}; charset=utf-8`);
      expect(await response.text()).toBe(`body:${name}`);
    }
    await writeFile(join(directory, 'private.txt'), 'must remain inaccessible');
    for (const url of [
      pathToFileURL(join(directory, 'private.txt')).href,
      pathToFileURL(join(directory, '../status.html')).href,
      `${assets.page}?extra=1`,
      'file:///etc/passwd',
      'https://example.com/status.html',
    ]) {
      expect((await assets.handle(new Request(url))).status).toBe(403);
    }
    expect((await assets.handle(new Request(assets.page, { method: 'POST' }))).status).toBe(403);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
