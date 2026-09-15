import { execFileSync } from 'node:child_process';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function signValidationBundle(app, beforeSeal = async () => {}, identity = '-') {
  if (identity !== '-' && !/^(?:Developer ID Application: .+|[A-Fa-f0-9]{40})$/.test(identity))
    throw new Error('invalid_signing_identity');
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
  const temporary = await mkdtemp(join(tmpdir(), 'agora-sign-'));
  const entitlement = join(temporary, 'jit.plist');
  const plan = [];
  try {
    await writeFile(
      entitlement,
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
    );
    function sign(target, jit = false) {
      const args = ['--force', '--sign', identity];
      if (identity !== '-') {
        args.push('--timestamp', '--options', 'runtime');
        if (jit) args.push('--entitlements', entitlement);
      }
      execFileSync('/usr/bin/codesign', [...args, target], { stdio: 'pipe' });
      plan.push({ target: target.slice(app.length + 1), jit, hardenedRuntime: identity !== '-' });
    }
    for (const target of binaries)
      sign(target, /\/node\/bin\/node$|\/Contents\/MacOS\//.test(target));
    await beforeSeal();
    for (const target of bundles.sort((a, b) => b.split('/').length - a.split('/').length))
      sign(target, target.endsWith('.app'));
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
    return { mode: identity === '-' ? 'ad-hoc-validation-only' : 'developer-id', plan };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
