import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, type HarnessExecutorOptions } from '@agora/runtime-executor';
import {
  JsonModelConfigStore,
  normalizeModelConnection,
  type TaskModelBinding,
  type TaskScope,
} from '@agora/runtime-state';
import type { ModelSettingsCommand, ModelSettingsView } from '../lib/model-settings';
import type { MessageRuntime } from './message-runtime';

export class ModelSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Project defaults are mutable; a task's first model binding is immutable. */
export class ModelSettingsService {
  readonly store: JsonModelConfigStore;
  constructor(
    private readonly messages: MessageRuntime,
    store?: JsonModelConfigStore,
  ) {
    this.store = store ?? new JsonModelConfigStore(messages.root);
  }
  private async snapshot(projectId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId))
      throw new ModelSettingsError('Invalid project ID.');
    await this.messages.ensureProjectChannels(projectId);
    const value = await this.messages.collaboration.load(projectId);
    if (!value) throw new ModelSettingsError('Project is unavailable.', 503);
    return value;
  }
  async get(projectId: string): Promise<ModelSettingsView> {
    const snapshot = await this.snapshot(projectId);
    const roles = await Promise.all(
      snapshot.roster.map(async ({ spec, status }) => {
        const connection = spec.modelConnectionId
          ? await this.store.loadConnection(projectId, spec.modelConnectionId)
          : undefined;
        return {
          role: spec.role,
          status,
          model: spec.model ?? process.env.AGORA_MODEL ?? 'deepseek-v4-flash',
          apiKeyConfigured: connection?.auth.kind === 'encrypted',
          ...(connection
            ? {
                connectionId: connection.id,
                baseURL: connection.baseURL,
                contextWindow: connection.contextWindow,
                maxTokens: connection.maxTokens,
              }
            : {}),
        };
      }),
    );
    return {
      revision: snapshot.revision,
      credentialsAvailable: this.store.credentialsAvailable,
      roles,
    };
  }
  async execute(command: ModelSettingsCommand): Promise<ModelSettingsView | { ok: true }> {
    const snapshot = await this.snapshot(command.projectId);
    if (snapshot.revision !== command.expectedRevision)
      throw new ModelSettingsError('Team settings changed. Reload before saving again.', 409);
    const targets =
      command.target === 'all'
        ? snapshot.roster
            .filter((r) => r.status === 'enabled' || r.status === 'disabled')
            .map((r) => r.spec.role)
        : [command.target];
    if (
      !targets.length ||
      targets.some(
        (role) =>
          !snapshot.roster.some(
            (r) => r.spec.role === role && (r.status === 'enabled' || r.status === 'disabled'),
          ),
      )
    )
      throw new ModelSettingsError('Select a current, configurable Agent.');
    if (command.action === 'reset') {
      await this.commit(command, targets, null);
      return this.get(command.projectId);
    }
    const draft = await this.resolveDraft(command);
    if (command.action === 'test') {
      const executor = new HarnessExecutor(
        {
          ...defaultCoordinator(),
          model: draft.model,
          systemPrompt: 'Reply with OK. Do not use tools.',
        },
        {
          compatible: {
            id: 'connection-test',
            ...draft.connection,
            model: draft.model,
            maxTokens: Math.min(32, draft.connection.maxTokens),
            resolveApiKey: async () => draft.key,
          },
        },
      );
      try {
        await executor.step({
          sessionId: 'connection-test',
          view: { role: 'COORDINATOR', slices: { instruction: 'Reply OK.' } },
        });
      } catch {
        throw new ModelSettingsError(
          'Connection test failed. Check the service URL, API key, model and Chat Completions support.',
          502,
        );
      } finally {
        await executor.dispose();
      }
      return { ok: true };
    }
    const connection =
      draft.existing ??
      (await this.store.createConnection(command.projectId, draft.connection, draft.key));
    await this.commit(command, targets, { model: draft.model, modelConnectionId: connection.id });
    return this.get(command.projectId);
  }
  private async commit(
    command: ModelSettingsCommand,
    targets: string[],
    setting: { model: string; modelConnectionId: string } | null,
  ) {
    try {
      await this.messages.roster.configureModels(
        command.projectId,
        command.expectedRevision,
        targets,
        setting,
      );
    } catch (error) {
      if (error instanceof Error && /revision/.test(error.message))
        throw new ModelSettingsError('Team settings changed. Reload before saving again.', 409);
      throw error;
    }
  }
  private async resolveDraft(command: ModelSettingsCommand) {
    if (
      typeof command.model !== 'string' ||
      !command.model.trim() ||
      command.model.length > 256 ||
      [...command.model].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new ModelSettingsError('Enter a model name.');
    const connection = normalizeModelConnection({
      baseURL: command.baseURL as string,
      contextWindow: command.contextWindow as number,
      maxTokens: command.maxTokens as number,
    });
    const model = command.model.trim();
    if (command.auth === 'keep') {
      if (!command.connectionId || command.apiKey)
        throw new ModelSettingsError('Choose an existing connection to keep its key.');
      const existing = await this.store.loadConnection(command.projectId, command.connectionId);
      if (existing.baseURL !== connection.baseURL)
        throw new ModelSettingsError(
          'Enter a new key or choose no authentication when changing the service URL.',
        );
      const key = await this.store.resolveKey(command.projectId, existing.id);
      return {
        model,
        connection,
        key,
        ...(existing.contextWindow === connection.contextWindow &&
        existing.maxTokens === connection.maxTokens
          ? { existing }
          : {}),
      };
    }
    if (command.auth === 'none' && !command.apiKey) return { model, connection, key: undefined };
    if (
      command.auth !== 'replace' ||
      typeof command.apiKey !== 'string' ||
      !command.apiKey.trim() ||
      command.apiKey.length > 8192 ||
      /[\r\n\0]/.test(command.apiKey)
    )
      throw new ModelSettingsError('Enter an API key or explicitly choose no authentication.');
    if (!this.store.credentialsAvailable)
      throw new ModelSettingsError(
        'Configure AGORA_CREDENTIALS_KEY on the server to store API keys.',
        503,
      );
    return { model, connection, key: command.apiKey };
  }
  async freeze(scope: TaskScope, goal: string, legacy = false): Promise<TaskModelBinding> {
    const existing = await this.store.loadTask(scope);
    if (existing) {
      if (existing.goal !== goal) throw new Error('task model goal conflict');
      return existing;
    }
    const snapshot = await this.snapshot(scope.projectId);
    return this.store.bindTask({
      version: 1,
      ...scope,
      goal,
      defaultModel: process.env.AGORA_MODEL ?? 'deepseek-v4-flash',
      roles: snapshot.roster.map(({ spec }) => {
        const original = legacy ? DEFAULT_ROSTER.find((r) => r.role === spec.role) : spec;
        return {
          role: spec.role,
          model: original?.model ?? process.env.AGORA_MODEL ?? 'deepseek-v4-flash',
          ...(!legacy && spec.modelConnectionId ? { connectionId: spec.modelConnectionId } : {}),
        };
      }),
    });
  }
  async executorRoutes(
    binding: TaskModelBinding,
  ): Promise<
    Map<string, { model: string; compatible?: NonNullable<HarnessExecutorOptions['compatible']> }>
  > {
    return new Map(
      await Promise.all(
        binding.roles.map(async (role) => {
          if (!role.connectionId) return [role.role, { model: role.model }] as const;
          const c = await this.store.loadConnection(binding.projectId, role.connectionId);
          await this.store.resolveKey(binding.projectId, c.id);
          return [
            role.role,
            {
              model: role.model,
              compatible: {
                id: c.id,
                baseURL: c.baseURL,
                model: role.model,
                contextWindow: c.contextWindow,
                maxTokens: c.maxTokens,
                resolveApiKey: () => this.store.resolveKey(binding.projectId, c.id),
              },
            },
          ] as const;
        }),
      ),
    );
  }
}

