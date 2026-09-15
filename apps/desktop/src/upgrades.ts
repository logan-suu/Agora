import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  atomicWrite,
  digest,
  privateDirectory,
  readRegular,
  syncDirectory,
  upgradePath,
} from './upgrade-files.js';

export interface UpgradeOwner {
  root: string;
  assertHeld(): Promise<void>;
}
export interface Migration {
  id: string;
  from: number;
  to: number;
  sourceVersion: string;
  converterVersion: string;
  files: string[];
  transform(path: string, bytes: Buffer): Buffer;
}
interface Journal {
  id: string;
  from: number;
  to: number;
  sourceVersion: string;
  converterVersion: string;
  phase: 'preparing' | 'prepared' | 'applying' | 'rolling_back' | 'committed' | 'rolled_back';
  files: { path: string; before: string; after: string }[];
  completed: number;
}
function validateMigration(migration: Migration) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(migration.id) ||
    !Number.isSafeInteger(migration.from) ||
    migration.from < 1 ||
    migration.to !== migration.from + 1 ||
    !migration.sourceVersion ||
    !migration.converterVersion ||
    !migration.files.length ||
    migration.files.length > 1000 ||
    new Set(migration.files).size !== migration.files.length ||
    migration.files.includes('desktop-format.json')
  )
    throw new Error('unsupported_state_version');
}
function parseJournal(bytes: Buffer): Journal {
  const value = JSON.parse(bytes.toString());
  if (
    !value ||
    Object.keys(value).sort().join() !==
      'completed,converterVersion,files,from,id,phase,sourceVersion,to' ||
    !['preparing', 'prepared', 'applying', 'rolling_back', 'committed', 'rolled_back'].includes(
      value.phase,
    ) ||
    !Number.isSafeInteger(value.completed) ||
    !Array.isArray(value.files) ||
    value.completed < 0 ||
    value.completed > value.files.length ||
    !value.files.every(
      (file: Journal['files'][number]) =>
        file &&
        Object.keys(file).sort().join() === 'after,before,path' &&
        typeof file.path === 'string' &&
        /^[a-f0-9]{64}$/.test(file.before) &&
        /^[a-f0-9]{64}$/.test(file.after),
    )
  )
    throw new Error('invalid_upgrade_journal');
  validateMigration({
    ...value,
    files: value.files.map((file: Journal['files'][number]) => file.path),
    transform: () => Buffer.alloc(0),
  });
  return value as Journal;
}
async function save(root: string, journal: Journal) {
  await atomicWrite(join(root, 'journal.json'), Buffer.from(JSON.stringify(journal)));
}

async function archiveRolledBack(owner: UpgradeOwner, root: string, migration: Migration) {
  try {
    await privateDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const journal = parseJournal(await readRegular(join(root, 'journal.json')));
  if (journal.id !== migration.id || journal.phase !== 'rolled_back')
    throw new Error('upgrade_already_closed');
  const history = join(dirname(owner.root), 'upgrade-history');
  await mkdir(history, { recursive: true, mode: 0o700 });
  await privateDirectory(history);
  await syncDirectory(dirname(history));
  await owner.assertHeld();
  // Preserve the complete closed attempt unchanged before reusing its active slot.
  await rename(root, join(history, `${migration.id}-${randomUUID()}`));
  await syncDirectory(history);
  await syncDirectory(dirname(root));
  return true;
}

export async function assertClosedUpgrades(state: string) {
  const root = join(dirname(state), 'upgrade');
  try {
    await privateDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('upgrade_requires_quiescence');
  }
  try {
    for (const id of await readdir(root)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) throw new Error();
      const operation = join(root, id);
      await privateDirectory(operation);
      const journal = parseJournal(await readRegular(join(operation, 'journal.json')));
      if (journal.id !== id || !['committed', 'rolled_back'].includes(journal.phase))
        throw new Error();
    }
  } catch {
    throw new Error('upgrade_requires_quiescence');
  }
}

export async function applyUpgrade(
  owner: UpgradeOwner,
  migration: Migration,
  checkpoint?: (point: string) => void,
) {
  await owner.assertHeld();
  validateMigration(migration);
  await assertClosedUpgrades(owner.root);
  const sourceFormat = await readRegular(join(owner.root, 'desktop-format.json'));
  const format = JSON.parse(sourceFormat.toString());
  if (Object.keys(format).length !== 1 || format.version !== migration.from)
    throw new Error('unsupported_state_version');
  // Prepare and validate every transformation before creating durable operation state.
  const inputs = [];
  for (const path of migration.files) {
    const original = await readRegular(await upgradePath(owner.root, path));
    JSON.parse(original.toString());
    const updated = migration.transform(path, Buffer.from(original));
    if (!Buffer.isBuffer(updated) || updated.length > 16 * 1024 * 1024)
      throw new Error('invalid_upgrade_file');
    JSON.parse(updated.toString());
    inputs.push({ path, original, updated });
  }
  const parent = join(dirname(owner.root), 'upgrade');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await privateDirectory(parent);
  await syncDirectory(dirname(parent));
  const root = join(parent, migration.id);
  if (await archiveRolledBack(owner, root, migration)) checkpoint?.('archived');
  await owner.assertHeld();
  await mkdir(root, { mode: 0o700 });
  await syncDirectory(parent);
  const journal: Journal = {
    id: migration.id,
    from: migration.from,
    to: migration.to,
    sourceVersion: migration.sourceVersion,
    converterVersion: migration.converterVersion,
    phase: 'preparing',
    completed: 0,
    files: inputs.map((file) => ({
      path: file.path,
      before: digest(file.original),
      after: digest(file.updated),
    })),
  };
  await save(root, journal);
  checkpoint?.('preparing');
  for (const [index, file] of inputs.entries()) {
    await atomicWrite(join(root, `${index}.before`), file.original);
    await atomicWrite(join(root, `${index}.after`), file.updated);
    checkpoint?.(`backup:${index}`);
  }
  await atomicWrite(join(root, 'format.before'), sourceFormat);
  journal.phase = 'prepared';
  await save(root, journal);
  checkpoint?.('prepared');
  return recoverUpgrade(owner, migration, 'continue', checkpoint);
}

