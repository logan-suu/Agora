/** Internal control-plane journal. It cannot authorize execution or release resources.
 * The application must supply its authenticated, project-inaccessible control root.
 * Interrupted reservations and registered-only stop receipts remain blocking. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import {
  type BindingFailure,
  type CommandBindingSnapshot,
  validCommandBinding,
} from './local-command-binding';
import type { LocalProcessIdentity, RegisteredStopReceipt } from './local-command-stop';

export type StoredCommandObservation = {
  version: 2;
  bindingFailure: BindingFailure | null;
  cause: 'exit' | 'timeout' | 'cancelled' | 'observation_failed';
  executionMs: number;
  cleanupMs: number;
  discoveryPasses: number;
  discoveryFailed: boolean;
  closedDuringDiscovery?: LocalProcessIdentity[];
  discoveryFailures?: {
    identity: LocalProcessIdentity;
    state: 'exited' | 'identityMismatch' | 'unknown' | 'deadline' | 'queryFailed' | 'limit';
  }[];
  mainResult: { exitCode: number | null; signal: string | null; error: string | null };
  stdout: {
    retainedBytes: number;
    observedBytes: number;
    sha256: string;
    truncated: boolean;
    error: string | null;
  };
  stderr: StoredCommandObservation['stdout'];
  stop: RegisteredStopReceipt;
};

/** Durable launch facts only, never a tool-success or workspace-release receipt. */
export type StoredCommandLaunch = {
  version: 1;
  targetIdentity: LocalProcessIdentity | null;
  released: boolean;
  payloadResult: { exitCode: number | null; signal: number | null } | null;
  error: string | null;
};

type Root = { path: string; identity: string };
export type CommandReservation = {
  commandId: string;
  workspaceId: string;
  policyHash: string;
  inputHash: string;
  roots: string[];
};
export type CommandJournalRecord = Omit<CommandReservation, 'roots'> & {
  roots: Root[];
  revision: number;
  birthIdentities: number[][];
  birthRelations: { parent: number[]; child: number[] }[];
  observationReceipt: StoredCommandObservation | null;
  launchReceipt: StoredCommandLaunch | null;
  binding: CommandBindingSnapshot | null;
  resourceState: 'reserved' | 'quarantined';
  reason: 'discovery_incomplete' | 'identity_mismatch' | 'control_failure' | null;
};
type Journal = { version: 4; records: CommandJournalRecord[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const birth = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === 8 &&
  value.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) &&
  value[5] > 1 &&
  value[5] <= 0x7fffffff &&
  value[1] === process.getuid?.();
const overlaps = (a: string, b: string) => {
  const path = relative(a, b);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};
const directory = (path: string): Root => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_command_root');
  return { path, identity: `${stat.dev}:${stat.ino}` };
};

