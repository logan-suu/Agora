// Real POST handler, MessageRuntime, desktop owner, registry and Seatbelt inspector.
// Fault wrappers stop only the trusted commit to exercise durable crash recovery.
// Use current build:sandbox-native artifacts; compiling per case is not grant behavior.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { createLocalWorkspaceCatalog } from '@agora/tools-bridge';
import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalFixedInputs } from '../../../packages/runtime/sandbox/src/local-fixed-inputs';
import {
  LocalGrantController,
  type LocalGrantPolicy,
} from '../../../packages/runtime/sandbox/src/local-grant-controller';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalRootCoordinator } from '../../../packages/runtime/sandbox/src/local-root-coordinator';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { LocalWorkspaceApply } from '../../../packages/runtime/sandbox/src/local-workspace-apply';
import {
  LocalWorkspaceAuthority,
  localRootBinding,
} from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceCommands } from '../../../packages/runtime/sandbox/src/local-workspace-commands';
import { LocalWorkspaceDownloads } from '../../../packages/runtime/sandbox/src/local-workspace-downloads';
import { LocalWorkspaceFiles } from '../../../packages/runtime/sandbox/src/local-workspace-files';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { bindLocalWorkspaceTools } from '../../../packages/runtime/sandbox/src/local-workspace-tools';
import type { WorkspaceWorkerSession } from '../../../packages/runtime/sandbox/src/workspace-worker-port';

import { exerciseLocalValidation } from './local-validation-fixture';