export async function recoverUpgrade(
  owner: UpgradeOwner,
  migration: Migration,
  action: 'continue' | 'rollback',
  checkpoint?: (point: string) => void,
) {
  await owner.assertHeld();
  validateMigration(migration);
  const parent = join(dirname(owner.root), 'upgrade');
  await privateDirectory(parent);
  const root = join(parent, migration.id);
  await privateDirectory(root);
  const journal = parseJournal(await readRegular(join(root, 'journal.json')));
  if (
    journal.id !== migration.id ||
    journal.from !== migration.from ||
    journal.to !== migration.to ||
    journal.sourceVersion !== migration.sourceVersion ||
    journal.converterVersion !== migration.converterVersion ||
    JSON.stringify(journal.files.map((file) => file.path)) !== JSON.stringify(migration.files)
  )
    throw new Error('unsupported_state_version');
  if (journal.phase === 'committed' || journal.phase === 'rolled_back') {
    if ((journal.phase === 'committed') !== (action === 'continue'))
      throw new Error('upgrade_already_closed');
    return journal;
  }
  if (journal.phase === 'preparing') {
    if (action !== 'rollback') throw new Error('upgrade_preparation_incomplete');
    const format = JSON.parse(
      (await readRegular(join(owner.root, 'desktop-format.json'))).toString(),
    );
    if (Object.keys(format).length !== 1 || format.version !== journal.from)
      throw new Error('upgrade_state_changed');
    for (const file of journal.files) {
      const source = await readRegular(await upgradePath(owner.root, file.path));
      if (
        digest(source) !== file.before ||
        digest(migration.transform(file.path, Buffer.from(source))) !== file.after
      )
        throw new Error('upgrade_state_changed');
    }
    await owner.assertHeld();
    journal.phase = 'rolled_back';
    await save(root, journal);
    return journal;
  }
  if (journal.phase === 'rolling_back' && action !== 'rollback')
    throw new Error('upgrade_rollback_in_progress');
  const originalFormat = await readRegular(join(root, 'format.before'));
  const beforeFormat = JSON.parse(originalFormat.toString());
  if (beforeFormat.version !== journal.from || Object.keys(beforeFormat).length !== 1)
    throw new Error('invalid_upgrade_backup');
  const currentFormat = JSON.parse(
    (await readRegular(join(owner.root, 'desktop-format.json'))).toString(),
  );
  if (
    Object.keys(currentFormat).length !== 1 ||
    ![journal.from, journal.to].includes(currentFormat.version)
  )
    throw new Error('upgrade_state_changed');
  const targets = [];
  for (const [index, file] of journal.files.entries()) {
    const path = await upgradePath(owner.root, file.path);
    const before = await readRegular(join(root, `${index}.before`));
    const after = await readRegular(join(root, `${index}.after`));
    if (
      digest(before) !== file.before ||
      digest(after) !== file.after ||
      digest(migration.transform(file.path, Buffer.from(before))) !== file.after
    )
      throw new Error('invalid_upgrade_backup');
    const current = digest(await readRegular(path));
    if (current !== file.before && current !== file.after) throw new Error('upgrade_state_changed');
    targets.push({ path, before, after, current });
  }
  journal.phase = action === 'continue' ? 'applying' : 'rolling_back';
  await save(root, journal);
  for (const [index, target] of targets.entries()) {
    await owner.assertHeld();
    if (digest(await readRegular(target.path)) !== target.current)
      throw new Error('upgrade_state_changed');
    await atomicWrite(target.path, action === 'continue' ? target.after : target.before);
    checkpoint?.(`file:${index}`);
    journal.completed = index + 1;
    await save(root, journal);
  }
  for (const target of targets) {
    if (
      digest(await readRegular(target.path)) !==
      digest(action === 'continue' ? target.after : target.before)
    )
      throw new Error('upgrade_state_changed');
  }
  await owner.assertHeld();
  await atomicWrite(
    join(owner.root, 'desktop-format.json'),
    action === 'continue' ? Buffer.from(JSON.stringify({ version: journal.to })) : originalFormat,
  );
  checkpoint?.('format');
  journal.phase = action === 'continue' ? 'committed' : 'rolled_back';
  await save(root, journal);
  return journal;
}
