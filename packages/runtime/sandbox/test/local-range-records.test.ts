import { parseWorkspaceControl } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { assertLocalRangeAdmission } from '../src/local-range-admission';
import {
  assertLocalRangeTransition,
  localRangesOverlap,
  parseLocalRangeHold,
} from '../src/local-range-records';
import {
  assertLocalRegistryTransition,
  localRecordHash,
  parseLocalRegistry,
} from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

const proof = 'a'.repeat(64);
export function rangeHoldFixture() {
  const display =
    '/workspace takeover {"projectId":"project","taskId":"task","actionId":"take","expectedRevision":2,"workspaceId":"workspace","paths":["src/file.ts"]}';
  const plan = {
    schemaVersion: 'local-range-plan-v1' as const,
    takeoverId: 'takeover:take',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'workspace',
    rootId: 'root',
    grantId: 'grant',
    grantRevision: 0,
    expectedRevision: 2,
    sourceMessage: {
      msgId: 'take',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        intent: parseWorkspaceControl(display),
        action: { status: 'applied' },
      },
      display,
      ts: 1,
    },
    requestedPaths: ['src/file.ts'],
    effectiveScope: 'workspace' as const,
    physical: {
      path: '/fixture',
      identity: '1:2',
      chain: [
        { path: '/', identity: '1:1' },
        { path: '/fixture', identity: '1:2' },
      ],
    },
    startVersion: { kind: 'files', manifestId: 'manifest', manifestHash: proof },
    cohort: [
      {
        projectId: 'project',
        taskId: 'task',
        workerId: 'worker',
        sessionId: 'session',
        assignmentHash: proof,
      },
    ],
  };
  return {
    plan,
    planHash: localRecordHash(plan),
    controlStage: 'prepared' as const,
    stage: 'requested' as const,
    evidence: [] as { phase: string; workerKey: string | null; ref: string }[],
    returnMessage: null,
  };
}

describe('persistent local range records', () => {
  it('binds a strict physical plan and keeps admission blocked before canonical closure', () => {
    expect(parseLocalRangeHold(rangeHoldFixture()).stage).toBe('requested');
    const extra = { ...rangeHoldFixture(), deadline: 123 };
    expect(() => parseLocalRangeHold(extra)).toThrow('invalid_local_range_hold');
    const changed = rangeHoldFixture();
    changed.plan.requestedPaths = ['elsewhere'];
    expect(() => parseLocalRangeHold(changed)).toThrow();
  });
  it('never reports held with an unclosed writer, missing canonical fact or missing lease proof', () => {
    const value = rangeHoldFixture();
    expect(() => parseLocalRangeHold({ ...value, stage: 'heldByLeader' })).toThrow();
    expect(() => parseLocalRangeHold({ ...value, controlStage: 'committed' })).toThrow();
    expect(() =>
      parseLocalRangeHold({
        ...value,
        evidence: [{ phase: 'worker_closed', workerKey: 'other', ref: proof }],
      }),
    ).toThrow();
  });
  it('preserves the immutable plan and every stage proof instead of resetting a failed hold', () => {
    const before = rangeHoldFixture();
    const next = {
      ...before,
      controlStage: 'committed',
      evidence: [{ phase: 'canonical', workerKey: null, ref: proof }],
    };
    expect(() => assertLocalRangeTransition([before], [next])).not.toThrow();
    expect(() => assertLocalRangeTransition([next], [before])).toThrow();
    expect(() => assertLocalRangeTransition([next], [])).toThrow();
    const changed = structuredClone(next);
    const worker = changed.plan.cohort[0];
    if (!worker) throw Error('missing fixture worker');
    worker.sessionId = 'other';
    changed.planHash = localRecordHash(changed.plan);
    expect(() => assertLocalRangeTransition([next], [changed])).toThrow();
  });
  it('does not skip the held/return/capture/invalidation lifecycle to release a barrier', () => {
    const value = rangeHoldFixture();
    expect(() => parseLocalRangeHold({ ...value, stage: 'released' })).toThrow();
    expect(() => assertLocalRangeTransition([value], [{ ...value, stage: 'released' }])).toThrow();
  });
  it('matches aliases, nested roots and case aliases without conflating distinct worktree trees', () => {
    const base = rangeHoldFixture().plan.physical;
    expect(localRangesOverlap(base, { ...base, path: '/alias' })).toBe(true);
    expect(
      localRangesOverlap(base, {
        path: '/FIXTURE/sub',
        identity: '1:3',
        chain: [
          { path: '/', identity: '1:1' },
          { path: '/FIXTURE', identity: '1:2' },
          { path: '/FIXTURE/sub', identity: '1:3' },
        ],
      }),
    ).toBe(true);
    expect(
      localRangesOverlap(base, {
        path: '/other',
        identity: '1:4',
        chain: [
          { path: '/', identity: '1:1' },
          { path: '/other', identity: '1:4' },
        ],
      }),
    ).toBe(false);
  });
});