const scope = { projectId: 'project', taskId: 'task' };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
for (const scenario of [
  'normal',
  'generation',
  'installation',
  'download',
  'file-update',
  'file-create',
  'file-proof',
  'command',
  'mcp',
  'mcp-partial',
  'reader',
  'mcp-command',
  'trusted-validation',
  'terminal-release-before',
  'terminal-release-after',
  'worker-companion',
  'successor-companion',
  'missing-closure-companion',
  'tester-companion',
  'reviewer-companion',
  'pm-companion',
  'coordinator-companion',
  'batch',
  'batch-partial',
  'batch-read-drift',
  'batch-stale',
  'before',
  'after',
  'wrong-hash',
  'wrong-selection',
  'wrong-scope',
  'stale-policy',
  'root-drift',
  'corrupt-proposal',
  'unsupported-action',
])
  it(
    `confirms a durable grant through the real Leader POST: ${scenario}`,
    async () => {
      const companion = scenario.endsWith('-companion');
      const companionRole =
        scenario === 'tester-companion'
          ? 'TESTER'
          : scenario === 'reviewer-companion'
            ? 'REVIEWER'
            : scenario === 'pm-companion'
              ? 'PM'
              : scenario === 'coordinator-companion'
                ? 'COORDINATOR'
                : 'CODER';
      const validationScenario = [
        'trusted-validation',
        'terminal-release-before',
        'terminal-release-after',
      ].includes(scenario);
      const commandScenario =
        ['command', 'mcp-command', 'generation', 'installation'].includes(scenario) ||
        validationScenario;
      const executionScenario =
        [
          'download',
          'file-update',
          'file-create',
          'file-proof',
          'command',
          'mcp',
          'mcp-partial',
          'reader',
          'mcp-command',
          'worker-companion',
        ].includes(scenario) ||
        scenario.startsWith('batch') ||
        companion ||
        commandScenario;
      const base = mkdtempSync('/private/tmp/agora-task123-validation-'),
        identity = lstatSync(base);
      const root = join(base, 'project');
      const builtHelper = (name: string) => {
        const path = resolve(
          'packages/runtime/sandbox/build',
          `${name}-${process.platform}-${process.arch}`,
        );
        return { path, sha256: hash(readFileSync(path)) };
      };
      const nativeHelpers = {
        inspector: builtHelper('local-root-inspection'),
        initializer: builtHelper('local-root-initialization'),
        files: builtHelper('local-file-transaction'),
      };
      const inspector = nativeHelpers.inspector.path;
      mkdirSync(root);
      writeFileSync(join(root, 'sentinel'), 'fixed user content');
      if (scenario === 'batch-read-drift')
        writeFileSync(join(root, 'dependency'), 'fixed dependency');
      if (validationScenario)
        writeFileSync(
          join(root, 'sentinel.test.cjs'),
          `const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('source bytes',()=>assert.equal(fs.readFileSync(__dirname+'/sentinel','utf8'),'fixed user content')); test('read-only input',()=>assert.throws(()=>fs.writeFileSync(__dirname+'/sentinel','unauthorized'), e=>['EPERM','EACCES'].includes(e.code)));`,
        );
      if (scenario === 'installation') {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'fixed-installation',
            version: '1.0.0',
            private: true,
            devDependencies: { picocolors: '1.1.1' },
            scripts: {
              postinstall: "node -e \"require('node:fs').writeFileSync('installed','yes')\"",
            },
          }),
        );
        writeFileSync(
          join(root, 'sentinel.test.cjs'),
          `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('installed dependency',()=>assert.equal(require('picocolors/package.json').version,'1.1.1'));test('fixed source',()=>assert.equal(fs.readFileSync(__dirname+'/sentinel','utf8'),'fixed user content'));`,
        );
      }
      let raceEnabled = false,
        raced = false;
      if (commandScenario)
        writeFileSync(
          join(root, 'verify.cjs'),
          `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync(__dirname + '/sentinel', 'utf8'), 'fixed user content');
for (const path of ${scenario === 'generation' ? "[process.argv[3] + '/sentinel']" : "[__dirname + '/sentinel', process.argv[3] + '/sentinel']"}) {
  assert.throws(() => fs.writeFileSync(path, 'unauthorized write'), error => ['EPERM', 'EACCES'].includes(error.code));
}
assert.throws(() => fs.readFileSync(process.argv[2]), error => ['EPERM', 'EACCES'].includes(error.code));
assert.throws(() => fs.readFileSync(process.argv[3] + '/sentinel'), error => ['EPERM', 'EACCES'].includes(error.code));
fs.writeFileSync('build-result.json', JSON.stringify({ value: 42, tested: true }));
${scenario === 'generation' ? "fs.writeFileSync('generated.txt', 'fixed generated bytes'); fs.writeFileSync('sentinel', 'private generated edit');" : ''}
console.log('fixed input build and test passed');
`,
        );
      const toolsRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
      const manifestBytes = commandScenario ? readFileSync(join(toolsRoot, 'manifest.json')) : null;
      const owner = await acquireState(join(base, 'state'));
      const evidence: Record<string, unknown> = {
        base,
        scenario,
        nativeHelpers,
        identity: { dev: identity.dev, ino: identity.ino },
        startedAt: new Date().toISOString(),
      };
      const initialEvidenceFolder = resolve('test-outputs/reviews/task123-grant-evidence');
      mkdirSync(initialEvidenceFolder, { recursive: true });
      writeFileSync(
        join(initialEvidenceFolder, `${scenario}-${basename(base)}.json`),
        JSON.stringify(evidence, null, 2),
      );
      let failure: unknown;
      try {
        const stream = new ChannelStream();
        const runtime = new MessageRuntime(join(owner.root, 'tasks'), stream, DEFAULT_ROSTER);
        await runtime.initializeState(
          scope,
          createInitialAppState(scope.taskId, 'fixed grant control', scope.projectId),
        );
        let interrupted = false,
          registering = false;
        const control = await LocalBindingCoordinator.open(
          owner,
          {
            load: (s) => runtime.store.load(s),
            commit: async (s, mutations) => {
              expect(mutations.map((m) => `${m.op}:${m.field}`)).toEqual(
                registering ? ['set:localExecution'] : ['append:messages', 'set:localExecution'],
              );
              if (!interrupted && scenario === 'before') {
                interrupted = true;
                throw Error('fixed interruption');
              }
              const releasing = mutations.some(
                (m) =>
                  m.op === 'set' &&
                  m.field === 'localExecution' &&
                  JSON.stringify(m.value).includes('release:'),
              );
              if (!interrupted && releasing && scenario === 'terminal-release-before') {
                interrupted = true;
                throw Error('fixed terminal release interruption');
              }
              const result = await runtime.commitMutations(s, mutations);
              if (!interrupted && releasing && scenario === 'terminal-release-after') {
                interrupted = true;
                throw Error('fixed terminal release interruption');
              }

              if (!interrupted && scenario === 'after') {
                interrupted = true;
                throw Error('fixed interruption');
              }
              return result;
            },
          },
          true,
        );
        let configuration: LocalGrantPolicy = {
          version: 'seatbelt-apfs-v1',
          actions: ['download', 'installation'].includes(scenario)
            ? ['read', 'edit', 'install', 'run']
            : scenario === 'generation'
              ? ['read', 'edit', 'run', 'generate']
              : commandScenario || scenario === 'reader'
                ? ['read', 'edit', 'run']
                : ['read', 'edit'],
          toolchain: { manifestHash: manifestBytes ? hash(manifestBytes) : 'a'.repeat(64) },
          network: ['download', 'installation'].includes(scenario)
            ? {
                mode: 'brokered-https',
                origins: ['https://registry.npmjs.org'],
                method: 'GET',
                maxBytes: 16777216,
                timeoutMs: 30000,
                maxRedirects: 3,
              }
            : { mode: 'disabled' },
          outputs: { kind: 'private-per-operation' },
        };
        const controller = await LocalGrantController.open(
          owner,
          control,
          runtime.store,
          inspector,
          async () => configuration,
        );
        runtime.bindWorkspaceControlPort(controller);
        await expect(
          controller.prepareGrant(scope, { selectionRef: 'private', path: owner.root }),
        ).rejects.toThrow('workspace_private_root_forbidden');
        const proposed = await controller.prepareGrant(scope, {
          selectionRef: 'selection',
          path: root,
        });
        expect((await control.snapshot()).revision).toBe(0);
        expect(readdirSync(root)).toEqual(
          scenario === 'batch-read-drift'
            ? ['dependency', 'sentinel']
            : commandScenario
              ? scenario === 'installation'
                ? ['package.json', 'sentinel', 'sentinel.test.cjs', 'verify.cjs']
                : validationScenario
                  ? ['sentinel', 'sentinel.test.cjs', 'verify.cjs']
                  : ['sentinel', 'verify.cjs']
              : ['sentinel'],
        );
        const body = {
          ...scope,
          actionId: 'grant-action',
          expectedRevision: proposed.proposal.expectedRevision,
          selectionRef: 'selection',
          policyProposalId: proposed.policyProposalId,
          inputHash: proposed.inputHash,
        };
        if (scenario === 'wrong-hash') body.inputHash = 'f'.repeat(64);
        if (scenario === 'wrong-selection') body.selectionRef = 'other';
        if (scenario === 'wrong-scope') body.taskId = 'other';
        if (scenario === 'stale-policy') configuration = { ...configuration, actions: ['read'] };
        if (scenario === 'root-drift') {
          renameSync(root, join(base, 'old-root'));
          mkdirSync(root);
        }
        if (scenario === 'corrupt-proposal') {
          const file = join(
            owner.root,
            'local-workspaces',
            'objects',
            `${proposed.inputHash}.json`,
          );
          chmodSync(file, 0o600);
          writeFileSync(file, '{}');
          chmodSync(file, 0o400);
        }
        const display =
          scenario === 'unsupported-action'
            ? `/workspace revoke ${JSON.stringify({ ...scope, actionId: body.actionId, expectedRevision: 0, grantId: 'grant' })}`
            : `/workspace grant ${JSON.stringify(body)}`;
        const request = () =>
          new Request('http://localhost/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...scope, channelId: 'main', msgId: body.actionId, display }),
          });
        const post = createPostMessage(runtime);
        const eventStates: Promise<unknown>[] = [];
        const off = stream.subscribe({ ...scope, channelId: 'main' }, (event) => {
          if (event.type === 'message') eventStates.push(runtime.store.load(scope));
        });
        try {
          const response = await post(request());
          evidence.firstResponse = { status: response.status, body: await response.json() };
          const success = executionScenario || ['normal', 'before', 'after'].includes(scenario);
          expect(response.status).toBe(executionScenario || scenario === 'normal' ? 202 : 409);
          if (success) {
            if (scenario === 'before' || scenario === 'after') {
              const state = await runtime.store.load(scope);
              expect(state?.messages.some((m) => m.msgId === body.actionId)).toBe(
                scenario === 'after',
              );
              expect(state?.localExecution !== undefined).toBe(scenario === 'after');
              await expect(control.assertClosed(scope)).rejects.toThrow(
                'registry_recovery_required',
              );
            }
            if (['normal', 'before', 'after'].includes(scenario)) {
              const retry = await post(request());
              expect(retry.status).toBe(202);
            }
            const closed = await control.assertClosed(scope),
              snapshot = await control.snapshot();
            expect(closed.messages.filter((m) => m.msgId === body.actionId)).toHaveLength(1);
            expect(closed.localExecution?.receipts).toHaveLength(1);
            expect(snapshot.grants).toHaveLength(1);
            expect(snapshot.grants[0]?.leaderMessageId).toBe(body.actionId);
            expect(snapshot.roots[0]?.staging).toBeNull();
            expect(snapshot.revision).toBe(2);
            const operation = snapshot.operations.find((o) => o.actionId === body.actionId);
            expect(closed.messages.find((m) => m.msgId === body.actionId)?.ts).toBe(
              operation && 'sourceMessage' in operation ? operation.sourceMessage?.ts : undefined,
            );
            if (['normal', 'before', 'after'].includes(scenario)) {
              const changed = await post(
                new Request('http://localhost/api/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...scope,
                    channelId: 'main',
                    msgId: body.actionId,
                    display: `/workspace grant ${JSON.stringify({ ...body, selectionRef: 'different' })}`,
                  }),
                }),
              );
              expect(changed.status).toBe(409);
              expect((await control.snapshot()).revision).toBe(2);
              const duplicateProposal = await post(
                new Request('http://localhost/api/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...scope,
                    channelId: 'main',
                    msgId: 'second-action',
                    display: `/workspace grant ${JSON.stringify({ ...body, actionId: 'second-action' })}`,
                  }),
                }),
              );
              expect(duplicateProposal.status).toBe(409);
              expect((await control.snapshot()).revision).toBe(2);
            }
            expect(eventStates).toHaveLength(1);
            for (const observed of await Promise.all(eventStates))
              expect(observed).toMatchObject({
                localExecution: { rootIds: closed.localExecution?.rootIds },
                messages: expect.arrayContaining([
                  expect.objectContaining({ msgId: body.actionId }),
                ]),
              });
            if (executionScenario) {
              const initializer = nativeHelpers.initializer.path;
              const roots = await LocalRootCoordinator.open(owner, control, {
                inspector,
                initializer,
              });
              const grant = snapshot.grants[0];
              if (!grant) throw Error('missing canonical grant');
              const initialized = await roots.initialize({
                ...scope,
                actionId: 'initialize-root',
                rootId: grant.rootId,
                grantId: grant.grantId,
                expectedRevision: snapshot.revision,
              });
              expect(initialized.stage).toBe('committed');
              expect(initialized.nativeReceipt).toMatchObject({
                stage: 'applied',
                created: true,
                quiescent: true,
              });
              expect((await control.snapshot()).roots[0]?.staging?.identity).toBe(
                initialized.nativeReceipt?.stagingIdentity,
              );
              expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('fixed user content');
              evidence.initialization = initialized;
              const filesHelper = nativeHelpers.files.path;
              const objects = await LocalControlObjects.open(owner),
                versions = new LocalVersionStore(objects, filesHelper);
              const registeredRoot = (await control.snapshot()).roots[0];
              if (!registeredRoot) throw Error('missing root');
              const version = await versions.capture(
                { ...scope, rootId: grant.rootId, policyHash: grant.policyHash },
                localRootBinding(registeredRoot),
                async () => {
                  await control.assertClosed(scope);
                  return true;
                },
              );
              await runtime.commitMutations(scope, [
                mergeByIdMutation('subtasks', 'work', {
                  title: 'Fixed task',
                  ownerRole: 'CODER',
                  status: 'in_progress',
                  dependsOn: [],
                }),
                mergeByIdMutation('workers', 'worker', {
                  ...(companionRole === 'CODER' ? { subtaskId: 'work' } : {}),
                  role: companionRole,
                  executor: 'harness',
                  status: companion ? 'pending' : 'running',
                  startedTs: 1,
                }),
              ]);
              if (companion) {
                registering = true;
                const local = await LocalWorkspaceSessions.create({
                  owner,
                  control,
                  roots,
                  objects,
                  versions,
                  filesHelper,
                  verifyGrant: (s, id) => controller.assertGrant(s, id),
                  grantForAssignment: async () => grant.grantId,
                  versionForAssignment: async () => version,
                });
                const scheduler = new GlobalScheduler({ cap: 1 });
                let savedSession: WorkspaceWorkerSession | undefined;
                const isControl = ['PM', 'COORDINATOR'].includes(companionRole);
                let steps = 0;
                const workerRuntime = new WorkerRuntime(
                  {
                    roster: DEFAULT_ROSTER,
                    loadState: () => runtime.store.load(scope),
                    transition: async (_old, mutations) =>
                      (await runtime.commitMutations(scope, mutations)).state,
                    localWorkspace: local,
                    buildExecutor: () => {
                      throw Error('legacy path invoked');
                    },
                    buildLocalControlExecutor: async (spec, _assignment, session) => {
                      expect(spec.role).toBe(companionRole);
                      expect(session.kind).toBe('control');
                      expect(session).not.toHaveProperty('tools');
                      expect(session).not.toHaveProperty('workspace');
                      expect((await control.snapshot()).claims).toEqual([]);
                      return {
                        async step(step) {
                          expect(step.view.slices).not.toHaveProperty('localWorkspace');
                          steps++;
                          return {
                            kind: 'done',
                            output: {},
                            reachedSafeBoundary: true,
                            mutations: [],
                          };
                        },
                        async saveSafePoint() {
                          return 'fixed-control-safe-point';
                        },
                        async loadSafePoint() {},
                        injectInbox() {},
                      };
                    },
                    buildLocalExecutor: async (_spec, _assignment, session) => {
                      savedSession = session;
                      expect(session.workspace.purpose).toBe(
                        companionRole === 'CODER' ? 'coding' : 'validation',
                      );
                      expect(
                        (await control.snapshot()).claims.filter(
                          (claim) => claim.status === 'active',
                        ),
                      ).toHaveLength(companionRole === 'CODER' ? 1 : 0);
                      if (companionRole !== 'CODER')
                        writeFileSync(join(root, 'sentinel'), 'external newer version');
                      const catalog = await createLocalWorkspaceCatalog({
                        port: session.tools,
                        sessionId: session.sessionId,
                        capabilities: ['read'],
                      });
                      const context = new Context();
                      await context.plugin(SystemPrompt);
                      await context.plugin(ToolRuntime);
                      for (const tool of catalog.all()) context.tools.register(tool);
                      return {
                        async step(step) {
                          expect(step.view.slices.localWorkspace).toEqual(session.workspace);
                          if (companionRole !== 'CODER') {
                            expect(step.view.slices.assignment).not.toHaveProperty('subtaskId');
                            expect(
                              (await session.tools.inspect(`tool:${'d'.repeat(64)}`)).version,
                            ).toEqual(version);
                          }
                          const result = await context.tools.execute({
                            name: 'workspace_read',
                            arguments: { path: 'sentinel' },
                            callId: CallId('worker-read'),
                            signal: new AbortController().signal,
                          });
                          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
                          expect(result.value).toMatchObject({
                            content: 'fixed user content',
                            encoding: 'utf8',
                          });
                          steps++;
                          await catalog.dispose();
                          return {
                            kind: 'done',
                            output: {},
                            reachedSafeBoundary: true,
                            mutations: [],
                          };
                        },
                        async saveSafePoint() {
                          return 'fixed-test-safe-point';
                        },
                        async loadSafePoint() {},
                        injectInbox() {},
                      };
                    },
                  },
                  scheduler,
                );
                const start = await runtime.store.load(scope);
                if (!start) throw Error('missing state');
                const finished = await workerRuntime.runOne(start, {
                  workerId: 'worker',
                  role: companionRole,
                  ...(companionRole === 'CODER' ? { subtaskId: 'work' } : {}),
                });
                expect(steps).toBe(1);
                expect(finished.workers[0]?.status).toBe('done');
                expect(finished.workers[0]?.worktree).toBeUndefined();
                expect(scheduler.activeCount).toBe(0);
                if (companionRole !== 'CODER' && !isControl)
                  expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                    'external newer version',
                  );
                if (isControl) {
                  expect(finished.localExecution?.bindings).toEqual([]);
                  expect(finished.localExecution?.workspaces).toEqual([]);
                } else {
                  if (!savedSession) throw Error('missing local session');
                  await expect(
                    savedSession.tools.read(`tool:${'a'.repeat(64)}`, 'sentinel'),
                  ).rejects.toThrow('workspace_worker_capability_closed');
                }
                if (scenario === 'missing-closure-companion') {
                  const closures = [];
                  for (const ref of await objects.references()) {
                    const value = (await objects.get(ref.valueHash)) as {
                      schemaVersion?: string;
                      reason?: string;
                    };
                    if (
                      value.schemaVersion === 'workspace-worker-boundary-v1' &&
                      value.reason === 'close'
                    )
                      closures.push(ref);
                  }
                  expect(closures).toHaveLength(1);
                  const closure = closures[0];
                  if (!closure) throw Error('missing fixture closure');
                  unlinkSync(join(owner.root, 'local-workspaces', 'objects', `${closure.key}.ref`));
                  await expect(
                    workerRuntime.runOne(finished, {
                      workerId: 'successor',
                      role: 'CODER',
                      subtaskId: 'work',
                    }),
                  ).rejects.toThrow('workspace_claim_closure_unavailable');
                  expect(
                    (await control.snapshot()).claims.map((c) => ({
                      workerId: c.workerId,
                      status: c.status,
                    })),
                  ).toEqual([{ workerId: 'worker', status: 'active' }]);
                  expect(scheduler.activeCount).toBe(0);
                  evidence.removedClosure = closure;
                }
                if (scenario === 'successor-companion') {
                  const next = await workerRuntime.runOne(finished, {
                    workerId: 'successor',
                    role: 'CODER',
                    subtaskId: 'work',
                  });
                  expect(steps).toBe(2);
                  expect(next.workers.find((w) => w.workerId === 'successor')?.status).toBe('done');
                  const claims = (await control.snapshot()).claims;
                  expect(
                    claims.filter((c) => c.status === 'active').map((c) => c.workerId),
                  ).toEqual(['successor']);
                  expect(
                    claims.filter((c) => c.status === 'released').map((c) => c.workerId),
                  ).toEqual(['worker']);
                  expect(
                    claims.find((c) => c.workerId === 'successor')?.writerEpoch,
                  ).toBeGreaterThan(claims.find((c) => c.workerId === 'worker')?.writerEpoch ?? 0);
                  evidence.successor = { state: next, claims };
                }
                evidence.workerCompanion = {
                  steps,
                  state: finished,
                  activeLeases: scheduler.activeCount,
                  executor: 'scripted lifecycle driver; not Harness G5',
                };
              } else {
                const scheduler = new GlobalScheduler({ cap: 1 }),
                  lease = await scheduler.acquire(scope.projectId, scope.taskId, 'worker');
                try {
                  const authority = new LocalWorkspaceAuthority(
                    control,
                    roots,
                    versions,
                    (call) => {
                      scheduler.assertActive(lease);
                      // Simulate an external editor only after the first real exchange.
                      if (
                        raceEnabled &&
                        !raced &&
                        readFileSync(join(root, 'sentinel'), 'utf8') === 'batch result'
                      ) {
                        raced = true;
                        writeFileSync(
                          join(
                            root,
                            ['batch-partial', 'mcp-partial'].includes(scenario)
                              ? 'new.txt'
                              : 'dependency',
                          ),
                          'external edit',
                        );
                      }

                      if (
                        call.projectId !== lease.projectId ||
                        call.taskId !== lease.taskId ||
                        call.workerId !== lease.workerId
                      )
                        throw Error('lease_scope_mismatch');
                    },
                    (s, grantId) => controller.assertGrant(s, grantId),
                  );
                  const registration = {
                    ...scope,
                    actionId: 'register',
                    rootId: grant.rootId,
                    grantId: grant.grantId,
                    workspaceId: 'workspace',
                    workerId: 'worker',
                    subtaskId: 'work',
                    version,
                    expectedRevision: (await control.snapshot()).revision,
                  };
                  registering = true;
                  const workspace = await authority.register(registration);
                  if (scenario === 'file-update')
                    expect(await authority.register(registration)).toEqual(workspace);
                  const claim = (await control.snapshot()).claims[0];
                  if (!claim) throw Error('missing claim');
                  const call = {
                    ...scope,
                    workspaceId: workspace.workspaceId,
                    workerId: 'worker',
                    actionId: 'read-file',
                    grantRevision: grant.revision,
                    writerEpoch: claim.writerEpoch,
                  };
                  expect((await authority.assertCall(call, 'read')).workspace).toEqual(workspace);
                  const files = new LocalWorkspaceFiles(authority, objects, filesHelper);
                  const read = await files.readFile(call, 'sentinel');
                  expect(read.kind).toBe('file');
                  if (read.kind !== 'file') throw Error('missing file receipt');
                  expect(read.content.toString()).toBe('fixed user content');
                  if (scenario === 'file-update')
                    expect(await files.readFile(call, 'sentinel')).toEqual(read);
                  const writer = await LocalWorkspaceApply.open(
                    owner,
                    authority,
                    objects,
                    files,
                    filesHelper,
                  );
                  if (scenario === 'download') {
                    const downloads = new LocalWorkspaceDownloads(
                      authority,
                      objects,
                      versions,
                      writer,
                    );
                    const downloadCall = { ...call, actionId: 'download-package' };
                    const request = {
                      inputVersion: version,
                      url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
                      integrity:
                        'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
                    };
                    const receipt = await downloads.download(downloadCall, request);
                    expect(receipt.byteLength).toBeGreaterThan(1000);
                    expect((await objects.getBytes(receipt.contentRef)).length).toBe(
                      receipt.byteLength,
                    );
                    expect(await downloads.download(downloadCall, request)).toEqual(receipt);
                    await expect(
                      downloads.download(downloadCall, {
                        ...request,
                        url: `${request.url}?changed`,
                      }),
                    ).rejects.toThrow('operation_conflict');
                    await expect(
                      downloads.download(
                        { ...call, actionId: 'download-wrong-origin' },
                        { ...request, url: 'https://example.com/pkg.tgz' },
                      ),
                    ).rejects.toThrow('download_origin_denied');
                    configuration = { ...configuration, actions: ['read', 'edit'] };
                    await expect(downloads.download(downloadCall, request)).rejects.toThrow(
                      'workspace_proposal_stale',
                    );
                    configuration = proposed.proposal.policy;
                    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('fixed user content');
                    evidence.download = receipt;
                  }
                  const withTools = async (
                    commands: LocalWorkspaceCommands | undefined,
                    run: (
                      execute: (name: string, args: unknown, id: string) => Promise<unknown>,
                    ) => Promise<void>,
                  ) => {
                    const port = bindLocalWorkspaceTools({
                      call: (actionId) => ({ ...call, actionId }),
                      authority,
                      objects,
                      versions,
                      files,
                      writer,
                      ...(commands ? { commands } : {}),
                    });
                    const catalog = await createLocalWorkspaceCatalog({
                      port,
                      sessionId: 'fixed-fixture-session',
                      capabilities: commands ? ['read', 'apply', 'run'] : ['read', 'apply'],
                    });
                    const context = new Context();
                    await context.plugin(SystemPrompt);
                    await context.plugin(ToolRuntime);
                    for (const tool of catalog.all()) context.tools.register(tool);
                    try {
                      expect(
                        catalog
                          .all()
                          .some((tool) =>
                            ['fs_write', 'git_applyPatch', 'sandbox_run'].includes(tool.name),
                          ),
                      ).toBe(false);
                      await run(async (name, args, id) => {
                        const response = await context.tools.execute({
                          name,
                          arguments: args,
                          callId: CallId(id),
                          signal: new AbortController().signal,
                        });
                        if (response.isError) throw Error(JSON.stringify(response.content));
                        return response.value;
                      });
                    } finally {
                      await catalog.dispose();
                    }
                  };
                  if (scenario === 'reader') {
                    await scheduler.release(lease);
                    await runtime.commitMutations(scope, [
                      mergeByIdMutation('workers', 'reader', {
                        role: 'REVIEWER',
                        executor: 'harness',
                        status: 'running',
                        startedTs: 2,
                      }),
                    ]);
                    const readerLease = await scheduler.acquire(
                      scope.projectId,
                      scope.taskId,
                      'reader',
                    );
                    try {
                      const readerAuthority = new LocalWorkspaceAuthority(
                        control,
                        roots,
                        versions,
                        (c) => {
                          scheduler.assertActive(readerLease);
                          if (c.workerId !== 'reader') throw Error('lease_scope_mismatch');
                        },
                        (s, id) => controller.assertGrant(s, id),
                      );
                      const readerRequest = {
                        ...scope,
                        actionId: 'register-reader',
                        rootId: grant.rootId,
                        grantId: grant.grantId,
                        workspaceId: 'read-only',
                        workerId: 'reader',
                        version,
                        expectedRevision: (await control.snapshot()).revision,
                      };
                      const readerWorkspace = await readerAuthority.registerReadOnly(readerRequest);
                      expect(await readerAuthority.registerReadOnly(readerRequest)).toEqual(
                        readerWorkspace,
                      );
                      expect((await control.snapshot()).claims).toHaveLength(1);
                      const readerCall = {
                        ...call,
                        workerId: 'reader',
                        workspaceId: 'read-only',
                        writerEpoch: 0,
                        actionId: 'reader-first',
                      };
                      const readerFiles = new LocalWorkspaceFiles(
                        readerAuthority,
                        objects,
                        filesHelper,
                      );
                      const before = await readerFiles.readFile(readerCall, 'sentinel');
                      expect(before.kind).toBe('file');
                      writeFileSync(join(root, 'sentinel'), 'external newer version');
                      const after = await readerFiles.readFile(
                        { ...readerCall, actionId: 'reader-second' },
                        'sentinel',
                      );
                      expect(after).toMatchObject({ kind: 'file', version: before.version });
                      if (after.kind !== 'file') throw Error('missing snapshot file');
                      expect(after.content.toString()).toBe('fixed user content');
                      const readerWriter = await LocalWorkspaceApply.open(
                        owner,
                        readerAuthority,
                        objects,
                        readerFiles,
                        filesHelper,
                      );
                      const readerTools = bindLocalWorkspaceTools({
                        call: (actionId) => ({ ...readerCall, actionId }),
                        authority: readerAuthority,
                        objects,
                        versions,
                        files: readerFiles,
                        writer: readerWriter,
                      });
                      expect((await readerTools.inspect(`tool:${'d'.repeat(64)}`)).version).toEqual(
                        version,
                      );
                      await expect(readerAuthority.assertCall(readerCall, 'edit')).rejects.toThrow(
                        'authorization_closed',
                      );
                      await expect(readerAuthority.assertCall(readerCall, 'run')).rejects.toThrow(
                        'authorization_closed',
                      );
                      await expect(
                        readerAuthority.assertCall(
                          { ...readerCall, writerEpoch: claim.writerEpoch },
                          'read',
                        ),
                      ).rejects.toThrow('authorization_closed');
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                        'external newer version',
                      );
                      evidence.readOnly = {
                        readerWorkspace,
                        before,
                        after,
                        claims: (await control.snapshot()).claims,
                      };
                    } finally {
                      await scheduler.release(readerLease);
                    }
                  } else if (scenario === 'mcp-partial') {
                    await withTools(undefined, async (execute) => {
                      const first = (await execute(
                        'workspace_read',
                        { path: 'sentinel' },
                        'read-first',
                      )) as { version: unknown; readReceiptId: string };
                      const second = (await execute(
                        'workspace_read',
                        { path: 'new.txt' },
                        'read-second',
                      )) as { version: unknown; readReceiptId: string };
                      const args = {
                        changes: [
                          {
                            path: 'sentinel',
                            expected: first.version,
                            readReceiptId: first.readReceiptId,
                            content: 'batch result',
                            encoding: 'utf8',
                          },
                          {
                            path: 'new.txt',
                            expected: second.version,
                            readReceiptId: second.readReceiptId,
                            content: 'batch result',
                            encoding: 'utf8',
                          },
                        ],
                        dependencies: [],
                      };
                      raceEnabled = true;
                      const partial = await execute('workspace_apply', args, 'partial-apply');
                      evidence.mcpPartial = partial;
                      expect(raced).toBe(true);
                      expect(partial).toMatchObject({
                        stage: 'partial',
                        effect: true,
                        needsAttention: true,
                      });
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('batch result');
                      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('external edit');
                      expect(await execute('workspace_apply', args, 'partial-apply')).toEqual(
                        partial,
                      );
                      await expect(execute('workspace_apply', args, 'new-apply')).rejects.toThrow(
                        'workspace_file_recovery_required',
                      );
                      await expect(
                        execute('workspace_read', { path: 'sentinel' }, 'after-partial'),
                      ).rejects.toThrow('workspace_file_recovery_required');
                      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('external edit');
                    });
                  } else if (scenario === 'mcp') {
                    await withTools(undefined, async (execute) => {
                      const original = (await execute(
                        'workspace_read',
                        { path: 'sentinel' },
                        'read',
                      )) as { version: unknown; readReceiptId: string; content: string };
                      expect(original.content).toBe('fixed user content');
                      const args = {
                        changes: [
                          {
                            path: 'sentinel',
                            expected: original.version,
                            readReceiptId: original.readReceiptId,
                            content: 'controlled MCP edit',
                            encoding: 'utf8',
                          },
                        ],
                        dependencies: [],
                      };
                      const applied = await execute('workspace_apply', args, 'apply');
                      expect(applied).toMatchObject({
                        stage: 'applied',
                        effect: true,
                        needsAttention: false,
                      });
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                        'controlled MCP edit',
                      );
                      expect(await execute('workspace_apply', args, 'apply')).toEqual(applied);
                      const stale = await execute('workspace_apply', args, 'stale');
                      expect(stale).toMatchObject({ stage: 'conflict', effect: false });
                      evidence.mcp = { original, applied, stale };
                    });
                  } else if (commandScenario) {
                    const bootstrap = join(base, 'command-bootstrap'),
                      processControl = join(base, 'process-control');
                    for (const [source, target] of [
                      ['local-command-bootstrap.c', bootstrap],
                      ['local-process-control.c', processControl],
                    ])
                      execFileSync('/usr/bin/clang', [
                        '-std=c11',
                        '-Wall',
                        '-Wextra',
                        '-Werror',
                        '-mmacosx-version-min=15.0',
                        resolve('packages/runtime/sandbox/native', source as string),
                        '-o',
                        target as string,
                      ]);
                    if (!manifestBytes) throw Error('missing tools manifest');
                    const manifest = JSON.parse(manifestBytes.toString('utf8'));
                    const nodePath = join(toolsRoot, 'node/bin/node');
                    const nodeHash = manifest.files.find(
                      (file: { path: string }) => file.path === 'node/bin/node',
                    )?.sha256;
                    expect(manifest.versions.node).toBe('24.20.0');
                    expect(hash(readFileSync(nodePath))).toBe(nodeHash);
                    const vault = join(owner.root, 'test-vault');
                    mkdirSync(vault, { mode: 0o700 });
                    const secret = join(vault, 'secret');
                    writeFileSync(secret, 'fixed private credential');
                    const inputs = await LocalFixedInputs.open(owner, objects, versions);
                    const tools = {
                      manifestHash: hash(manifestBytes),
                      ...(scenario === 'installation'
                        ? {
                            pnpm: {
                              root: join(toolsRoot, 'pnpm'),
                              manifestPath: join(toolsRoot, 'manifest.json'),
                              version: '9.15.9',
                            },
                          }
                        : {}),
                      node: { path: nodePath, sha256: nodeHash, version: manifest.versions.node },
                      bootstrap: { path: bootstrap, sha256: hash(readFileSync(bootstrap)) },
                      processControl: {
                        path: processControl,
                        sha256: hash(readFileSync(processControl)),
                      },
                    };
                    if (validationScenario) {
                      await scheduler.release(lease);
                      evidence.validation = await exerciseLocalValidation({
                        options: {
                          owner,
                          control,
                          roots,
                          objects,
                          versions,
                          filesHelper,
                          tools,
                          verifyGrant: (s, id) => controller.assertGrant(s, id),
                          grantForAssignment: async () => grant.grantId,
                          versionForAssignment: async () => version,
                        },
                        runtime,
                        scheduler,
                        root,
                        sourceWorkspaceId: workspace.workspaceId,
                        interruptedRelease: scenario.startsWith('terminal-release-'),
                      });
                    } else {
                      const commands = await LocalWorkspaceCommands.open(
                        owner,
                        authority,
                        objects,
                        versions,
                        inputs,
                        writer,
                        tools,
                        filesHelper,
                      );
                      const commandCall = { ...call, actionId: 'fixed-node-build' };
                      if (scenario === 'installation')
                        await expect(
                          commands.runCommand(
                            { ...call, actionId: 'before-install' },
                            {
                              toolId: 'node',
                              argv: ['--test', '@input/sentinel.test.cjs'],
                              inputVersion: version,
                              outputRoot: 'private-per-operation',
                              networkGrantId: null,
                              timeoutMs: 30000,
                            },
                          ),
                        ).rejects.toThrow('workspace_dependencies_required');

                      const request = {
                        toolId:
                          scenario === 'installation'
                            ? ('pnpm-install' as const)
                            : scenario === 'generation'
                              ? ('node-generate' as const)
                              : ('node' as const),
                        argv:
                          scenario === 'installation'
                            ? [
                                JSON.stringify([
                                  {
                                    name: 'picocolors',
                                    version: '1.1.1',
                                    url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
                                    integrity:
                                      'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
                                  },
                                ]),
                              ]
                            : ['@input/verify.cjs', secret, root],
                        inputVersion: version,
                        outputRoot: 'private-per-operation' as const,
                        networkGrantId: null,
                        timeoutMs: 30000,
                      };
                      if (scenario === 'command') {
                        const before = await objects.references();
                        await expect(
                          commands.runCommand(
                            { ...call, actionId: 'invalid-node-argument' },
                            { ...request, argv: ['@input/'] },
                          ),
                        ).rejects.toThrow('invalid_command_argument');
                        expect(await objects.references()).toEqual(before);
                        const readable = await files.readFile(
                          { ...call, actionId: 'read-after-invalid-argument' },
                          'sentinel',
                        );
                        expect(readable.kind).toBe('file');
                      }
                      let result: Awaited<ReturnType<LocalWorkspaceCommands['runCommand']>>;
                      if (['mcp-command', 'generation', 'installation'].includes(scenario)) {
                        let observed: typeof result | undefined;
                        await withTools(commands, async (execute) => {
                          const inspection = (await execute('workspace_read', {}, 'manifest')) as {
                            version: typeof version;
                          };
                          expect(inspection.version).toEqual(version);
                          const args = {
                            toolId: request.toolId,
                            argv: request.argv,
                            inputVersion: inspection.version,
                            timeoutMs: request.timeoutMs,
                          };
                          observed = (await execute(
                            'workspace_run',
                            args,
                            'command',
                          )) as typeof result;
                          // Preserve the first command outcome if its idempotent replay fails.
                          evidence.command = observed;
                          evidence.commandJournal = JSON.parse(
                            readFileSync(
                              join(owner.root, 'command-journal', 'commands.json'),
                              'utf8',
                            ),
                          );
                          expect(await execute('workspace_run', args, 'command')).toEqual(observed);
                        });
                        if (!observed) throw Error('missing MCP command result');
                        result = observed;
                      } else result = await commands.runCommand(commandCall, request);
                      evidence.command = result;
                      evidence.commandJournal = JSON.parse(
                        readFileSync(join(owner.root, 'command-journal', 'commands.json'), 'utf8'),
                      );
                      expect(result.stage).toBe('exited');
                      expect(result.exitCode).toBe(0);
                      if (scenario === 'installation')
                        expect(result.stdout).toContain('postinstall');
                      else expect(result.stdout).toBe('fixed input build and test passed\n');
                      // Managed pnpm 9 emits Node 24's known URL deprecation warning.
                      // Keep it in evidence; unexpected stderr still fails this fixture.
                      if (scenario === 'installation' && result.stderr)
                        expect(result.stderr).toMatch(
                          /^\(node:\d+\) \[DEP0169\] DeprecationWarning: `url\.parse\(\)` behavior is not standardized and prone to errors that have security implications\. Use the WHATWG URL API instead\. CVEs are not issued for `url\.parse\(\)` vulnerabilities\.\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)\n$/,
                        );
                      else expect(result.stderr).toBe('');
                      expect(result.quiescent).toBe(true);
                      expect(result.assurance).toBe('bounded');
                      const verified = await commands.verifyCommand(call, result.receiptId);
                      expect(verified.command).toEqual(result);
                      expect(verified.request).toEqual(request);
                      expect(verified.toolchainHash).toBe(grant.toolchainHash);
                      expect(await objects.get(verified.dependenciesHash)).toMatchObject({
                        schemaVersion: 'empty-command-dependencies-v1',
                        commandId: result.commandId,
                        entries: [],
                      });
                      await expect(
                        commands.verifyCommand({ ...call, taskId: 'other' }, result.receiptId),
                      ).rejects.toThrow('workspace_command_scope_mismatch');
                      await expect(
                        commands.verifyCommand(call, `run:${'0'.repeat(64)}`),
                      ).rejects.toThrow('workspace_command_recovery_required');
                      await authority.verifyCurrentVersion(call, version);

                      if (scenario === 'command')
                        expect(await commands.runCommand(commandCall, request)).toEqual(result);
                      expect(readFileSync(secret, 'utf8')).toBe('fixed private credential');
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                        'fixed user content',
                      );
                      if (scenario !== 'installation')
                        await expect(
                          commands.runCommand(
                            { ...commandCall, actionId: result.actionId },
                            {
                              ...request,
                              argv:
                                scenario === 'generation'
                                  ? ['@input/other.cjs']
                                  : ['-e', 'process.exit(0)'],
                            },
                          ),
                        ).rejects.toThrow('operation_conflict');
                      if (scenario === 'installation') {
                        const tested = await commands.runCommand(
                          { ...call, actionId: 'installed-test' },
                          {
                            ...request,
                            toolId: 'node',
                            argv: ['--test', '--test-reporter=tap', '@input/sentinel.test.cjs'],
                          },
                        );
                        expect(tested.exitCode, tested.stderr).toBe(0);
                        expect(tested.stdout).toContain('# pass 2');
                        const proof = await commands.verifyCommand(call, tested.receiptId);
                        expect(await objects.get(proof.dependenciesHash)).toMatchObject({
                          schemaVersion: 'local-command-dependency-input-v1',
                        });
                        evidence.installedTest = { tested, proof };
                        await withTools(commands, async (execute) => {
                          const generated = (await execute(
                            'workspace_read',
                            { path: 'installed', commandReceiptId: result.receiptId },
                            'installation-lifecycle',
                          )) as { content: string };
                          expect(Buffer.from(generated.content, 'base64').toString()).toBe('yes');
                        });
                        expect(existsSync(join(root, 'node_modules'))).toBe(false);
                        expect(existsSync(join(root, 'installed'))).toBe(false);
                        await scheduler.release(lease);
                        evidence.installedValidation = await exerciseLocalValidation({
                          options: {
                            owner,
                            control,
                            roots,
                            objects,
                            versions,
                            filesHelper,
                            tools,
                            verifyGrant: (s, id) => controller.assertGrant(s, id),
                            grantForAssignment: async () => grant.grantId,
                            versionForAssignment: async () => version,
                          },
                          runtime,
                          scheduler,
                          root,
                          sourceWorkspaceId: workspace.workspaceId,
                        });
                        const dependencyReference = localRecordHash({
                          kind: 'local-command-dependency-input-v1',
                          receiptId: tested.receiptId,
                        });
                        const referencePath = join(
                          owner.root,
                          'local-workspaces',
                          'objects',
                          `${dependencyReference}.ref`,
                        );
                        evidence.deletedDependencyReference = readFileSync(referencePath, 'utf8');
                        unlinkSync(referencePath);
                        await expect(
                          commands.verifyCommand(call, tested.receiptId),
                        ).rejects.toThrow('invalid_dependency_attachment');
                      }
                      if (scenario === 'generation') {
                        await withTools(commands, async (execute) => {
                          const generated = (await execute(
                            'workspace_read',
                            {
                              path: 'generated.txt',
                              commandReceiptId: result.receiptId,
                            },
                            'generated',
                          )) as { content: string; inputVersion: typeof version };
                          expect(generated.inputVersion).toEqual(version);
                          expect(Buffer.from(generated.content, 'base64').toString()).toBe(
                            'fixed generated bytes',
                          );
                          const target = (await execute(
                            'workspace_read',
                            { path: 'generated.txt' },
                            'target',
                          )) as { version: unknown; readReceiptId: string };
                          const applied = await execute(
                            'workspace_apply',
                            {
                              changes: [
                                {
                                  path: 'generated.txt',
                                  expected: target.version,
                                  readReceiptId: target.readReceiptId,
                                  content: generated.content,
                                  encoding: 'base64',
                                },
                              ],
                              dependencies: [],
                            },
                            'publish',
                          );
                          expect(applied).toMatchObject({
                            stage: 'applied',
                            effect: true,
                            needsAttention: false,
                          });
                          expect(readFileSync(join(root, 'generated.txt'), 'utf8')).toBe(
                            'fixed generated bytes',
                          );
                          expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                            'fixed user content',
                          );
                          evidence.generation = { generated, applied };
                        });
                      }
                      evidence.command = result;
                    }
                  } else if (scenario.startsWith('batch')) {
                    const secondRead =
                      scenario === 'batch-read-drift'
                        ? null
                        : await files.readFile({ ...call, actionId: 'batch-read-new' }, 'new.txt');
                    const dependencies =
                      scenario === 'batch-read-drift'
                        ? [
                            await files.readFile(
                              { ...call, actionId: 'batch-dependency' },
                              'dependency',
                            ),
                          ]
                        : [];
                    const readSet = await files.prepareReadSet({ ...call, actionId: 'read-set' }, [
                      {
                        path: 'sentinel',
                        version: read.version,
                        readReceiptId: read.readReceiptId,
                      },
                      ...dependencies.map((dependency) => ({
                        path: 'dependency',
                        version: dependency.version,
                        readReceiptId: dependency.readReceiptId,
                      })),
                      ...(secondRead
                        ? [
                            {
                              path: 'new.txt',
                              version: secondRead.version,
                              readReceiptId: secondRead.readReceiptId,
                            },
                          ]
                        : []),
                    ]);
                    const batchContent = await files.storeContent(
                      call,
                      Buffer.from('batch result'),
                    );
                    const batchChanges = [
                      {
                        op: 'put' as const,
                        path: 'sentinel',
                        expected: read.version,
                        contentRef: batchContent,
                      },
                      ...(secondRead
                        ? [
                            {
                              op: 'put' as const,
                              path: 'new.txt',
                              expected: secondRead.version,
                              contentRef: batchContent,
                            },
                          ]
                        : []),
                    ] as const;
                    const batchCall = { ...call, actionId: 'batch-write' };
                    await expect(
                      writer.applyFiles(batchCall, [batchChanges[0], batchChanges[0]], readSet),
                    ).rejects.toThrow();
                    raceEnabled = scenario === 'batch-partial' || scenario === 'batch-read-drift';
                    if (scenario === 'batch-stale')
                      writeFileSync(join(root, 'new.txt'), 'external before batch');
                    const batch = await writer.applyFiles(batchCall, batchChanges, readSet);
                    evidence.batchApply = batch;
                    if (scenario === 'batch-stale') {
                      expect(batch.stage).toBe('conflict');
                      expect(batch.effect).toBe(false);
                      expect(batch.items.every((item) => item.result === null)).toBe(true);
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe(
                        'fixed user content',
                      );
                      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe(
                        'external before batch',
                      );
                      expect(await writer.applyFiles(batchCall, batchChanges, readSet)).toEqual(
                        batch,
                      );
                    } else if (scenario !== 'batch') {
                      expect(raced).toBe(true);
                      expect(batch.stage).toBe('partial');
                      expect(batch.effect).toBe(true);
                      expect(batch.needsAttention).toBe(true);
                      expect(batch.items[0]?.result?.kind).toBe('regular');
                      if (scenario === 'batch-partial') {
                        expect(batch.items[1]?.result).toBeNull();
                        expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('external edit');
                      } else
                        expect(readFileSync(join(root, 'dependency'), 'utf8')).toBe(
                          'external edit',
                        );
                      await expect(
                        files.readFile({ ...call, actionId: 'after-partial' }, 'sentinel'),
                      ).rejects.toThrow('workspace_file_recovery_required');
                      expect(await writer.applyFiles(batchCall, batchChanges, readSet)).toEqual(
                        batch,
                      );
                    } else {
                      expect(batch.stage).toBe('applied');
                      expect(batch.items).toHaveLength(2);
                      expect(
                        batch.items.every(
                          (item) =>
                            item.result?.kind === 'regular' && item.result.sha256 === batchContent,
                        ),
                      ).toBe(true);
                      expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('batch result');
                      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('batch result');
                      expect(await writer.applyFiles(batchCall, batchChanges, readSet)).toEqual(
                        batch,
                      );
                    }
                  } else {
                    const newContent = Buffer.from([0, 255, 128, 42]);
                    const contentRef = await files.storeContent(
                      { ...call, actionId: 'content' },
                      newContent,
                    );
                    if (scenario === 'file-create') {
                      const absent = await files.readFile(
                        { ...call, actionId: 'read-absent' },
                        'new.txt',
                      );
                      expect(absent).toMatchObject({
                        kind: 'absent',
                        version: { kind: 'absent', name: 'new.txt' },
                      });
                      const created = await writer.applyFiles(
                        { ...call, actionId: 'create-file' },
                        [{ op: 'put', path: 'new.txt', expected: absent.version, contentRef }],
                        absent.readReceiptId,
                      );
                      expect(created.stage).toBe('applied');
                      expect(readFileSync(join(root, 'new.txt'))).toEqual(newContent);
                      evidence.fileCreation = created;
                    } else {
                      const change = {
                        op: 'put' as const,
                        path: 'sentinel',
                        expected: read.version,
                        contentRef,
                      };
                      const writeCall = { ...call, actionId: 'write-file' };
                      const applied = await writer.applyFiles(
                        writeCall,
                        [change],
                        read.readReceiptId,
                      );
                      expect(applied.stage).toBe('applied');
                      expect(applied.effect).toBe(true);
                      expect(applied.needsAttention).toBe(false);
                      expect(readFileSync(join(root, 'sentinel'))).toEqual(newContent);
                      expect(
                        await writer.applyFiles(writeCall, [change], read.readReceiptId),
                      ).toEqual(applied);
                      if (scenario === 'file-update') {
                        const fresh = await files.readFile(
                          { ...call, actionId: 'fresh-read' },
                          'sentinel',
                        );
                        expect(fresh.version).toEqual(applied.items[0]?.result);
                        const stale = await writer.applyFiles(
                          { ...call, actionId: 'stale-write' },
                          [change],
                          read.readReceiptId,
                        );
                        expect(stale.stage).toBe('conflict');
                        expect(stale.effect).toBe(false);
                        expect(readFileSync(join(root, 'sentinel'))).toEqual(newContent);
                        evidence.fileApply = applied;
                        evidence.staleApply = stale;
                        await expect(files.readFile(call, 'different')).rejects.toThrow(
                          'operation_conflict',
                        );
                        writeFileSync(join(root, '.env'), 'fixed secret');
                        await expect(
                          files.readFile({ ...call, actionId: 'read-secret' }, '.env'),
                        ).rejects.toThrow();
                        await expect(
                          files.readFile(
                            { ...call, actionId: 'read-outside' },
                            '../state/desktop-format.json',
                          ),
                        ).rejects.toThrow('invalid_workspace_path');
                        await expect(
                          authority.assertCall({ ...call, grantRevision: 99 }, 'read'),
                        ).rejects.toThrow('authorization_closed');
                        await expect(
                          authority.assertCall({ ...call, writerEpoch: 99 }, 'read'),
                        ).rejects.toThrow('authorization_closed');
                        await expect(
                          authority.assertCall({ ...call, workerId: 'other' }, 'read'),
                        ).rejects.toThrow('lease_scope_mismatch');
                      } else {
                        evidence.fileApply = applied;
                        const native = (await objects.get(
                          applied.items[0]?.nativeReceiptRef as string,
                        )) as {
                          journalPath: string;
                        };
                        const nativeFile = join(native.journalPath, 'result.json');
                        expect(nativeFile.startsWith(`${base}/`)).toBe(true);
                        evidence.originalNativeResult = readFileSync(nativeFile, 'utf8');
                        unlinkSync(nativeFile);
                        await expect(
                          writer.applyFiles(writeCall, [change], read.readReceiptId),
                        ).rejects.toThrow();
                        await expect(
                          files.readFile({ ...call, actionId: 'after-missing-proof' }, 'sentinel'),
                        ).rejects.toThrow();
                      }
                    }
                  }
                  await scheduler.release(lease);
                  await expect(authority.assertCall(call, 'read')).rejects.toThrow(
                    'does not match',
                  );
                  await expect(files.readFile(call, 'sentinel')).rejects.toThrow('does not match');
                  evidence.workspace = workspace;
                  evidence.claim = claim;
                  evidence.version = version;
                } finally {
                  await scheduler.release(lease);
                }
              }
            }
          } else {
            expect((await control.snapshot()).revision).toBe(0);
            expect((await runtime.store.load(scope))?.localExecution).toBeUndefined();
            expect(eventStates).toHaveLength(0);
          }
        } finally {
          off();
        }
        evidence.passed = true;
      } catch (error) {
        failure = error;
        evidence.failure = error instanceof Error ? error.message : String(error);
      }
      await owner.release();
      const files: { path: string; sha256: string }[] = [];
      const capture = (directory: string, prefix = '') => {
        for (const name of readdirSync(directory)) {
          const file = join(directory, name),
            info = lstatSync(file);
          if (info.isDirectory() && !info.isSymbolicLink()) capture(file, join(prefix, name));
          else if (info.isFile())
            files.push({ path: join(prefix, name), sha256: hash(readFileSync(file)) });
          else throw Error('unexpected grant fixture object');
        }
      };
      capture(base);
      evidence.files = files;
      evidence.sources = Object.fromEntries(
        [
          ...readdirSync('packages/runtime/sandbox/src')
            .filter((name) => name.startsWith('local-') && name.endsWith('.ts'))
            .map((name) => `packages/runtime/sandbox/src/${name}`),
          ...readdirSync('packages/runtime/sandbox/native')
            .filter((name) => name.startsWith('local-') && name.endsWith('.c'))
            .map((name) => `packages/runtime/sandbox/native/${name}`),
          'packages/core/orchestration/src/global-scheduler.ts',
          'packages/core/orchestration/src/worker-runtime.ts',
          'packages/runtime/sandbox/src/workspace-worker-port.ts',
          'packages/runtime/executor/src/project.ts',
          'packages/runtime/sandbox/src/workspace-port.ts',
          'packages/tools/fs/src/workspace-server.ts',
          'packages/tools/bridge/src/local-workspace-bridge.ts',
          'packages/runtime/sandbox/src/local-grant-controller.ts',
          'packages/runtime/sandbox/src/local-grant-policy.ts',
          'packages/runtime/sandbox/src/local-workspace-downloads.ts',
          'packages/runtime/sandbox/src/local-installation-command.ts',
          'packages/runtime/sandbox/src/local-dependency-inputs.ts',
          'packages/runtime/sandbox/src/local-generation-command.ts',
          'packages/runtime/sandbox/src/local-download.ts',
          'packages/runtime/sandbox/src/local-download-policy.ts',
          'packages/runtime/sandbox/src/local-control-objects.ts',
          'packages/runtime/sandbox/src/local-binding-coordinator.ts',
          'packages/runtime/sandbox/src/local-registry-records.ts',
          'apps/web/src/server/message-runtime.ts',
          'apps/web/src/server/message-handlers.ts',
          'tests/integration/phase12/phase12-3-grant.test.ts',
        ].map((p) => [p, hash(readFileSync(p))]),
      );
      const folder = resolve('test-outputs/reviews/task123-grant-evidence');
      mkdirSync(folder, { recursive: true });
      const target = join(folder, `${scenario}-${basename(base)}.json`);
      writeFileSync(target, JSON.stringify(evidence, null, 2));
      const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
        mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' }),
        now = lstatSync(base),
        before = statfsSync(base);
      if (
        handles.status !== 1 ||
        handles.stdout ||
        handles.stderr ||
        mounts.status !== 0 ||
        mounts.stdout.includes(base) ||
        now.dev !== identity.dev ||
        now.ino !== identity.ino ||
        now.isSymbolicLink()
      )
        throw Error('grant_fixture_cleanup_unproven');
      rmSync(base, { recursive: true });
      const after = statfsSync('/private/tmp');
      evidence.cleanup = {
        deleted: true,
        ownerReleased: true,
        noHandles: true,
        noMounts: true,
        availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
      };
      writeFileSync(target, JSON.stringify(evidence, null, 2));
      if (failure) throw failure;
    },
    ['download', 'installation'].includes(scenario)
      ? 60000
      : [
            'command',
            'generation',
            'mcp',
            'mcp-partial',
            'reader',
            'mcp-command',
            'worker-companion',
            'successor-companion',
            'missing-closure-companion',
            'tester-companion',
            'reviewer-companion',
            'trusted-validation',
            'terminal-release-before',
            'terminal-release-after',
            'pm-companion',
            'coordinator-companion',
          ].includes(scenario)
        ? 20_000
        : 5_000,
  );