const identityKey = (identity: LocalProcessIdentity) => identity.join(':');
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
function validObservation(
  value: StoredCommandObservation,
  members: readonly LocalProcessIdentity[],
) {
  const stream = (entry: StoredCommandObservation['stdout']) =>
    entry &&
    Number.isSafeInteger(entry.retainedBytes) &&
    entry.retainedBytes >= 0 &&
    entry.retainedBytes <= 1024 * 1024 &&
    Number.isSafeInteger(entry.observedBytes) &&
    entry.observedBytes >= entry.retainedBytes &&
    digest(entry.sha256) &&
    typeof entry.truncated === 'boolean' &&
    (entry.error === null || entry.error === 'output_read_failed');
  return (
    value &&
    value.version === 2 &&
    (value.bindingFailure === null ||
      ['authority_changed', 'root_changed', 'tool_changed', 'host_changed'].includes(
        value.bindingFailure,
      )) &&
    ['exit', 'timeout', 'cancelled', 'observation_failed'].includes(value.cause) &&
    nonnegative(value.executionMs) &&
    nonnegative(value.cleanupMs) &&
    Number.isSafeInteger(value.discoveryPasses) &&
    value.discoveryPasses >= 0 &&
    typeof value.discoveryFailed === 'boolean' &&
    (value.closedDuringDiscovery === undefined ||
      (Array.isArray(value.closedDuringDiscovery) &&
        value.closedDuringDiscovery.length <= 256 &&
        value.closedDuringDiscovery.every(
          (identity) =>
            birth(identity) &&
            members.some((member) => identityKey(member) === identityKey(identity)),
        ) &&
        new Set(value.closedDuringDiscovery.map(identityKey)).size ===
          value.closedDuringDiscovery.length)) &&
    (value.discoveryFailures === undefined ||
      (Array.isArray(value.discoveryFailures) &&
        value.discoveryFailures.length <= 257 &&
        value.discoveryFailures.every(
          (entry) =>
            entry &&
            Object.keys(entry).sort().join(',') === 'identity,state' &&
            birth(entry.identity) &&
            ['exited', 'identityMismatch', 'unknown', 'deadline', 'queryFailed', 'limit'].includes(
              entry.state,
            ),
        ))) &&
    value.mainResult &&
    (value.mainResult.exitCode === null ||
      (Number.isInteger(value.mainResult.exitCode) &&
        value.mainResult.exitCode >= 0 &&
        value.mainResult.exitCode <= 255)) &&
    (value.mainResult.signal === null || /^SIG[A-Z0-9]+$/.test(value.mainResult.signal)) &&
    [null, 'command_spawn_failed', 'command_observation_incomplete'].includes(
      value.mainResult.error,
    ) &&
    stream(value.stdout) &&
    stream(value.stderr) &&
    value.stop &&
    value.stop.assurance === 'registered-only' &&
    ['stopped', 'needsAttention'].includes(value.stop.registeredState) &&
    nonnegative(value.stop.durationMs) &&
    Array.isArray(value.stop.signals) &&
    value.stop.signals.length <= 2 &&
    value.stop.signals.every((signal) => signal === 'TERM' || signal === 'KILL') &&
    new Set(value.stop.signals).size === value.stop.signals.length &&
    Array.isArray(value.stop.states) &&
    value.stop.states.length === members.length &&
    value.stop.states.every((state) =>
      ['alive', 'exited', 'identityMismatch', 'unknown'].includes(state),
    ) &&
    (value.stop.registeredState !== 'stopped' ||
      value.stop.states.every((state) => state === 'exited'))
  );
}

function validRelations(record: CommandJournalRecord) {
  if (!Array.isArray(record.birthRelations) || record.birthRelations.length > 255) return false;
  const members = record.birthIdentities.map(identityKey);
  if (new Set(members).size !== members.length) return false;
  const children = new Set<string>();
  return record.birthRelations.every((relation) => {
    if (!relation || !birth(relation.parent) || !birth(relation.child)) return false;
    const parent = members.indexOf(identityKey(relation.parent));
    const child = members.indexOf(identityKey(relation.child));
    if (parent < 0 || child <= parent || children.has(identityKey(relation.child))) return false;
    children.add(identityKey(relation.child));
    return true;
  });
}

function validLaunch(value: StoredCommandLaunch, record: CommandJournalRecord) {
  if (
    !value ||
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    typeof value.released !== 'boolean' ||
    (value.error !== null &&
      (typeof value.error !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value.error)))
  )
    return false;
  if (
    value.targetIdentity !== null &&
    (!birth(value.targetIdentity) ||
      !record.binding ||
      !record.birthRelations.some(
        (relation) =>
          identityKey(relation.parent) === identityKey(record.birthIdentities[0] ?? []) &&
          identityKey(relation.child) === identityKey(value.targetIdentity as number[]),
      ))
  )
    return false;
  if (value.released && value.targetIdentity === null) return false;
  if (value.payloadResult !== null) {
    const result = value.payloadResult;
    if (
      !value.released ||
      !result ||
      Object.keys(result).length !== 2 ||
      !record.observationReceipt ||
      !(
        (result.signal === null &&
          Number.isInteger(result.exitCode) &&
          (result.exitCode as number) >= 0 &&
          (result.exitCode as number) <= 255) ||
        (result.exitCode === null &&
          Number.isInteger(result.signal) &&
          (result.signal as number) > 0 &&
          (result.signal as number) <= 255)
      )
    )
      return false;
  }
  // Missing facts and control failures cannot become successful launch results.
  return (
    value.error !== null ||
    (value.released &&
      value.payloadResult !== null &&
      record.observationReceipt?.bindingFailure === null)
  );
}

