// Real grant/registry/Git/native admission; canonical fixture facts stand in for
// completed business dispatch only. This is not a model or cumulative-merge G5.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import {
  applyLocalCreation,
  inspectLocalCreationBasis,
} from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalIntegrationAuthority } from '../../../packages/runtime/sandbox/src/local-integration-authority';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { prepareIntegration, registeredFixture } from './local-linked-workspace-fixture';

async function integrationFixture(
  run: (
    input: Awaited<ReturnType<typeof prepareIntegration>>,
    f: Parameters<Parameters<typeof fixture>[0]>[0],
  ) => Promise<void>,
) {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => run(await prepareIntegration(ctx), f)),
  );
}

it('persists integration admission without a fake worker and refuses stale control', async () => {
  const { LocalIntegrationAuthority } = await import(
    '../../../packages/runtime/sandbox/src/local-integration-authority'
  );
  await integrationFixture(async ({ ctx, request, physical }) => {
    let live = true;
    const authority = new LocalIntegrationAuthority({
      ...ctx,
      assertControl: async () => {
        if (!live) throw Error('integration_control_closed');
      },
      verifyClosure: async () => {
        throw Error('unclosed_test_operation');
      },
    });
    const call = await authority.acquire(request);
    const snapshot = await ctx.control.snapshot();
    const claim = snapshot.claims.find((c) => c.claimId === call.claimId);
    expect(claim?.kind).toBe('integration');
    expect(claim).not.toHaveProperty('workerId');
    expect((await ctx.control.assertClosed(ctx.scope)).workers).toHaveLength(2);
    expect(await authority.acquire(request)).toEqual(call);
    expect((await ctx.control.snapshot()).revision).toBe(snapshot.revision);
    expect((await authority.assertCall(call, 'edit')).binding.root).toBe(physical.path);
    await expect(authority.assertCall(call, 'remove')).rejects.toThrow('authorization_closed');
    await expect(
      authority.assertCall({ ...call, writerEpoch: call.writerEpoch + 1 }, 'read'),
    ).rejects.toThrow();
    await expect(
      authority.acquire({
        ...request,
        actionId: 'duplicate',
        expectedRevision: snapshot.revision,
      }),
    ).rejects.toThrow('workspace_busy');
    await expect(authority.release(call)).rejects.toThrow('unclosed_test_operation');
    expect(
      (await ctx.control.snapshot()).claims.find((c) => c.claimId === call.claimId)?.status,
    ).toBe('draining');
    await expect(authority.assertCall(call, 'edit')).rejects.toThrow('integration_claim_closed');
    live = false;
    await expect(authority.assertCall(call, 'read')).rejects.toThrow('integration_control_closed');
    await expect(authority.acquire(request)).rejects.toThrow('integration_control_closed');
  });
}, 60_000);