export function modelSettingsHandlers(service: ModelSettingsService) {
  const failure = (error: unknown) =>
    Response.json(
      {
        error:
          error instanceof ModelSettingsError
            ? error.message
            : 'Model settings are unavailable or invalid. Check the input and server configuration.',
      },
      {
        status: error instanceof ModelSettingsError ? error.status : 400,
        headers: { 'cache-control': 'no-store' },
      },
    );
  return {
    GET: async (request: Request) => {
      try {
        return Response.json(
          await service.get(new URL(request.url).searchParams.get('projectId') ?? ''),
          { headers: { 'cache-control': 'no-store' } },
        );
      } catch (error) {
        return failure(error);
      }
    },
    POST: async (request: Request) => {
      try {
        const origin = request.headers.get('origin');
        const url = new URL(request.url);
        const requestHost = request.headers.get('host') ?? url.host;
        const requestProtocol =
          request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1);
        if (
          (origin &&
            (new URL(origin).host !== requestHost ||
              new URL(origin).protocol !== `${requestProtocol}:`)) ||
          request.headers.get('sec-fetch-site') === 'cross-site'
        )
          throw new ModelSettingsError('Settings requests must come from this site.', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json'))
          throw new ModelSettingsError('Expected JSON.');
        const reader = request.body?.getReader();
        if (!reader) throw new ModelSettingsError('Expected a request body.');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            if (size > 20000) {
              await reader.cancel();
              throw new ModelSettingsError('Settings request is too large.', 413);
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const allowed = [
          'action',
          'projectId',
          'expectedRevision',
          'target',
          'model',
          'baseURL',
          'contextWindow',
          'maxTokens',
          'auth',
          'connectionId',
          'apiKey',
        ];
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((k) => !allowed.includes(k))
        )
          throw new ModelSettingsError('Invalid settings request.');
        const command = body as ModelSettingsCommand;
        if (
          !['save', 'reset', 'test'].includes(command.action) ||
          typeof command.projectId !== 'string' ||
          typeof command.target !== 'string' ||
          !Number.isSafeInteger(command.expectedRevision) ||
          command.expectedRevision < 0
        )
          throw new ModelSettingsError('Invalid settings request.');
        return Response.json(await service.execute(command), {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function defaultCoordinator() {
  const spec = DEFAULT_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('Coordinator definition unavailable');
  return spec;
}
