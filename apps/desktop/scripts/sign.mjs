import { execFileSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function signValidationBundle(app) {
  const binaries = [],
    bundles = [app];
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        if (/\.(app|framework)$/.test(entry.name)) bundles.push(path);
      } else if (entry.isFile()) {
        const handle = await open(path);
        const header = Buffer.alloc(4);
        try {
          await handle.read(header, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (
          [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
            header.readUInt32BE(),
          )
        )
          binaries.push(path);
      }
    }
  }
  await visit(app);
  for (const target of [
    ...binaries,
    ...bundles.sort((a, b) => b.split('/').length - a.split('/').length),
  ])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', target], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
}
