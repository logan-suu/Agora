// Real APFS native effects, complete versions, private registry and journals.
// Only the already-confirmed authority/proposal ports are isolated here to
// inject item-boundary failures. Full Leader/Harness admission is covered by
// phase12-5-live-undo-proposal; this test qualifies inverse native tree effects.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import * as native from '../../../packages/runtime/sandbox/src/local-file-transaction';
import type {
  LocalUndoAuthority,
  LocalUndoCall,
} from '../../../packages/runtime/sandbox/src/local-undo-authority';
import { LocalUndoBatch } from '../../../packages/runtime/sandbox/src/local-undo-batch';
import type { LocalUndoProposalStore } from '../../../packages/runtime/sandbox/src/local-undo-proposal';
import {
  type LocalUndoTreeEffect,
  type LocalUndoTreeInput,
  planLocalUndoTree,
} from '../../../packages/runtime/sandbox/src/local-undo-tree-plan';
import { localFileVersion } from '../../../packages/runtime/sandbox/src/local-version-store';
import { localRootBinding } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['closed', 'later-no-effect', 'lost-item'] as const)(
  'executes and proves the actual inverse tree prefix without retrying historical native effects: %s',
  async (scenario) =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const helper = resolve(
              'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
            ),
            binding = localRootBinding(ctx.root),
            effects: LocalUndoTreeEffect[] = [],
            journalRoot = join(f.base, 'original-tree');
          mkdirSync(journalRoot, { mode: 0o700 });
          mkdirSync(join(f.root, 'old'), { mode: 0o750 });
          writeFileSync(join(f.root, 'old/code'), 'original deleted bytes\n', { mode: 0o750 });
          // Capture the nonempty directory without asserting it is empty.
          const oldMetadata = native.inspectLocalDirectoryMetadata(binding, 'old', helper),
            oldFile = native.inspectLocalFileBytes(binding, 'old/code', helper),
            common = {
              binding,
              helper,
              journalRoot,
              authorize: async () => {
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return true;
              },
            };
          const removed = await native.applyLocalDeletion({
            ...common,
            actionId: 'original-remove',
            path: 'old/code',
            expected: oldFile,
          });
          expect(removed).toMatchObject({ stage: 'applied', removed: true, quiescent: true });
          effects.push({
            operation: 'remove',
            path: 'old/code',
            effect: true,
            baseline: {
              path: 'old/code',
              version: localFileVersion(oldFile),
              metadata: oldFile.metadata,
              content: oldFile.content,
            },
            preserved: {
              candidateName: removed.candidateName,
              identity: oldFile.identity,
              metadata: oldFile.metadata,
            },
          });
          const removedDirectory = await native.applyLocalDirectoryDeletion({
            ...common,
            actionId: 'original-rmdir',
            path: 'old',
            expected: native.inspectLocalEmptyDirectoryBasis(binding, 'old', helper),
          });
          expect(removedDirectory).toMatchObject({
            stage: 'applied',
            removed: true,
            quiescent: true,
          });
          effects.push({
            operation: 'rmdir',
            path: 'old',
            effect: true,
            baseline: { path: 'old', ...oldMetadata },
            preserved: { candidateName: removedDirectory.candidateName, ...oldMetadata },
          });
          const createdDirectory = await native.applyLocalDirectoryCreation({
            ...common,
            actionId: 'original-mkdir',
            path: 'new',
            expected: native.inspectLocalCreationBasis(binding, 'new', helper),
          });
          expect(createdDirectory).toMatchObject({
            stage: 'applied',
            created: true,
            quiescent: true,
          });
          effects.push({
            operation: 'mkdir',
            path: 'new',
            effect: true,
            installed: {
              path: 'new',
              ...native.inspectLocalDirectoryMetadata(binding, 'new', helper),
            },
          });
          const absent = native.inspectLocalCreationBasis(binding, 'new/code', helper),
            bytes = Buffer.from([0, 255, 10]),
            created = await native.applyLocalCreation({
              ...common,
              actionId: 'original-create',
              path: 'new/code',
              expected: absent,
              content: bytes,
            });
          expect(created).toMatchObject({ stage: 'applied', created: true, quiescent: true });
          const createdFile = native.inspectLocalFileBytes(binding, 'new/code', helper);
          effects.push({
            operation: 'put',
            path: 'new/code',
            effect: true,
            kind: 'create',
            baselineVersion: {
              kind: 'absent',
              parentIdentity: absent.parentIdentity,
              name: 'code',
            },
            baselineMetadata: null,
            baseline: Buffer.alloc(0),
            installedVersion: localFileVersion(createdFile),
            installedMetadata: createdFile.metadata,
            installed: bytes,
          });
          const before = native.inspectLocalFileBytes(binding, 'file.txt', helper),
            agentBytes = Buffer.from('working\nagent addition\n'),
            replaced = await native.applyLocalReplacement({
              ...common,
              actionId: 'original-replace',
              path: 'file.txt',
              expected: before,
              content: agentBytes,
            });
          expect(replaced).toMatchObject({ stage: 'applied', exchanged: true, quiescent: true });
          const after = native.inspectLocalFileBytes(binding, 'file.txt', helper);
          effects.push({
            operation: 'put',
            path: 'file.txt',
            effect: true,
            kind: 'replace',
            baselineVersion: localFileVersion(before),
            baselineMetadata: before.metadata,
            baseline: before.content,
            installedVersion: localFileVersion(after),
            installedMetadata: after.metadata,
            installed: agentBytes,
          });
          writeFileSync(join(f.root, 'file.txt'), 'user working\nagent addition\n');
          writeFileSync(join(f.root, 'user.txt'), 'independent user addition\n');
          const version = await ctx.versions.capture(ctx.versionScope, binding, common.authorize),
            manifest = await ctx.versions.read(version, ctx.versionScope),
            tree: LocalUndoTreeInput = {
              directories: manifest.directories.map((d) => ({
                path: d.path,
                ...native.inspectLocalDirectoryMetadata(binding, d.path, helper),
              })),
              files: manifest.files.map((file) => {
                const basis = native.inspectLocalFileBytes(binding, file.path, helper);
                return {
                  path: file.path,
                  version: localFileVersion(basis),
                  metadata: basis.metadata,
                  content: basis.content,
                };
              }),
              protectedPaths: manifest.excludedPaths,
            },
            plan = planLocalUndoTree(effects, tree);
          expect(plan.kind).toBe('candidate');
          if (plan.kind !== 'candidate') throw Error('missing_actual_tree_candidate');
          expect(plan.items.map((i) => i.operation)).toEqual([
            'put',
            'remove',
            'rmdir',
            'restoreDirectory',
            'restoreFile',
          ]);
          const registry = await ctx.control.snapshot(),
            state = await ctx.store.load(ctx.scope),
            facts = {
              plan,
              tree,
              current: {
                rootId: ctx.root.rootId,
                policyHash: ctx.grant.policyHash,
                registryHash: await ctx.objects.put(registry),
              },
            },
            call: LocalUndoCall = {
              ...ctx.scope,
              workspaceId: 'inverse-native',
              actionId: `inverse-${scenario}`,
              claimId: `claim-${scenario}`,
              writerEpoch: 1,
              grantRevision: ctx.grant.revision,
              fileApplyReceiptId: `tree:${'a'.repeat(64)}`,
              inputHash: 'b'.repeat(64),
            };
          let assertions = 0,
            injected = false;
          const admitted = {
              registry,
              state,
              facts,
              bound: { binding, versionScope: ctx.versionScope },
            },
            authority = {
              assertCall: async () => {
                assertions++;
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return admitted;
              },
              pinObservation: async () => {
                if (scenario === 'later-no-effect' && !injected) {
                  const root = join(ctx.owner.root, 'local-workspaces', 'undo-transactions');
                  if (
                    existsSync(root) &&
                    readdirSync(root).some(
                      (name) =>
                        name.endsWith('-1') && existsSync(join(root, name, 'prepared.json')),
                    )
                  ) {
                    injected = true;
                    writeFileSync(join(f.root, 'new/code'), 'concurrent user replacement\n');
                  }
                }
                return {
                  admitted,
                  check: async () => {
                    await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                  },
                };
              },
            } as unknown as LocalUndoAuthority,
            proposals = { read: async () => facts } as unknown as LocalUndoProposalStore,
            batch = await LocalUndoBatch.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              authority,
              proposals,
              helper,
            ),
            bind = ctx.objects.bindReference.bind(ctx.objects);
          ctx.objects.bindReference = async (key, hash) => {
            const value = (await ctx.objects.get(hash)) as {
              schemaVersion?: string;
              index?: number;
            };
            if (
              scenario === 'lost-item' &&
              value.schemaVersion === 'local-undo-batch-item-v1' &&
              value.index === 1
            )
              throw Error('injected_item_persistence_loss');
            return bind(key, hash);
          };
          const userIndex = readFileSync(join(f.root, '.git/index')),
            result = await batch.apply(call);
          ctx.objects.bindReference = bind;
          const undoRoot = join(ctx.owner.root, 'local-workspaces', 'undo-transactions');
          writeFileSync(
            resolve(`test-outputs/task125-native-inverse-${scenario}.json`),
            JSON.stringify(
              {
                result,
                journals: readdirSync(undoRoot).map((action) => ({
                  action,
                  records: Object.fromEntries(
                    readdirSync(join(undoRoot, action))
                      .filter((name) => name.endsWith('.json'))
                      .map((name) => [
                        name,
                        JSON.parse(readFileSync(join(undoRoot, action, name), 'utf8')),
                      ]),
                  ),
                })),
              },
              null,
              2,
            ),
          );
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('user working\n');
          expect(readFileSync(join(f.root, 'user.txt'), 'utf8')).toBe(
            'independent user addition\n',
          );
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          if (scenario === 'closed') {
            expect(result).toMatchObject({ stage: 'applied', attempted: 5, closed: true });
            expect(result.items).toHaveLength(5);
            expect(existsSync(join(f.root, 'new'))).toBe(false);
            expect(readFileSync(join(f.root, 'old/code'))).toEqual(oldFile.content);
            expect(
              `${statSync(join(f.root, 'old/code')).dev}:${statSync(join(f.root, 'old/code')).ino}`,
            ).toBe(oldFile.identity);
            expect(
              `${statSync(join(f.root, 'old')).dev}:${statSync(join(f.root, 'old')).ino}`,
            ).toBe(oldMetadata.identity);
            await batch.verifyCurrent(call, result);
          } else if (scenario === 'later-no-effect') {
            expect(result).toMatchObject({ stage: 'partial', attempted: 2, closed: true });
            expect(result.items).toHaveLength(2);
            expect(readFileSync(join(f.root, 'new/code'), 'utf8')).toBe(
              'concurrent user replacement\n',
            );
            expect(existsSync(join(f.root, 'old'))).toBe(false);
          } else {
            expect(result).toMatchObject({
              stage: 'recoveryRequired',
              attempted: 2,
              closed: false,
            });
            expect(result.items).toHaveLength(1);
            expect(existsSync(join(f.root, 'new/code'))).toBe(false);
            expect(existsSync(join(f.root, 'old'))).toBe(false);
          }
          const count = assertions;
          writeFileSync(join(f.root, 'file.txt'), 'later user content after inverse\n');
          expect(await batch.apply(call)).toEqual(result);
          expect(await batch.readHistory(call)).toEqual(result);
          expect(assertions).toBe(count);
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe(
            'later user content after inverse\n',
          );
        },
        false,
        true,
      ),
    ),
  180_000,
);
