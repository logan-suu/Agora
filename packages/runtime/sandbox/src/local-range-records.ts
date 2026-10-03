/** Persistent control facts only. A decoded hold never proves OS quiescence. */
import { dirname, isAbsolute, normalize } from 'node:path';
import {
  isWorkspaceVersionV1,
  type Message,
  parseWorkspaceControl,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import { assertLocalControlMessage, localRecordHash } from './local-registry-records';

export interface LocalRangePhysical {
  path: string;
  identity: string;
  chain: { path: string; identity: string }[];
}
export interface LocalRangePlan {
  schemaVersion: 'local-range-plan-v1';
  takeoverId: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  rootId: string;
  grantId: string;
  grantRevision: number;
  expectedRevision: number;
  sourceMessage: Message;
  requestedPaths: string[];
  /** Current version guards read a full manifest; narrower admission is unproven. */
  effectiveScope: 'workspace';
  physical: LocalRangePhysical;
  startVersion: WorkspaceVersionV1;
  cohort: {
    projectId: string;
    taskId: string;
    workerId: string;
    sessionId: string;
    assignmentHash: string;
  }[];
}
export type LocalRangePhase =
  | 'canonical'
  | 'worker_closed'
  | 'held'
  | 'return_requested'
  | 'captured'
  | 'invalidated'
  | 'released'
  | 'resume_registered'
  | 'needs_attention';
export interface LocalRangeHold {
  plan: LocalRangePlan;
  planHash: string;
  controlStage: 'prepared' | 'committed';
  stage: 'requested' | 'heldByLeader' | 'returnRequested' | 'released';
  /** Content-addressed stage objects include actual closure/lease/version proofs. */
  evidence: { phase: LocalRangePhase; workerKey: string | null; ref: string }[];
  returnMessage: Message | null;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const identity = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(v);
const path = (v: unknown): v is string =>
  typeof v === 'string' &&
  isAbsolute(v) &&
  normalize(v) === v &&
  Buffer.byteLength(v) <= 4096 &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function fail(): never {
  throw Error('invalid_local_range_hold');
}
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== keys.sort().join(',')
  )
    fail();
  return v as Record<string, unknown>;
}
export function parseLocalRangeHold(value: unknown): LocalRangeHold {
  try {
    localRecordHash(value);
    const r = object(value, [
      'plan',
      'planHash',
      'controlStage',
      'stage',
      'evidence',
      'returnMessage',
    ]);
    const p = object(r.plan, [
      'schemaVersion',
      'takeoverId',
      'projectId',
      'taskId',
      'workspaceId',
      'rootId',
      'grantId',
      'grantRevision',
      'expectedRevision',
      'sourceMessage',
      'requestedPaths',
      'effectiveScope',
      'physical',
      'startVersion',
      'cohort',
    ]);
    if (
      p.schemaVersion !== 'local-range-plan-v1' ||
      !['takeoverId', 'projectId', 'taskId', 'workspaceId', 'rootId', 'grantId'].every((k) =>
        id(p[k]),
      ) ||
      !integer(p.grantRevision) ||
      !integer(p.expectedRevision) ||
      p.effectiveScope !== 'workspace' ||
      !isWorkspaceVersionV1(p.startVersion) ||
      r.planHash !== localRecordHash(p)
    )
      fail();
    assertLocalControlMessage(p.sourceMessage, {
      projectId: p.projectId as string,
      taskId: p.taskId as string,
      actionId: (p.sourceMessage as Message).msgId,
      sourceMessageId: (p.sourceMessage as Message).msgId,
      expectedRevision: p.expectedRevision,
    });
    const intent = parseWorkspaceControl((p.sourceMessage as Message).display);
    if (
      intent?.verb !== 'takeover' ||
      intent.workspaceId !== p.workspaceId ||
      localRecordHash(intent.paths) !== localRecordHash(p.requestedPaths)
    )
      fail();
    const physical = object(p.physical, ['path', 'identity', 'chain']);
    if (
      !path(physical.path) ||
      physical.path === '/' ||
      !identity(physical.identity) ||
      !Array.isArray(physical.chain) ||
      !physical.chain.length ||
      physical.chain.length > 128
    )
      fail();
    for (let i = 0; i < physical.chain.length; i++) {
      const entry = object(physical.chain[i], ['path', 'identity']);
      if (
        !path(entry.path) ||
        !identity(entry.identity) ||
        (i === 0 ? entry.path !== '/' : dirname(entry.path) !== physical.chain[i - 1].path)
      )
        fail();
    }
    const last = physical.chain.at(-1);
    if (
      last.path !== physical.path ||
      last.identity !== physical.identity ||
      !Array.isArray(p.cohort) ||
      p.cohort.length > 4096
    )
      fail();
    const cohort = p.cohort.map((x) => {
      const c = object(x, ['projectId', 'taskId', 'workerId', 'sessionId', 'assignmentHash']);
      if (
        !['projectId', 'taskId', 'workerId', 'sessionId'].every((k) => id(c[k])) ||
        !hash(c.assignmentHash)
      )
        fail();
      return c;
    });
    const workerKey = (x: Record<string, unknown>) => `${x.projectId}/${x.taskId}/${x.workerId}`;
    if (
      new Set(cohort.map(workerKey)).size !== cohort.length ||
      !['prepared', 'committed'].includes(r.controlStage as string) ||
      !['requested', 'heldByLeader', 'returnRequested', 'released'].includes(r.stage as string) ||
      !Array.isArray(r.evidence) ||
      r.evidence.length > 4096
    )
      fail();
    const phases = new Set<string>();
    const closed = new Set<string>();
    for (const raw of r.evidence) {
      const e = object(raw, ['phase', 'workerKey', 'ref']);
      if (
        !hash(e.ref) ||
        ![
          'canonical',
          'worker_closed',
          'held',
          'return_requested',
          'captured',
          'invalidated',
          'released',
          'resume_registered',
          'needs_attention',
        ].includes(e.phase as string)
      )
        fail();
      if (e.phase === 'worker_closed' || e.phase === 'resume_registered') {
        if (typeof e.workerKey !== 'string' || !cohort.some((c) => workerKey(c) === e.workerKey))
          fail();
        if (e.phase === 'worker_closed') {
          if (!phases.has('canonical') || closed.has(e.workerKey)) fail();
          closed.add(e.workerKey);
        } else if (!phases.has('released') || phases.has(`resume:${e.workerKey}`)) fail();
        else phases.add(`resume:${e.workerKey}`);
      } else {
        if (e.workerKey !== null) fail();
        const predecessor: Record<string, string> = {
          held: 'canonical',
          return_requested: 'held',
          captured: 'return_requested',
          invalidated: 'captured',
          released: 'invalidated',
        };
        if (
          e.phase !== 'needs_attention' &&
          (phases.has(e.phase as string) ||
            (predecessor[e.phase as string] &&
              !phases.has(predecessor[e.phase as string] as string)))
        )
          fail();
        if (e.phase === 'held' && closed.size !== cohort.length) fail();
        phases.add(e.phase as string);
      }
    }
    if ((r.controlStage === 'committed') !== phases.has('canonical')) fail();
    const expectedStage = phases.has('released')
      ? 'released'
      : phases.has('return_requested')
        ? 'returnRequested'
        : phases.has('held')
          ? 'heldByLeader'
          : 'requested';
    if (
      r.stage !== expectedStage ||
      (r.controlStage === 'prepared' && r.evidence.some((e) => e.phase !== 'needs_attention'))
    )
      fail();
    if (r.returnMessage !== null) {
      const message = r.returnMessage as Message;
      const parsed = parseWorkspaceControl(message.display);
      if (
        parsed?.verb !== 'return' ||
        parsed.takeoverReceiptId !== p.takeoverId ||
        message.msgId === (p.sourceMessage as Message).msgId
      )
        fail();
      assertLocalControlMessage(message, {
        projectId: p.projectId as string,
        taskId: p.taskId as string,
        actionId: message.msgId,
        sourceMessageId: message.msgId,
        expectedRevision: parsed.expectedRevision,
      });
      if (!phases.has('return_requested')) fail();
    } else if (phases.has('return_requested')) fail();
    return structuredClone(value) as LocalRangeHold;
  } catch {
    return fail();
  }
}