describe('versioned registry range envelope', () => {
  function withHold() {
    const registry = linkedRegistryFixture();
    const hold = rangeHoldFixture();
    const physical = registry.linkedRoots.find((r) => r.workspaceId === 'one');
    if (!physical) throw Error('missing fixture root');
    hold.plan.workspaceId = 'one';
    hold.plan.rootId = 'source';
    hold.plan.expectedRevision = 4;
    hold.plan.physical = {
      path: physical.path,
      identity: `${physical.dev}:${physical.inode}`,
      chain: physical.chain,
    };
    hold.plan.sourceMessage.display = hold.plan.sourceMessage.display
      .replace('"workspace"', '"one"')
      .replace('"expectedRevision":2', '"expectedRevision":4');
    hold.plan.sourceMessage.payload.intent = parseWorkspaceControl(hold.plan.sourceMessage.display);
    hold.planHash = localRecordHash(hold.plan);
    return { ...registry, schemaVersion: 'local-workspaces-v2', revision: 5, rangeHolds: [hold] };
  }
  it('explicitly upgrades to v2 and refuses hidden holds in v1 or missing v2 holds', () => {
    const next = withHold();
    expect(() => parseLocalRegistry(next)).not.toThrow();
    expect(() => assertLocalRegistryTransition(linkedRegistryFixture(), next)).not.toThrow();
    expect(() => parseLocalRegistry({ ...next, schemaVersion: 'local-workspaces-v1' })).toThrow();
    const { rangeHolds: _holds, ...incomplete } = next;
    expect(() => parseLocalRegistry(incomplete)).toThrow();
    expect(() =>
      assertLocalRegistryTransition(next, { ...linkedRegistryFixture(), revision: 6 }),
    ).toThrow();
  });
  it('rejects conflicting live holds and root identity substitution across projects', () => {
    const next = withHold();
    const other = structuredClone(next.rangeHolds[0]);
    if (!other) throw Error('missing hold');
    other.plan.takeoverId = 'other';
    other.planHash = localRecordHash(other.plan);
    expect(() =>
      parseLocalRegistry({ ...next, rangeHolds: [...next.rangeHolds, other] }),
    ).toThrow();
    const first = next.rangeHolds[0];
    if (!first) throw Error('missing hold');
    first.plan.physical.identity = '1:999';
    first.planHash = localRecordHash(first.plan);
    expect(() => parseLocalRegistry(next)).toThrow();
  });
  it('blocks new and existing capabilities before canonical closure while independent trees remain admissible', () => {
    const registry = parseLocalRegistry(withHold());
    const one = registry.workspaces.find((w) => w.workspaceId === 'one');
    const two = registry.workspaces.find((w) => w.workspaceId === 'two');
    if (!one || !two) throw Error('missing workspaces');
    expect(() => assertLocalRangeAdmission(registry, one, [])).toThrow('file_taken_over');
    expect(() => assertLocalRangeAdmission(registry, two, [])).not.toThrow();
    expect(() => assertLocalRangeAdmission(registry, two, [one])).toThrow('file_taken_over');
    expect(registry.operations.every((o) => o.stage === 'committed')).toBe(true);
  });
});
