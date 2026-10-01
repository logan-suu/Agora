/** Compare immutable Git trees, never a model-reported change list. */
import { createHash } from 'node:crypto';
import { isLocalTestPath, isWorkspaceRelativePath } from '@agora/core-domain';

type BaseFile = { path: string; content: Buffer; executable: boolean };
type CurrentFile = { path: string; contentHash: string; version: { executable: boolean } };

const fixturePath = (path: string) =>
  path.startsWith('tests/fixtures/') &&
  /^[A-Za-z0-9._/-]+$/.test(path) &&
  isWorkspaceRelativePath(path);

export function assertLocalValidationChanges(
  base: readonly BaseFile[],
  current: readonly CurrentFile[],
): void {
  const baseFiles = new Map(
    base.map((file) => [
      file.path,
      {
        contentHash: createHash('sha256').update(file.content).digest('hex'),
        executable: file.executable,
      },
    ]),
  );
  const currentFiles = new Map(
    current.map((file) => [
      file.path,
      { contentHash: file.contentHash, executable: file.version.executable },
    ]),
  );
  if (baseFiles.size !== base.length || currentFiles.size !== current.length)
    throw Error('local_validation_change_set_invalid');
  for (const path of new Set([...baseFiles.keys(), ...currentFiles.keys()])) {
    const before = baseFiles.get(path);
    const after = currentFiles.get(path);
    if (
      before &&
      after?.contentHash === before.contentHash &&
      after.executable === before.executable
    )
      continue;
    if (before && !after && isLocalTestPath(path))
      throw Error('local_validation_inherited_test_removed');
    if (!isLocalTestPath(path) && !fixturePath(path))
      throw Error('local_validation_business_file_changed');
  }
}