export function assertLocalRangeTransition(
  previous: readonly unknown[],
  next: readonly unknown[],
): void {
  const before = previous.map(parseLocalRangeHold),
    after = next.map(parseLocalRangeHold);
  if (new Set(after.map((x) => x.plan.takeoverId)).size !== after.length) fail();
  for (const old of before) {
    const current = after.find((x) => x.plan.takeoverId === old.plan.takeoverId);
    if (
      !current ||
      current.planHash !== old.planHash ||
      localRecordHash(current.plan) !== localRecordHash(old.plan) ||
      current.evidence.length < old.evidence.length ||
      localRecordHash(current.evidence.slice(0, old.evidence.length)) !==
        localRecordHash(old.evidence) ||
      (old.returnMessage !== null &&
        localRecordHash(current.returnMessage) !== localRecordHash(old.returnMessage))
    )
      fail();
    const states = ['requested', 'heldByLeader', 'returnRequested', 'released'];
    const advance = states.indexOf(current.stage) - states.indexOf(old.stage);
    if (
      advance < 0 ||
      advance > 1 ||
      (old.controlStage === 'committed' && current.controlStage !== 'committed')
    )
      fail();
  }
  for (const added of after.filter(
    (x) => !before.some((y) => y.plan.takeoverId === x.plan.takeoverId),
  ))
    if (added.controlStage !== 'prepared' || added.stage !== 'requested' || added.evidence.length)
      fail();
}

/** Conservative APFS aliases plus captured ancestor identities. Shared ancestors
 * alone do not make two distinct linked source trees overlap. */
export function localRangesOverlap(a: LocalRangePhysical, b: LocalRangePhysical): boolean {
  const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase('en-US');
  return (
    a.identity === b.identity ||
    a.chain.some((e) => e.identity === b.identity || fold(e.path) === fold(b.path)) ||
    b.chain.some((e) => e.identity === a.identity || fold(e.path) === fold(a.path))
  );
}
