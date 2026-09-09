import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskScope } from './base';

export interface ModelConnectionInput {
  baseURL: string;
  contextWindow: number;
  maxTokens: number;
}
export interface ModelConnection extends ModelConnectionInput {
  version: 1;
  projectId: string;
  id: string;
  auth: { kind: 'none' } | { kind: 'encrypted'; iv: string; tag: string; ciphertext: string };
}
export interface TaskModelBinding {
  version: 1;
  projectId: string;
  taskId: string;
  goal: string;
  defaultModel?: string;
  roles: { role: string; model: string; connectionId?: string }[];
}
export interface ModelConfigStore {
  createConnection(
    projectId: string,
    input: ModelConnectionInput,
    apiKey?: string,
  ): Promise<ModelConnection>;
  loadConnection(projectId: string, id: string): Promise<ModelConnection>;
  resolveKey(projectId: string, id: string): Promise<string | undefined>;
  loadTask(scope: TaskScope): Promise<TaskModelBinding | undefined>;
  bindTask(binding: TaskModelBinding): Promise<TaskModelBinding>;
}

export function normalizeModelConnection(input: ModelConnectionInput): ModelConnectionInput {
  if (typeof input.baseURL !== 'string' || input.baseURL.length > 2048)
    throw new Error('invalid model service URL');
  const url = new URL(input.baseURL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('model service requires HTTPS or loopback HTTP without credentials or query');
  if (
    !Number.isSafeInteger(input.contextWindow) ||
    input.contextWindow < 1024 ||
    input.contextWindow > 2_000_000 ||
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    input.maxTokens > input.contextWindow
  )
    throw new Error('invalid model token limits');
  return {
    baseURL: url.href.replace(/\/+$/, ''),
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
  };
}

/** Immutable records keep credentials and running task configuration out of mutable roster data. */
export class JsonModelConfigStore implements ModelConfigStore {
  constructor(
    private readonly root: string,
    private readonly masterKey: () => string | undefined = () => process.env.AGORA_CREDENTIALS_KEY,
  ) {}
  get credentialsAvailable(): boolean {
    try {
      this.key();
      return true;
    } catch {
      return false;
    }
  }
  async createConnection(
    projectId: string,
    input: ModelConnectionInput,
    apiKey?: string,
  ): Promise<ModelConnection> {
    segment(projectId);
    const safe = normalizeModelConnection(input);
    if (apiKey !== undefined && (!apiKey.trim() || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)))
      throw new Error('invalid API key');
    const id = randomUUID();
    const metadata = { version: 1 as const, projectId, id, ...safe };
    let auth: ModelConnection['auth'] = { kind: 'none' };
    if (apiKey !== undefined) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
      cipher.setAAD(aad(metadata));
      const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      auth = {
        kind: 'encrypted',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    }
    const record = { ...metadata, auth };
    await this.writeImmutable(await this.connectionPath(projectId, id), record);
    return record;
  }
  async loadConnection(projectId: string, id: string): Promise<ModelConnection> {
    const raw = await this.read(await this.connectionPath(projectId, id));
    if (!record(raw) || raw.version !== 1 || raw.projectId !== projectId || raw.id !== id)
      throw new Error('model connection unavailable');
    exact(raw, ['version', 'projectId', 'id', 'baseURL', 'contextWindow', 'maxTokens', 'auth']);
    const safe = normalizeModelConnection(raw as unknown as ModelConnectionInput);
    if (safe.baseURL !== raw.baseURL || !record(raw.auth))
      throw new Error('invalid model connection');
    if (raw.auth.kind === 'none') exact(raw.auth, ['kind']);
    else {
      exact(raw.auth, ['kind', 'iv', 'tag', 'ciphertext']);
      if (
        raw.auth.kind !== 'encrypted' ||
        typeof raw.auth.iv !== 'string' ||
        typeof raw.auth.tag !== 'string' ||
        typeof raw.auth.ciphertext !== 'string' ||
        Buffer.from(raw.auth.iv, 'base64').length !== 12 ||
        Buffer.from(raw.auth.tag, 'base64').length !== 16
      )
        throw new Error('invalid encrypted credential');
    }
    return raw as unknown as ModelConnection;
  }
  async resolveKey(projectId: string, id: string): Promise<string | undefined> {
    const connection = await this.loadConnection(projectId, id);
    if (connection.auth.kind === 'none') return undefined;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        Buffer.from(connection.auth.iv, 'base64'),
      );
      decipher.setAAD(aad(connection));
      decipher.setAuthTag(Buffer.from(connection.auth.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(connection.auth.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('model credential cannot be decrypted');
    }
  }
  async loadTask(scope: TaskScope): Promise<TaskModelBinding | undefined> {
    const raw = await this.read(await this.taskPath(scope));
    if (raw === undefined) return undefined;
    assertBinding(raw);
    if (raw.projectId !== scope.projectId || raw.taskId !== scope.taskId)
      throw new Error('task model scope mismatch');
    return raw;
  }
  async bindTask(binding: TaskModelBinding): Promise<TaskModelBinding> {
    assertBinding(binding);
    for (const role of binding.roles)
      if (role.connectionId) await this.loadConnection(binding.projectId, role.connectionId);
    await this.writeImmutable(await this.taskPath(binding), binding);
    const saved = await this.loadTask(binding);
    if (!saved || saved.goal !== binding.goal) throw new Error('task model goal conflict');
    return saved;
  }
  private key(): Buffer {
    const value = this.masterKey();
    if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32)
      throw new Error('AGORA_CREDENTIALS_KEY must be a 32-byte base64 key');
    return Buffer.from(value, 'base64');
  }
  private async path(parts: string[]): Promise<string> {
    for (const part of parts) segment(part);
    const root = resolve(this.root);
    await mkdir(root, { recursive: true });
    let current = await realpath(root);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      await mkdir(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('invalid model storage directory');
    }
    return join(current, parts.at(-1) as string);
  }
  private connectionPath(projectId: string, id: string) {
    segment(id);
    return this.path(['projects', projectId, 'model-connections', `${id}.json`]);
  }
  private taskPath(scope: TaskScope) {
    return this.path(['projects', scope.projectId, 'tasks', scope.taskId, 'model-bindings.json']);
  }
  private async read(path: string): Promise<unknown> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000)
        throw new Error('invalid model storage file');
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  private async writeImmutable(path: string, value: unknown): Promise<void> {
    const temporary = join(dirname(path), `.model-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
      await link(temporary, path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
}
function segment(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new Error('invalid model storage identity');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((k) => !(k in value)))
    throw new Error('invalid model record shape');
}
function aad(c: Omit<ModelConnection, 'auth'>) {
  return Buffer.from(
    JSON.stringify([c.version, c.projectId, c.id, c.baseURL, c.contextWindow, c.maxTokens]),
  );
}
function assertBinding(value: unknown): asserts value is TaskModelBinding {
  if (!record(value)) throw new Error('invalid task model binding');
  exact(value, [
    'version',
    'projectId',
    'taskId',
    'goal',
    'roles',
    ...(value.defaultModel === undefined ? [] : ['defaultModel']),
  ]);
  if (
    value.defaultModel !== undefined &&
    (typeof value.defaultModel !== 'string' ||
      !value.defaultModel.trim() ||
      value.defaultModel.length > 256)
  )
    throw new Error('invalid deployment model binding');
  if (
    value.version !== 1 ||
    typeof value.goal !== 'string' ||
    !Array.isArray(value.roles) ||
    !value.roles.length
  )
    throw new Error('invalid task model binding');
  segment(value.projectId as string);
  segment(value.taskId as string);
  const seen = new Set();
  for (const role of value.roles) {
    if (!record(role)) throw new Error('invalid model role');
    exact(
      role,
      role.connectionId === undefined ? ['role', 'model'] : ['role', 'model', 'connectionId'],
    );
    if (
      typeof role.role !== 'string' ||
      !/^[A-Z][A-Z0-9_-]*$/.test(role.role) ||
      seen.has(role.role) ||
      typeof role.model !== 'string' ||
      !role.model.trim() ||
      role.model.length > 256
    )
      throw new Error('invalid model role');
    seen.add(role.role);
    if (role.connectionId !== undefined) segment(role.connectionId as string);
  }
}
