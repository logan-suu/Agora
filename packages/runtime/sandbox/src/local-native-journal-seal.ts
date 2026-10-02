/** Pin an owned closed native journal. This reader never admits or repairs a
 * transaction and never follows project-controlled links. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { localRecordHash } from './local-registry-records';

export type LocalNativeJournalSeal = {
  identity: string;
  files: { name: string; identity: string; bytes: number; sha256: string }[];
};
const identity = (s: NonNullable<ReturnType<typeof lstatSync>>) =>
  `${s.dev}:${s.ino}:${s.uid}:${s.mode}`;
function fail(): never {
  throw Error('native_journal_evidence_changed');
}
export function localPrivateDirectoryIdentity(path: string) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    fail();
  return identity(s);
}
export function sealLocalNativeJournal(path: string): LocalNativeJournalSeal {
  const root = localPrivateDirectoryIdentity(path),
    names = readdirSync(path).sort(),
    files: LocalNativeJournalSeal['files'] = [];
  for (const name of names) {
    const file = join(path, name),
      before = lstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(16 * 1024 * 1024 + 16384)
    )
      fail();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const pinned = fstatSync(fd, { bigint: true }),
        bytes = readFileSync(fd),
        after = fstatSync(fd, { bigint: true }),
        named = lstatSync(file, { bigint: true });
      const equal = (s: typeof before) =>
        ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
          (k) =>
            (s as unknown as Record<string, bigint>)[k] ===
            (before as unknown as Record<string, bigint>)[k],
        );
      if (!equal(pinned) || !equal(after) || !equal(named) || bytes.length !== Number(before.size))
        fail();
      files.push({
        name,
        identity: `${before.dev}:${before.ino}:${before.uid}:${before.mode}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } finally {
      closeSync(fd);
    }
  }
  if (
    localPrivateDirectoryIdentity(path) !== root ||
    localRecordHash(names) !== localRecordHash(readdirSync(path).sort())
  )
    fail();
  return { identity: root, files };
}