function validRecord(record: CommandJournalRecord) {
  return (
    record &&
    id(record.commandId) &&
    id(record.workspaceId) &&
    digest(record.policyHash) &&
    digest(record.inputHash) &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 0 &&
    Array.isArray(record.roots) &&
    record.roots.length > 0 &&
    record.roots.length <= 16 &&
    record.roots.every(
      (root) =>
        root &&
        typeof root.path === 'string' &&
        isAbsolute(root.path) &&
        root.path !== '/' &&
        normalize(root.path) === root.path &&
        /^\d+:\d+$/.test(root.identity),
    ) &&
    Array.isArray(record.birthIdentities) &&
    record.birthIdentities.length <= 256 &&
    record.birthIdentities.every(birth) &&
    validRelations(record) &&
    (record.binding === null ||
      (validCommandBinding(record.binding) &&
        record.binding.authority.workspaceId === record.workspaceId &&
        record.roots.every((root) =>
          record.binding?.roots.some(
            (bound) => bound.path === root.path && bound.chain.at(-1)?.identity === root.identity,
          ),
        ))) &&
    (record.observationReceipt === null ||
      (record.resourceState === 'quarantined' &&
        validObservation(record.observationReceipt, record.birthIdentities))) &&
    (record.launchReceipt === null ||
      (record.resourceState === 'quarantined' && validLaunch(record.launchReceipt, record))) &&
    ((record.resourceState === 'reserved' && record.reason === null) ||
      (record.resourceState === 'quarantined' &&
        ['discovery_incomplete', 'identity_mismatch', 'control_failure'].includes(
          record.reason as string,
        )))
  );
}

export class LocalCommandJournal {
  private readonly chain: Root[] = [];
  private readonly file: string;
  private readonly lock: string;
  constructor(
    private readonly root: string,
    initialize = false,
  ) {
    if (!isAbsolute(root) || root === '/' || realpathSync(root) !== root)
      throw new Error('invalid_command_root');
    for (let path = root; ; path = dirname(path)) {
      this.chain.push(directory(path));
      if (path === '/') break;
    }
    this.file = join(root, 'commands.json');
    this.lock = join(root, 'commands.lock');
    this.assertRoot();
    if (initialize) {
      if (readdirSync(root).length) throw new Error('command_journal_exists');
      this.change(() => ({ version: 4, records: [] }), true);
    } else this.read();
  }

  private assertRoot() {
    try {
      const stat = lstatSync(this.root);
      if (
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o700 ||
        this.chain.some((entry) => directory(entry.path).identity !== entry.identity)
      )
        throw new Error('changed');
    } catch {
      throw new Error('command_journal_root_changed');
    }
  }