it.each([
  'acquire-before',
  'acquire-after',
  'drain-before',
  'drain-after',
  'release-before',
  'release-after',
])(
  'recovers the same durable integration lifecycle after %s',
  async (fault) =>
    integrationFixture(async ({ ctx, request, integration }, f) => {
      let proof: Awaited<ReturnType<typeof applyLocalCreation>> | undefined;
      const options = {
        ...ctx,
        assertControl: async () => {},
        verifyClosure: async () => {
          if (
            proof?.stage !== 'applied' ||
            !proof.quiescent ||
            proof.nativeExitCode !== 0 ||
            localRecordHash(
              JSON.parse(readFileSync(join(proof.journalPath, 'result.json'), 'utf8')),
            ) !== localRecordHash(proof)
          )
            throw Error('integration_not_quiescent');
          return `closure:${localRecordHash(proof)}`;
        },
      };
      let authority = new LocalIntegrationAuthority(options);
      const originalCommit = ctx.store.commit.bind(ctx.store);
      const installFault = () => {
        let armed = true;
        ctx.store.commit = async (scope, mutations) => {
          const update = mutations.find((m) => m.op === 'set' && m.field === 'localExecution');
          const value =
            update && 'value' in update
              ? (update.value as { receipts: { actionId: string }[] })
              : undefined;
          const action = value?.receipts.at(-1)?.actionId;
          const matches =
            armed &&
            (fault.startsWith('acquire')
              ? action === request.actionId
              : action?.startsWith(fault.startsWith('drain') ? 'drain:' : 'release:'));
          if (matches) armed = false;
          if (matches && fault.endsWith('before')) throw Error('injected_control_interruption');
          const result = await originalCommit(scope, mutations);
          if (matches) throw Error('injected_control_interruption');
          return result;
        };
      };
      const rebuild = async () => {
        ctx.store.commit = originalCommit;
        const control = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
        authority = new LocalIntegrationAuthority({ ...options, control });
        return control;
      };
      if (fault.startsWith('acquire')) {
        installFault();
        await expect(authority.acquire(request)).rejects.toThrow('injected_control_interruption');
        await expect(ctx.control.assertClosed(ctx.scope)).rejects.toThrow(
          'registry_recovery_required',
        );
        await rebuild();
      }
      const call = await authority.acquire(request);
      const admitted = await authority.assertCall(call, 'edit');
      const journalRoot = join(f.base, 'integration-native');
      mkdirSync(journalRoot, { mode: 0o700 });
      const helper = resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64');
      proof = await applyLocalCreation({
        actionId: 'control-proof',
        path: 'control.txt',
        binding: admitted.binding,
        expected: inspectLocalCreationBasis(admitted.binding, 'control.txt', helper),
        content: 'fixed integration control proof\n',
        helper,
        journalRoot,
        authorize: async () => {
          await authority.assertCall(call, 'edit');
          return true;
        },
      });
      expect(proof.stage).toBe('applied');
      writeFileSync(
        join(f.privateRoot, 'integration-native-proof.json'),
        JSON.stringify({
          call,
          proof,
          prepared: JSON.parse(readFileSync(join(proof.journalPath, 'prepared.json'), 'utf8')),
          native: JSON.parse(readFileSync(join(proof.journalPath, 'native.json'), 'utf8')),
        }),
      );
      if (fault.startsWith('release')) {
        await ctx.store.commit(ctx.scope, [
          {
            op: 'set',
            field: 'integration',
            value: {
              ...integration,
              status: 'done',
              mergedBranches: integration.pendingBranches.map((branch) => ({
                workerId: branch.workerId,
                subtaskId: branch.subtaskId,
                branch: branch.worktree.branch,
                headCommit: branch.worktree.headCommit,
                mergeCommit: integration.base.commit,
              })),
              resultCommit: integration.base.commit,
            },
          },
        ]);
        await expect(authority.assertCall(call, 'edit')).rejects.toThrow(
          'integration_assignment_mismatch',
        );
      }
      if (!fault.startsWith('acquire')) {
        installFault();
        await expect(authority.release(call)).rejects.toThrow('injected_control_interruption');
        await expect(ctx.control.assertClosed(ctx.scope)).rejects.toThrow(
          'registry_recovery_required',
        );
        await rebuild();
      }
      await authority.release(call);
      const final = await ctx.control.snapshot();
      const claims = final.claims.filter((c) => c.kind === 'integration');
      expect(claims).toHaveLength(1);
      expect(claims[0]?.status).toBe('released');
      expect(claims[0]?.writerEpoch).toBe(call.writerEpoch);
      expect(claims[0]?.closureReceiptId).toBe(`closure:${localRecordHash(proof)}`);
      await expect(authority.assertCall(call, 'edit')).rejects.toThrow(
        fault.startsWith('release')
          ? 'integration_assignment_mismatch'
          : 'integration_claim_closed',
      );
      await authority.release(call);
      expect(localRecordHash(await ctx.control.snapshot())).toBe(localRecordHash(final));
      expect(final.operations.filter((o) => o.actionId.startsWith('drain:'))).toHaveLength(1);
      expect(final.operations.filter((o) => o.actionId.startsWith('release:'))).toHaveLength(1);
      expect(readFileSync(join(admitted.binding.root, 'control.txt'), 'utf8')).toBe(
        'fixed integration control proof\n',
      );
    }),
  60_000,
);
