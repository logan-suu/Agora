/** Trusted desktop composition. No browser-supplied path becomes a capability. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInitialAppState, isWorkspaceVersionV1 } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { HarnessRequirementInterpreter } from '@agora/runtime-executor';
import { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import {
  inspectLocalDirectory,
  inspectLocalFileBytes,
} from '../../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalGrantController } from '../../../../packages/runtime/sandbox/src/local-grant-controller';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalRootCoordinator } from '../../../../packages/runtime/sandbox/src/local-root-coordinator';
import { LocalVersionStore } from '../../../../packages/runtime/sandbox/src/local-version-store';
import { localRootBinding } from '../../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { firstRunScope, firstRunStartEligible } from './first-run-policy';
import { bindFirstRunProtection } from './first-run-protection';
import { type LocalBootstrap, localBootstrap } from './local-startup';
import { createLocalTaskCompositionFactory } from './local-task-composition';
import { type MessageRuntime, messageRuntime, RequirementInputError } from './message-runtime';
import { ModelSettingsService } from './model-settings';
import { TaskOrchestrationRuntime } from './task-orchestration-runtime';

type Scope = { projectId: string; taskId: string };
type Entry = Scope & {
  version: 1;
  operationId: string;
  selectionRef: string;
  path: string;
  goal: string;
};
const draftKey = (projectId: string) =>
  localRecordHash({ kind: 'desktop-project-draft-v1', projectId });
const entryKey = (projectId: string) => localRecordHash({ kind: 'desktop-project-v1', projectId });
const launchKey = (scope: Scope) =>
  localRecordHash({
    kind: 'desktop-first-launch-v1',
    projectId: scope.projectId,
    taskId: scope.taskId,
  });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scopeKey = (s: Scope) => JSON.stringify([s.projectId, s.taskId]);
const readOnlySavedWork = () =>
  new RequirementInputError(
    'Saved work is read-only in this preview. Restart recovery is not available yet.',
    409,
  );
export class FirstRunService {
  private constructor(
    readonly messages: MessageRuntime,
    readonly models: ModelSettingsService,
    readonly tasks: TaskOrchestrationRuntime,
    private readonly host: NonNullable<LocalBootstrap['desktop']>,
    private readonly objects: LocalControlObjects,
    private readonly control: LocalBindingCoordinator,
    private readonly grants: LocalGrantController,
    private readonly roots: LocalRootCoordinator,
    private readonly versions: LocalVersionStore,
    private readonly filesHelper: string,
    private readonly writableScopes: Set<string>,
    private readonly selections: Map<string, string>,
  ) {}
  static async create(host: NonNullable<LocalBootstrap['desktop']>, messages = messageRuntime) {
    await host.verifyToolchain();
    const manifestBytes = await readFile(join(host.toolchainRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString()) as {
      files: { path: string; sha256?: string }[];
      versions: { node: string };
    };
    const helper = (name: string) => join(host.toolchainRoot, name);
    const tool = (name: string) => {
      const sha256 = manifest.files.find((f) => f.path === name)?.sha256;
      if (!sha256) throw Error('toolchain_manifest_invalid');
      return { path: helper(name), sha256 };
    };
    const control = await LocalBindingCoordinator.open(
      host.owner,
      {
        load: (s) => messages.store.load(s),
        commit: (s, m) => messages.commitMutations(s, m),
        compareAndCommit: (s, before, m) => messages.compareAndCommitControl(s, before, m),
      },
      true,
    );
    const objects = await LocalControlObjects.open(host.owner);
    const grants = await LocalGrantController.open(
      host.owner,
      control,
      messages.store,
      helper('local-root-inspection'),
      async () => ({
        version: 'seatbelt-apfs-v1',
        actions: ['read', 'edit', 'run', 'generate'],
        toolchain: { manifestHash: hash(manifestBytes) },
        network: { mode: 'disabled' },
        outputs: { kind: 'private-per-operation' },
      }),
    );
    const roots = await LocalRootCoordinator.open(host.owner, control, {
      inspector: helper('local-root-inspection'),
      initializer: helper('local-root-initialization'),
    });
    const versions = new LocalVersionStore(objects, helper('local-file-transaction'));
    const models = new ModelSettingsService(messages, undefined, undefined, false);
    const scheduler = new GlobalScheduler();
    const sessions = new Map<string, LocalWorkspaceSessions>();
    const writableScopes = new Set<string>();
    const admit = (scope: Scope) => {
      if (!writableScopes.has(scopeKey(scope))) throw readOnlySavedWork();
    };
    messages.bindLeaderAdmission(admit);
    const resolveGrant = async (scope: Scope) => {
      const state = await control.assertClosed(scope);
      const registry = await control.snapshot();
      const grant = registry.grants.find(
        (g) =>
          g.projectId === scope.projectId &&
          state.localExecution?.rootIds.includes(g.rootId) &&
          g.status === 'active',
      );
      if (!grant || state.localExecution?.rootIds.length !== 1) throw Error('authorization_closed');
      const boundRoot = registry.roots.find((r) => r.rootId === grant.rootId);
      if (!boundRoot) throw Error('authorization_closed');
      await host.selections.assertAccepted(boundRoot.path);
      await grants.assertGrant(scope, grant.grantId);
      return grant;
    };
    const factory = createLocalTaskCompositionFactory({
      loadState: (s) => messages.store.load(s),
      bindCompletionVerifier: (verify) => messages.bindLocalCompletionVerifier(verify),
      scheduler,
      modelSettings: models,
      prepare: async (scope, versionForAssignment, verifyReviewCandidate) => {
        const grant = await resolveGrant(scope);
        const root = (await control.snapshot()).roots.find((r) => r.rootId === grant.rootId);
        if (!root) throw Error('authorization_closed');
        const local = await LocalWorkspaceSessions.create({
          owner: host.owner,
          control,
          roots,
          objects,
          versions,
          filesHelper: helper('local-file-transaction'),
          tools: {
            manifestHash: hash(manifestBytes),
            node: { ...tool('node/bin/node'), version: manifest.versions.node },
            bootstrap: tool('local-command-bootstrap'),
            processControl: tool('local-process-control'),
          },
          verifyGrant: (s, id) => grants.assertGrant(s, id),
          grantForAssignment: async (s) => (await resolveGrant(s)).grantId,
          versionForAssignment,
          verifyReviewCandidate,
        });
        sessions.set(scopeKey(scope), local);
        return {
          local,
          cwd: root.path,
          sessionRoot: join(
            messages.root,
            'projects',
            scope.projectId,
            'tasks',
            scope.taskId,
            'harness-sessions',
          ),
        };
      },
    });
    const tasks = new TaskOrchestrationRuntime(
      messages,
      async (input) => {
        admit(input.scope);
        if (!(await objects.getReference(launchKey(input.scope))))
          throw Error('first_start_required');
        return factory(input);
      },
      { admitStart: admit, registerDrain: false },
    );
    messages.bindRequirementInterpreter({
      async interpret(input) {
        admit(input);
        if (localBootstrap()?.draining) throw Error('service_stopping');
        if (!(await objects.getReference(launchKey(input)))) throw Error('first_start_required');
        await resolveGrant(input);
        const binding = await models.freezeChecked(input, input.goal);
        const route = (await models.executorRoutes(binding)).get('COORDINATOR');
        if (!route?.compatible) throw Error('checked_model_connection_required');
        const lease = await scheduler.acquire(
          input.projectId,
          input.taskId,
          `leader-input:${input.sourceMsgId}`,
        );
        try {
          if (localBootstrap()?.draining) throw Error('service_stopping');
          await resolveGrant(input);
          const root = join(messages.root, 'projects', input.projectId, 'tasks', input.taskId);
          return await new HarnessRequirementInterpreter(route.model, {
            compatible: route.compatible,
            sessionPersistence: {
              root: join(root, 'harness-sessions'),
              cwd: root,
              projectId: input.projectId,
              taskId: input.taskId,
            },
          }).interpret(input);
        } finally {
          scheduler.release(lease);
        }
      },
    });
    await bindFirstRunProtection({
      owner: host.owner,
      control,
      objects,
      grants,
      versions,
      runtime: tasks,
      scheduler,
      inspector: helper('local-root-inspection'),
      sessions: (scope) => {
        const local = sessions.get(scopeKey(scope));
        if (!local) throw Error('workspace_sessions_unavailable');
        return local;
      },
    });
    return new FirstRunService(
      messages,
      models,
      tasks,
      host,
      objects,
      control,
      grants,
      roots,
      versions,
      helper('local-file-transaction'),
      writableScopes,
      new Map(),
    );
  }
  async drain() {
    const results = await Promise.allSettled([this.models.drain(), this.tasks.drain()]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'first_run_cleanup_failed');
  }
  async entry(projectId: string): Promise<Entry> {
    if (!/^project-[a-f0-9]{32}$/.test(projectId)) throw Error('invalid_project');
    const ref = await this.objects.getReference(entryKey(projectId));
    if (!ref) throw Error('project_unavailable');
    const value = (await this.objects.get(ref)) as Entry;
    if (
      value?.version !== 1 ||
      value.projectId !== projectId ||
      Object.keys(value).sort().join(',') !==
        'goal,operationId,path,projectId,selectionRef,taskId,version' ||
      JSON.stringify(firstRunScope(value.operationId)) !==
        JSON.stringify({ projectId: value.projectId, taskId: value.taskId }) ||
      typeof value.goal !== 'string' ||
      !value.goal.trim() ||
      value.goal.length > 16000 ||
      typeof value.path !== 'string'
    )
      throw Error('invalid_project');
    return value;
  }
  async rememberSelection(operationId: string, selectionRef: string) {
    if (localBootstrap()?.draining) throw Error('service_stopping');
    const scope = firstRunScope(operationId);
    const path = await this.host.selections.resolve(scope, selectionRef);
    if (
      !this.writableScopes.has(scopeKey(scope)) &&
      (await this.objects.getReference(launchKey(scope)))
    )
      throw readOnlySavedWork();
    const prior = await this.objects.getReference(entryKey(scope.projectId));
    if (prior && (await this.entry(scope.projectId)).path !== path)
      throw Error('project_entry_conflict');
    const metadata = { version: 1, ...scope, operationId, path };
    const saved = await this.objects.put(metadata);
    await this.objects.bindReference(draftKey(scope.projectId), saved);
    await this.messages.ensureProjectChannels(scope.projectId);
    this.writableScopes.add(scopeKey(scope));
    this.selections.set(scopeKey(scope), selectionRef);
    return metadata;
  }
  async list() {
    await this.host.owner.assertHeld();
    const projects = await readdir(join(this.messages.root, 'projects'), {
      withFileTypes: true,
    }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const selected = projects.filter((p) => /^project-[a-f0-9]{32}$/.test(p.name));
    if (selected.length > 128) throw Error('project_list_limit');
    const result: Entry[] = [];
    for (const project of selected) {
      if (!project.isDirectory() || project.isSymbolicLink()) throw Error('invalid_project');
      if (await this.objects.getReference(entryKey(project.name)))
        result.push(await this.entry(project.name));
      else {
        const ref = await this.objects.getReference(draftKey(project.name));
        if (ref) {
          const draft = (await this.objects.get(ref)) as Omit<Entry, 'goal' | 'selectionRef'>;
          if (
            draft.version !== 1 ||
            Object.keys(draft).sort().join(',') !== 'operationId,path,projectId,taskId,version' ||
            draft.projectId !== project.name ||
            localRecordHash(firstRunScope(draft.operationId)) !==
              localRecordHash({ projectId: draft.projectId, taskId: draft.taskId }) ||
            typeof draft.path !== 'string'
          )
            throw Error('invalid_project');
          result.push({ ...draft, goal: '', selectionRef: '' });
        }
      }
    }
    return Promise.all(
      result.map(async (entry) => ({
        ...entry,
        started: Boolean(await this.objects.getReference(launchKey(entry))),
        readOnly: !this.writableScopes.has(scopeKey(entry)),
      })),
    );
  }
  async prepare(operationId: string, selectionRef: string, goal: string) {
    if (localBootstrap()?.draining) throw Error('service_stopping');
    const scope = firstRunScope(operationId);
    if (
      typeof goal !== 'string' ||
      !goal.trim() ||
      goal.length > 16000 ||
      typeof selectionRef !== 'string'
    )
      throw Error('invalid_project');
    const { path } = await this.rememberSelection(operationId, selectionRef);
    let entry: Entry = {
      version: 1,
      operationId,
      ...scope,
      selectionRef,
      path,
      goal: goal.trim(),
    };
    const prior = await this.objects.getReference(entryKey(scope.projectId));
    if (prior) {
      const saved = await this.entry(scope.projectId);
      if (
        saved.path !== entry.path ||
        saved.goal !== entry.goal ||
        saved.operationId !== operationId
      )
        throw Error('project_entry_conflict');
      entry = saved;
    } else {
      await this.objects.bindReference(entryKey(scope.projectId), await this.objects.put(entry));
    }
    await this.messages.initializeState(
      scope,
      createInitialAppState(scope.taskId, entry.goal, scope.projectId),
    );
    const proposalKey = localRecordHash({ kind: 'desktop-grant-proposal-v1', ...scope });
    const existing = await this.objects.getReference(proposalKey);
    if (existing) return this.objects.get(existing);
    const proposal = await this.grants.prepareGrant(scope, {
      path,
      selectionRef: entry.selectionRef,
    });
    const result = {
      entry,
      grant: {
        ...scope,
        actionId: `grant-${operationId}`,
        expectedRevision: proposal.proposal.expectedRevision,
        selectionRef: entry.selectionRef,
        policyProposalId: proposal.policyProposalId,
        inputHash: proposal.inputHash,
      },
      policy: proposal.proposal.policy,
    };
    const saved = await this.objects.put(result);
    await this.objects.bindReference(proposalKey, saved);
    return result;
  }
  private async active(entry: Entry) {
    await this.host.owner.assertHeld();
    await this.host.selections.assertAccepted(entry.path);
    const scope = { projectId: entry.projectId, taskId: entry.taskId };
    if (!(await this.messages.store.load(scope))?.localExecution)
      throw Error('authorization_closed');
    const state = await this.control.assertClosed(scope);
    const registry = await this.control.snapshot();
    const root = registry.roots.find(
      (r) =>
        r.projectId === entry.projectId &&
        r.selectionRef === entry.selectionRef &&
        state.localExecution?.rootIds.includes(r.rootId),
    );
    const grant = registry.grants.find(
      (g) => g.projectId === entry.projectId && g.rootId === root?.rootId && g.status === 'active',
    );
    if (!root || !grant || root.path !== entry.path) throw Error('authorization_closed');
    await this.grants.assertGrant(scope, grant.grantId);
    return { scope, state, root, grant };
  }
  async inspect(projectId: string) {
    const entry = await this.entry(projectId);
    const { scope, root, grant } = await this.active(entry);
    const registry = await this.control.snapshot();
    const initialized = registry.operations.find(
      (o) =>
        'kind' in o &&
        o.kind === 'root-initialization' &&
        o.rootId === root.rootId &&
        o.grantId === grant.grantId,
    );
    await this.roots.initialize({
      ...scope,
      actionId: `initialize-${entry.operationId}`,
      rootId: root.rootId,
      grantId: grant.grantId,
      expectedRevision: initialized ? initialized.preparedRevision - 1 : registry.revision,
    });
    const current = await this.active(entry);
    const binding = localRootBinding(current.root);
    const versionScope = { ...scope, rootId: root.rootId, policyHash: grant.policyHash };
    const authorize = async () => {
      await this.active(entry);
      return true;
    };
    const baseline = await this.versions.capture(versionScope, binding, authorize);
    const manifest = await this.versions.read(baseline, versionScope);
    const directory = inspectLocalDirectory(binding, '', this.filesHelper);
    const visible = directory.entries.filter((e) => e.kind !== 'excluded');
    const files = visible.slice(0, 256);
    const names = new Set(directory.entries.filter((e) => e.kind === 'file').map((e) => e.name));
    let scripts: Record<string, string> = {};
    const limitations: string[] = [];
    let readme: { name: string; text: string } | undefined;
    const readmeName = ['README.md', 'README.txt', 'README'].find((name) => names.has(name));
    if (readmeName) {
      await this.grants.assertGrant(scope, grant.grantId);
      const bytes = inspectLocalFileBytes(binding, readmeName, this.filesHelper).content;
      if (bytes.length <= 65536) readme = { name: readmeName, text: bytes.toString('utf8') };
      else limitations.push('README exceeds the 64 KiB inspection limit.');
    }
    if (names.has('package.json')) {
      await this.grants.assertGrant(scope, grant.grantId);
      const bytes = inspectLocalFileBytes(binding, 'package.json', this.filesHelper).content;
      if (bytes.length > 65536)
        limitations.push('package.json exceeds the 64 KiB inspection limit.');
      else {
        try {
          const pkg = JSON.parse(bytes.toString('utf8'));
          const declarations = Object.entries(pkg.scripts ?? {});
          scripts = Object.fromEntries(
            declarations
              .filter(([k, v]) => k.length <= 128 && typeof v === 'string' && v.length <= 1024)
              .slice(0, 32),
          ) as Record<string, string>;
          if (declarations.length > Object.keys(scripts).length)
            limitations.push(
              'Some script declarations were omitted (32 scripts, 128-character names and 1024-character values maximum).',
            );
        } catch {
          limitations.push('package.json could not be interpreted.');
        }
      }
    }
    if (
      ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'pnpm-workspace.yaml', '.npmrc'].some(
        (n) => names.has(n),
      )
    )
      limitations.push(
        'The current managed installer does not support the detected lock or configuration file. Existing files are retained.',
      );
    limitations.push(
      'Scripts are declarations, not verified commands. Only the managed Node command adapter is enabled.',
    );
    await this.versions.verify(baseline, versionScope, binding, authorize);
    const inspection = await this.objects.put({
      version: 2,
      entryHash: localRecordHash(entry),
      rootId: root.rootId,
      grantId: grant.grantId,
      initializationActionId: `initialize-${entry.operationId}`,
      baseline,
    });
    return {
      inspectionRef: inspection,
      baselineFiles: manifest.files.length,
      files,
      truncated: visible.length > 256,
      scripts,
      limitations,
      readme,
    };
  }
  async start(projectId: string, requestId: string, inspectionRef?: string) {
    const entry = await this.entry(projectId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
      throw Error('invalid_start_request');
    return this.tasks.startPrepared(
      { projectId, taskId: entry.taskId, goal: entry.goal, requestId },
      async (state) => {
        const { scope, root, grant } = await this.active(entry);
        if (!firstRunStartEligible(state)) throw Error('prepared_task_already_used');
        if (!inspectionRef || !/^[a-f0-9]{64}$/.test(inspectionRef))
          throw Error('workspace_inspection_required');
        const inspection = (await this.objects.get(inspectionRef)) as Record<string, unknown>;
        if (
          !inspection ||
          !isWorkspaceVersionV1(inspection.baseline) ||
          localRecordHash(inspection) !==
            localRecordHash({
              version: 2,
              entryHash: localRecordHash(entry),
              rootId: root.rootId,
              grantId: grant.grantId,
              initializationActionId: `initialize-${entry.operationId}`,
              baseline: inspection.baseline,
            })
        )
          throw Error('workspace_inspection_required');
        try {
          await this.versions.verify(
            inspection.baseline,
            { ...scope, rootId: root.rootId, policyHash: grant.policyHash },
            localRootBinding(root),
            async () => {
              await this.active(entry);
              return true;
            },
          );
        } catch {
          throw Error('workspace_inspection_stale');
        }
        if (await this.objects.getReference(launchKey(scope)))
          throw Error('first_start_requires_attention');
        const selectionRef = this.selections.get(scopeKey(scope));
        if (
          !selectionRef ||
          (await this.host.selections.resolve(scope, selectionRef)) !== entry.path
        )
          throw Error('selection_unavailable');
        await this.models.freezeChecked(scope, entry.goal);
        const receipt = await this.objects.put({
          version: 1,
          ...scope,
          requestId,
          entryHash: localRecordHash(entry),
          stateHash: localRecordHash(state),
          inspectionRef,
        });
        await this.objects.bindReference(launchKey(scope), receipt);
      },
    );
  }
}
let service: Promise<FirstRunService> | undefined;
export function firstRunService() {
  const desktop = localBootstrap()?.desktop;
  if (!desktop) throw Error('desktop_acceptance_only');
  if (!service && localBootstrap()?.draining) throw Error('service_stopping');
  if (!service) {
    const drains = localBootstrap()?.drains;
    const pending = FirstRunService.create(desktop);
    const drain = async () => {
      const ready = await pending.catch(() => undefined);
      await ready?.drain();
    };
    drains?.add(drain);
    service = pending.catch((error) => {
      drains?.delete(drain);
      service = undefined;
      throw error;
    });
  }
  return service;
}
