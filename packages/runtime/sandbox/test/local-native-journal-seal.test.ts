// Real owned journal files; no filesystem or native evidence adapter is mocked.
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  localPrivateDirectoryIdentity,
  sealLocalNativeJournal,
} from '../src/local-native-journal-seal';

function fixture(work: (root: string) => void) {
  const root = mkdtempSync('/private/tmp/agora-undo-journal-');
  chmodSync(root, 0o700);
  try {
    work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it('pins closed regular journal bytes and identifies later replacements', () =>
  fixture((root) => {
    const file = join(root, 'result.json');
    writeFileSync(file, 'first', { mode: 0o400 });
    const before = sealLocalNativeJournal(root);
    expect(sealLocalNativeJournal(root)).toEqual(before);
    renameSync(file, join(root, 'preserved'));
    writeFileSync(file, 'first', { mode: 0o400 });
    expect(sealLocalNativeJournal(root)).not.toEqual(before);
  }));
it('rejects links, multiply linked files and public journal files', () =>
  fixture((root) => {
    const privateDir = join(root, 'private');
    mkdirSync(privateDir, { mode: 0o700 });
    writeFileSync(join(privateDir, 'proof'), 'proof', { mode: 0o400 });
    symlinkSync(join(privateDir, 'proof'), join(privateDir, 'link'));
    expect(() => sealLocalNativeJournal(privateDir)).toThrow();
    rmSync(join(privateDir, 'link'));
    linkSync(join(privateDir, 'proof'), join(root, 'hardlink'));
    expect(() => sealLocalNativeJournal(privateDir)).toThrow();
    rmSync(join(root, 'hardlink'));
    chmodSync(join(privateDir, 'proof'), 0o644);
    expect(() => sealLocalNativeJournal(privateDir)).toThrow();
  }));
it('rejects a journal root reached through an alias and a changed root identity', () =>
  fixture((root) => {
    const journal = join(root, 'journal');
    mkdirSync(journal, { mode: 0o700 });
    const old = localPrivateDirectoryIdentity(journal);
    symlinkSync(journal, join(root, 'alias'));
    expect(() => localPrivateDirectoryIdentity(join(root, 'alias'))).toThrow();
    renameSync(journal, join(root, 'old'));
    mkdirSync(journal, { mode: 0o700 });
    expect(localPrivateDirectoryIdentity(journal)).not.toBe(old);
  }));
