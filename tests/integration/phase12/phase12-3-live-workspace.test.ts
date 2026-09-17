// Real Go model, official Harness loop, WorkerRuntime, MCP, APFS transactions
// and managed Node under Seatbelt. Only fixed fictional LRU inputs leave host.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInitialAppState, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createLocalCoderExecutor } from '../../../apps/web/src/server/local-workspace-executor';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalGrantController } from '../../../packages/runtime/sandbox/src/local-grant-controller';
import { LocalRootCoordinator } from '../../../packages/runtime/sandbox/src/local-root-coordinator';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { localRootBinding } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type {
  WorkspaceCommandReceipt,
  WorkspaceCommandRequest,
} from '../../../packages/runtime/sandbox/src/workspace-port';
import { resolveLiveTestModel } from '../../helpers/live-model';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const tests = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LRUCache } = require('./lru-cache.cjs');
test('missing keys return undefined', () => { const c = new LRUCache(2); assert.equal(c.get('missing'), undefined); });
test('get refreshes recency and capacity evicts oldest', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); assert.equal(c.get('a'), 1); c.set('c', 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1); assert.equal(c.get('c'), 3); });
test('updating a key preserves capacity', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 7); assert.equal(c.get('a'), 7); assert.equal(c.get('b'), 2); });
test('delete removes only the chosen key', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); assert.equal(c.delete('a'), true); assert.equal(c.delete('a'), false); assert.equal(c.get('a'), undefined); assert.equal(c.get('b'), 2); });
test('optional TTL expires entries', async () => { const c = new LRUCache(2, 20); c.set('a', 1); assert.equal(c.get('a'), 1); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(c.get('a'), undefined); });
`;
const task =
  'Implement only lru-cache.cjs as CommonJS exporting LRUCache. Constructor(capacity, ttlMs = Infinity); get(key) returns value or undefined and refreshes recency; set(key,value) inserts/updates and evicts least recently used when capacity is exceeded; delete(key) returns whether it existed. Optional TTL expires entries from their last set time. Read the existing files first; preserve lru-cache.test.cjs unchanged. Use workspace_apply with the original expected/readReceiptId. Capture the resulting file manifest with workspace_read with no path, then run managed Node using workspace_run argv ["--test","--test-reporter=tap","@input/lru-cache.test.cjs"] against that inputVersion. All five tests must pass. End with actual file and test evidence; do not invent a receipt or modify tests.';

it('runs a fixed LRU task through live Harness and the controlled direct workspace', async () => {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = lstatSync(base);
  const root = join(base, 'project');
  mkdirSync(root);
  writeFileSync(
    join(root, 'lru-cache.cjs'),
    '// Fixed incomplete LRU fixture.\nmodule.exports = {};\n',
  );
  writeFileSync(join(root, 'lru-cache.test.cjs'), tests);
  writeFileSync(join(root, '.env'), 'FIXED_FAKE_SECRET=not-a-real-credential\n');
  const owner = await acquireState(join(base, 'state'));
  const evidence: Record<string, unknown> = {
    base,
    startedAt: new Date().toISOString(),
    task,
    testSource: tests,
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    scope: 'single CODER live loop; not D16 or phase acceptance',
  };
  const executors: Awaited<ReturnType<typeof createLocalCoderExecutor>>[] = [];
  let failed: unknown;
  try {
    const helpers: Record<string, string> = {};
    for (const name of [
      'local-root-inspection',
      'local-root-initialization',
      'local-file-transaction',
      'local-command-bootstrap',
      'local-process-control',
    ]) {
      const target = join(base, name);
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        resolve(`packages/runtime/sandbox/native/${name}.c`),
        '-o',
        target,
      ]);
      helpers[name] = target;
    }
    const helper = (name: string) => {
      const path = helpers[name];
      if (!path) throw Error('missing fixture helper');
      return path;
    };
    const toolsRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
    const manifestBytes = readFileSync(join(toolsRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const nodePath = join(toolsRoot, 'node/bin/node');
    const nodeHash = manifest.files.find(
      (file: { path: string; sha256: string }) => file.path === 'node/bin/node',
    )?.sha256;
    expect(manifest.versions.node).toBe('24.20.0');
    expect(hash(readFileSync(nodePath))).toBe(nodeHash);
    evidence.toolchain = {
      manifestHash: hash(manifestBytes),
      nodeHash,
      nodeVersion: manifest.versions.node,
    };
    const scope = { projectId: 'fixed-lru-project', taskId: 'fixed-lru-task' };
    const runtime = new MessageRuntime(
      join(owner.root, 'tasks'),
      new ChannelStream(),
      DEFAULT_ROSTER,
    );
    await runtime.initializeState(
      scope,
      createInitialAppState(scope.taskId, task, scope.projectId),
    );
    const control = await LocalBindingCoordinator.open(owner, runtime.store, true);
    const controller = await LocalGrantController.open(
      owner,
      control,
      runtime.store,
      helper('local-root-inspection'),
      async () => ({
        version: 'seatbelt-apfs-v1',
        actions: ['read', 'edit', 'run'],
        toolchain: { manifestHash: hash(manifestBytes) },
        network: { mode: 'disabled' },
        outputs: { kind: 'private-per-operation' },
      }),
    );
    runtime.bindWorkspaceControlPort(controller);
    const proposal = await controller.prepareGrant(scope, {
      selectionRef: 'fixed-lru-selection',
      path: root,
    });
    const body = {
      ...scope,
      actionId: 'fixed-lru-grant',
      expectedRevision: proposal.proposal.expectedRevision,
      selectionRef: 'fixed-lru-selection',
      policyProposalId: proposal.policyProposalId,
      inputHash: proposal.inputHash,
    };
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: body.actionId,
          display: `/workspace grant ${JSON.stringify(body)}`,
        }),
      }),
    );
    expect(response.status).toBe(202);
    const grant = (await control.snapshot()).grants[0];
    if (!grant) throw Error('missing canonical grant');
    const roots = await LocalRootCoordinator.open(owner, control, {
      inspector: helper('local-root-inspection'),
      initializer: helper('local-root-initialization'),
    });
    await roots.initialize({
      ...scope,
      actionId: 'fixed-lru-initialize',
      rootId: grant.rootId,
      grantId: grant.grantId,
      expectedRevision: (await control.snapshot()).revision,
    });
    const objects = await LocalControlObjects.open(owner);
    const versions = new LocalVersionStore(objects, helper('local-file-transaction'));
    const local = await LocalWorkspaceSessions.create({
      owner,
      control,
      roots,
      objects,
      versions,
      filesHelper: helper('local-file-transaction'),
      tools: {
        manifestHash: hash(manifestBytes),
        node: { path: nodePath, sha256: nodeHash, version: manifest.versions.node },
        bootstrap: {
          path: helper('local-command-bootstrap'),
          sha256: hash(readFileSync(helper('local-command-bootstrap'))),
        },
        processControl: {
          path: helper('local-process-control'),
          sha256: hash(readFileSync(helper('local-process-control'))),
        },
      },
      verifyGrant: (s, id) => controller.assertGrant(s, id),
      grantForAssignment: async () => grant.grantId,
    });
    await runtime.commitMutations(scope, [
      setMutation('phase', 'coding'),
      mergeByIdMutation('subtasks', 'lru', {
        title: task,
        ownerRole: 'CODER',
        status: 'in_progress',
        dependsOn: [],
      }),
    ]);
    const live = await resolveLiveTestModel();
    const scheduler = new GlobalScheduler({ cap: 1 });
    const worker = new WorkerRuntime(
      {
        roster: DEFAULT_ROSTER,
        loadState: () => runtime.store.load(scope),
        transition: async (_old, mutations) =>
          (await runtime.commitMutations(scope, mutations)).state,
        sessionIdForAssignment: () => 'fixed-lru-session',
        localWorkspace: local,
        buildExecutor: () => {
          throw Error('legacy executor forbidden');
        },
        buildLocalExecutor: async (spec, _assignment, session) => {
          const composed = await createLocalCoderExecutor({
            spec: { ...spec, model: live.model },
            session,
            options: {
              ...live.options,
              maxToolCallsPerTurn: 20,
              sessionPersistence: {
                root: join(owner.root, 'harness-sessions'),
                cwd: root,
                ...scope,
              },
            },
          });
          executors.push(composed);
          return composed.executor;
        },
      },
      scheduler,
    );
    const start = await runtime.store.load(scope);
    if (!start) throw Error('missing initial state');
    const finished = await worker.runOne(start, {
      workerId: 'lru-coder',
      role: 'CODER',
      subtaskId: 'lru',
    });
    evidence.finalState = finished;
    evidence.generatedSource = readFileSync(join(root, 'lru-cache.cjs'), 'utf8');
    expect(finished.workers[0]?.status).toBe('done');
    expect(finished.workers[0]?.worktree).toBeUndefined();
    expect(scheduler.activeCount).toBe(0);
    expect(readFileSync(join(root, 'lru-cache.test.cjs'), 'utf8')).toBe(tests);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'FIXED_FAKE_SECRET=not-a-real-credential\n',
    );
    expect(readdirSync(root).sort()).toEqual([
      '.agora-operations',
      '.env',
      'lru-cache.cjs',
      'lru-cache.test.cjs',
    ]);
    const receipts: WorkspaceCommandReceipt[] = [];
    const requests: { inputHash: string; request: WorkspaceCommandRequest }[] = [];
    for (const reference of await objects.references()) {
      const record = (await objects.get(reference.valueHash)) as Partial<WorkspaceCommandReceipt>;
      const prepared = record as unknown as {
        schemaVersion?: string;
        inputHash: string;
        request: WorkspaceCommandRequest;
      };
      if (prepared.schemaVersion === 'workspace-command-prepared-v1')
        requests.push({ inputHash: prepared.inputHash, request: prepared.request });
      if (record.schemaVersion === 'workspace-command-receipt-v1')
        receipts.push(record as WorkspaceCommandReceipt);
    }
    evidence.commandReceipts = receipts;
    evidence.commandRequests = requests;
    const passes = [];
    for (const receipt of receipts) {
      const stdout = (await objects.getBytes(receipt.stdoutRef)).toString('utf8');
      const stderr = (await objects.getBytes(receipt.stderrRef)).toString('utf8');
      passes.push({ receipt, stdout, stderr });
    }
    evidence.runs = passes;
    const passed = passes.find(
      (run) =>
        requests.some(
          (prepared) =>
            prepared.inputHash === run.receipt.inputHash &&
            prepared.request.toolId === 'node' &&
            JSON.stringify(prepared.request.argv) ===
              JSON.stringify(['--test', '--test-reporter=tap', '@input/lru-cache.test.cjs']) &&
            JSON.stringify(prepared.request.inputVersion) ===
              JSON.stringify(run.receipt.inputVersion),
        ) &&
        run.receipt.exitCode === 0 &&
        run.receipt.stage === 'exited' &&
        run.receipt.quiescent &&
        run.stdout.includes('# tests 5') &&
        run.stdout.includes('# pass 5') &&
        run.stdout.includes('# fail 0') &&
        run.stdout.includes('# skipped 0') &&
        run.stdout.includes('# cancelled 0'),
    );
    expect(passed).toBeDefined();
    if (!passed) throw Error('no trusted passing command');
    const registered = (await control.snapshot()).roots[0];
    if (!registered) throw Error('missing root');
    await versions.verify(
      passed.receipt.inputVersion,
      { ...scope, rootId: grant.rootId, policyHash: grant.policyHash },
      localRootBinding(registered),
      async () => {
        await controller.assertGrant(scope, grant.grantId);
        return true;
      },
    );
    evidence.generatedSource = readFileSync(join(root, 'lru-cache.cjs'), 'utf8');
    evidence.passed = true;
  } catch (error) {
    failed = error;
    evidence.failure = error instanceof Error ? error.message : 'unknown';
  }
  {
    for (const executor of executors) await executor.dispose();
    await owner.release();
    const files: { path: string; sha256: string }[] = [];
    const scan = (directory: string, prefix = '') => {
      for (const name of readdirSync(directory)) {
        const file = join(directory, name),
          stat = lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) scan(file, join(prefix, name));
        else if (stat.isFile())
          files.push({ path: join(prefix, name), sha256: hash(readFileSync(file)) });
        else throw Error('unexpected live fixture object');
      }
    };
    scan(base);
    evidence.files = files;
    evidence.sources = Object.fromEntries(
      [
        ...readdirSync('packages/runtime/sandbox/src')
          .filter((name) => name.startsWith('local-') || name.startsWith('workspace-'))
          .map((name) => `packages/runtime/sandbox/src/${name}`),
        ...readdirSync('packages/runtime/sandbox/native')
          .filter((name) => name.startsWith('local-'))
          .map((name) => `packages/runtime/sandbox/native/${name}`),
        'packages/core/orchestration/src/worker-runtime.ts',
        'packages/runtime/executor/src/harness-executor.ts',
        'packages/runtime/executor/src/project.ts',
        'packages/tools/bridge/src/local-workspace-bridge.ts',
        'packages/tools/fs/src/workspace-server.ts',
        'packages/roles/definitions/src/local-runtime-contract.ts',
        'apps/web/src/server/local-workspace-executor.ts',
        'tests/helpers/live-model.ts',
        'tests/integration/phase12/phase12-3-live-workspace.test.ts',
      ].map((path) => [path, hash(readFileSync(path))]),
    );
    const folder = resolve('test-outputs/reviews/task123-live-workspace-evidence');
    mkdirSync(folder, { recursive: true });
    const target = join(folder, `${basename(base)}.json`);
    writeFileSync(target, JSON.stringify(evidence, null, 2));
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
      mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' }),
      current = lstatSync(base),
      before = statfsSync(base);
    if (
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink()
    )
      throw Error('live_fixture_cleanup_unproven');
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
  }
  if (failed) throw failed;
}, 360000);