  private read(locked = false): Journal {
    this.assertRoot();
    if (!locked && existsSync(this.lock)) throw new Error('command_journal_locked');
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 1024 * 1024
      )
        throw new Error('invalid');
      const wrapper = JSON.parse(readFileSync(fd, 'utf8')) as { data: Journal; sha256: string };
      const data = wrapper.data;
      if (
        data?.version !== 4 ||
        !Array.isArray(data.records) ||
        data.records.length > 256 ||
        !data.records.every(validRecord) ||
        wrapper.sha256 !== hash(JSON.stringify(data)) ||
        new Set(data.records.map((entry) => entry.commandId)).size !== data.records.length
      )
        throw new Error('invalid');
      const identities = data.records.flatMap((record) => record.birthIdentities.map(identityKey));
      if (new Set(identities).size !== identities.length) throw new Error('invalid');
      const roots = data.records.flatMap((record) => record.roots);
      for (let i = 0; i < roots.length; i++)
        for (let j = i + 1; j < roots.length; j++) {
          const a = roots[i] as Root,
            b = roots[j] as Root;
          if (a.identity === b.identity || overlaps(a.path, b.path) || overlaps(b.path, a.path))
            throw new Error('invalid');
        }
      this.assertRoot();
      return data;
    } catch {
      throw new Error('invalid_command_journal');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private change(update: (data: Journal) => Journal, initialize = false) {
    this.assertRoot();
    let lockFd: number;
    try {
      lockFd = openSync(this.lock, 'wx', 0o600);
    } catch {
      throw new Error('command_journal_locked');
    }
    let durable = false;
    let publishing = false;
    try {
      if (initialize && readdirSync(this.root).some((name) => name !== 'commands.lock'))
        throw new Error('command_journal_exists');
      const data = update(initialize ? { version: 4, records: [] } : this.read(true));
      if (!data.records.every(validRecord)) throw new Error('invalid_command_journal');
      const bytes = JSON.stringify({ data, sha256: hash(JSON.stringify(data)) });
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('command_journal_full');
      const temp = join(this.root, `pending-${randomUUID()}.json`);
      publishing = true;
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.assertRoot();
      renameSync(temp, this.file);
      const parent = openSync(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      durable = true;
    } catch (error) {
      // Validation failures before publication leave the old record intact.
      // A pending file identifies uncertain I/O and keeps the crash lock closed.
      if (!publishing) durable = true;
      throw error;
    } finally {
      closeSync(lockFd);
      if (durable) {
        this.assertRoot();
        unlinkSync(this.lock);
      }
    }
  }

  snapshot() {
    const data = this.read();
    return { blocked: data.records.length > 0, records: data.records };
  }

  reserve(request: CommandReservation): CommandJournalRecord {
    if (
      !id(request.commandId) ||
      !id(request.workspaceId) ||
      !digest(request.policyHash) ||
      !digest(request.inputHash) ||
      !Array.isArray(request.roots) ||
      request.roots.length < 1 ||
      request.roots.length > 16
    )
      throw new Error('invalid_command_reservation');
    let result: CommandJournalRecord | undefined;
    this.change((data) => {
      const existing = data.records.find((entry) => entry.commandId === request.commandId);
      if (existing) {
        if (
          existing.workspaceId !== request.workspaceId ||
          existing.policyHash !== request.policyHash ||
          existing.inputHash !== request.inputHash ||
          JSON.stringify(existing.roots.map((r) => r.path)) !== JSON.stringify(request.roots)
        )
          throw new Error('command_replay_conflict');
        result = existing;
        return data;
      }
      if (data.records.length >= 256) throw new Error('command_journal_full');
      const roots = request.roots.map((path) => {
        if (
          !isAbsolute(path) ||
          realpathSync(path) !== path ||
          path === '/' ||
          overlaps(path, this.root) ||
          overlaps(this.root, path)
        )
          throw new Error('invalid_command_root');
        return directory(path);
      });
      const oldRoots = data.records.flatMap((entry) => entry.roots);
      for (const [index, root] of roots.entries()) {
        if (
          [...oldRoots, ...roots.slice(0, index)].some(
            (other) =>
              root.identity === other.identity ||
              overlaps(root.path, other.path) ||
              overlaps(other.path, root.path),
          )
        )
          throw new Error('command_resource_reused');
        if (readdirSync(root.path).length) throw new Error('command_output_not_fresh');
        const stat = lstatSync(root.path);
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
          throw new Error('invalid_command_root');
      }
      result = {
        ...request,
        roots,
        revision: 0,
        birthIdentities: [],
        birthRelations: [],
        observationReceipt: null,
        launchReceipt: null,
        binding: null,
        resourceState: 'reserved',
        reason: null,
      };
      return { version: 4, records: [...data.records, result] };
    });
    return structuredClone(result as CommandJournalRecord);
  }

  registerBirth(
    commandId: string,
    revision: number,
    identity: LocalProcessIdentity,
    parent?: LocalProcessIdentity,
  ) {
    if (!birth(identity) || (parent !== undefined && !birth(parent)))
      throw new Error('invalid_process_identity');
    return this.update(commandId, revision, (record, data) => {
      if (
        parent &&
        !record.birthIdentities.some((entry) => identityKey(entry) === identityKey(parent))
      )
        throw new Error('unknown_process_parent');
      if (
        data.records.some((entry) =>
          entry.birthIdentities.some((prior) => prior.join(':') === identity.join(':')),
        )
      )
        throw new Error('process_identity_reused');
      if (record.birthIdentities.length >= 256) throw new Error('command_journal_full');
      record.birthIdentities.push([...identity]);
      if (parent) record.birthRelations.push({ parent: [...parent], child: [...identity] });
    });
  }

  bindCommand(commandId: string, revision: number, binding: CommandBindingSnapshot) {
    return this.update(commandId, revision, (record) => {
      if (
        record.binding !== null ||
        record.birthIdentities.length ||
        !validCommandBinding(binding) ||
        binding.authority.workspaceId !== record.workspaceId
      )
        throw new Error('invalid_command_binding');
      if (
        record.roots.some(
          (root) =>
            !binding.roots.some(
              (bound) => bound.path === root.path && bound.chain.at(-1)?.identity === root.identity,
            ),
        )
      )
        throw new Error('invalid_command_binding');
      record.binding = structuredClone(binding);
    });
  }

  /** Stores an internal observation only; it cannot clear quarantine or grant access. */
  recordObservation(commandId: string, revision: number, receipt: StoredCommandObservation) {
    return this.update(commandId, revision, (record) => {
      if (!validObservation(receipt, record.birthIdentities))
        throw new Error('invalid_command_observation');
      record.observationReceipt = structuredClone(receipt);
      record.resourceState = 'quarantined';
      record.reason =
        receipt.bindingFailure ||
        receipt.discoveryFailed ||
        receipt.stop.registeredState !== 'stopped'
          ? 'control_failure'
          : 'discovery_incomplete';
    });
  }

  /** Appends once after resource quarantine; it cannot reopen any capability. */
  recordLaunch(commandId: string, revision: number, receipt: StoredCommandLaunch) {
    let result: CommandJournalRecord | undefined;
    this.change((data) => {
      const record = data.records.find((entry) => entry.commandId === commandId);
      if (!record) throw new Error('unknown_command');
      if (record.revision !== revision) throw new Error('command_revision_conflict');
      if (record.launchReceipt !== null) throw new Error('command_launch_already_recorded');
      if (record.resourceState !== 'quarantined' || !validLaunch(receipt, record))
        throw new Error('invalid_command_launch');
      if (!Number.isSafeInteger(record.revision + 1)) throw new Error('command_revision_exhausted');
      record.launchReceipt = structuredClone(receipt);
      record.revision++;
      result = record;
      return data;
    });
    return structuredClone(result as CommandJournalRecord);
  }

  quarantine(
    commandId: string,
    revision: number,
    reason: NonNullable<CommandJournalRecord['reason']>,
  ) {
    if (!['discovery_incomplete', 'identity_mismatch', 'control_failure'].includes(reason))
      throw new Error('invalid_quarantine_reason');
    return this.update(commandId, revision, (record) => {
      record.resourceState = 'quarantined';
      record.reason = reason;
    });
  }

  private update(
    commandId: string,
    revision: number,
    update: (record: CommandJournalRecord, data: Journal) => void,
  ) {
    let result: CommandJournalRecord | undefined;
    this.change((data) => {
      const record = data.records.find((entry) => entry.commandId === commandId);
      if (!record) throw new Error('unknown_command');
      if (record.resourceState !== 'reserved') throw new Error('command_record_closed');
      if (record.revision !== revision) throw new Error('command_revision_conflict');
      if (!Number.isSafeInteger(record.revision + 1)) throw new Error('command_revision_exhausted');
      update(record, data);
      record.revision++;
      result = record;
      return data;
    });
    return structuredClone(result as CommandJournalRecord);
  }
}
