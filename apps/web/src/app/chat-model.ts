export type PresenceStatus = 'online' | 'active' | 'away' | 'offline';

export interface ChatMessageView {
  msgId: string;
  fromRole: string;
  display: string;
  ts: number;
  payload?: Record<string, unknown>;
  reference?: string;
}

export interface PendingMessageSubmission {
  msgId: string;
  display: string;
}

export interface LeaderActionNotice {
  kind: 'applied' | 'rejected' | 'deferred';
  text: string;
}

export interface TeamMemberView {
  role: string;
  name: string;
  status: PresenceStatus;
}

export interface ActiveWorkerView {
  role: string;
  name: string;
  detail: string;
}

export interface ChannelView {
  id: string;
  name: string;
  kind: 'main' | 'sub';
  closed: boolean;
}

export interface WorkspaceViewModel {
  task: {
    id: string;
    title: string;
    status: string;
  };
  channel: {
    id: string;
    name: string;
  };
  channels?: ChannelView[];
  team: TeamMemberView[];
  activeWorkers: ActiveWorkerView[];
  messages: ChatMessageView[];
}

export interface TaskRuntimeView {
  projectId: string;
  taskId: string;
  goal: string;
  runStatus: 'running' | 'completed' | 'needs_attention' | 'failed' | 'interrupted';
  phase: string;
  currentRole: string | null;
  testResults: { passed: boolean; total: number; failed: number } | null;
  artifactPath: string | null;
  messageCount: number;
  error?: string;
}

export async function fetchTaskRuntime(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<TaskRuntimeView> {
  const response = await fetcher(url);
  const body = (await response.json()) as TaskRuntimeView & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Task refresh failed (${response.status})`);
  }
  return body;
}

export async function fetchChannelRegistry(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<ChannelView[]> {
  const response = await fetcher(url);
  let body: { channels?: unknown; error?: string } | undefined;
  try {
    body = (await response.json()) as { channels?: unknown; error?: string };
  } catch (error) {
    if (!response.ok)
      throw new Error(`Channel refresh failed (${response.status})`, { cause: error });
    throw new Error('invalid Channel registry response', { cause: error });
  }
  if (!response.ok) throw new Error(body.error ?? `Channel refresh failed (${response.status})`);
  if (!Array.isArray(body.channels)) throw new Error('invalid Channel registry response');

  return body.channels.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('invalid Channel registry response');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.channelId !== 'string' ||
      (record.kind !== 'main' && record.kind !== 'sub') ||
      typeof record.closed !== 'boolean'
    ) {
      throw new Error('invalid Channel registry response');
    }
    if (record.kind === 'sub' && typeof record.topic !== 'string') {
      throw new Error('invalid Channel registry response');
    }
    return {
      id: record.channelId,
      name: record.kind === 'main' ? 'main' : (record.topic as string),
      kind: record.kind,
      closed: record.closed,
    };
  });
}

export const MENTIONABLE_ROLES = [
  'CODER',
  'TESTER',
  'REVIEWER',
  'COORDINATOR',
  'PM',
  'ARCHITECT',
] as const;

export function sortMessagesByTimestamp<T extends { ts: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((left, right) => left.ts - right.ts);
}

export function mergeMessageById(
  messages: readonly ChatMessageView[],
  incoming: ChatMessageView,
): ChatMessageView[] {
  const existingIndex = messages.findIndex((message) => message.msgId === incoming.msgId);
  if (existingIndex < 0) return [...messages, incoming];
  const next = [...messages];
  next[existingIndex] = incoming;
  return next;
}

export function prepareMessageSubmission(
  current: PendingMessageSubmission | undefined,
  display: string,
  createId: () => string,
): PendingMessageSubmission {
  if (current?.display === display) return current;
  return { msgId: createId(), display };
}

export function leaderActionNoticeFromResponse(value: unknown): LeaderActionNotice | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid Leader action response');
  }
  const action = (value as Record<string, unknown>).action;
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    throw new Error('invalid Leader action response');
  }
  const record = action as Record<string, unknown>;
  if (record.status === 'none') return undefined;
  if (record.status === 'applied') {
    return { kind: 'applied', text: 'Leader assignment applied.' };
  }
  if (record.status === 'rejected' && typeof record.reason === 'string') {
    return { kind: 'rejected', text: `Command rejected: ${record.reason}` };
  }
  if (
    record.status === 'deferred' &&
    (record.targetPhase === 6 || record.targetPhase === 8 || record.targetPhase === 9) &&
    typeof record.reason === 'string'
  ) {
    return {
      kind: 'deferred',
      text: `Command deferred to Phase ${String(record.targetPhase)}: ${record.reason}`,
    };
  }
  throw new Error('invalid Leader action response');
}

export function nextMessageTimestamp(
  messages: readonly { ts: number }[],
  now = Date.now(),
): number {
  let latest = 0;
  for (const message of messages) {
    latest = Math.max(latest, message.ts);
  }
  return Math.max(now, latest + 1);
}

export function filterMentionOptions(query: string): string[] {
  const normalized = query.trim().toUpperCase();
  return MENTIONABLE_ROLES.filter((role) => role.startsWith(normalized));
}

export function getMentionQuery(input: string): string | undefined {
  const match = input.match(/@([A-Za-z]*)$/);
  return match?.[1];
}

export function applyMention(input: string, role: string): string {
  const matches = [...input.matchAll(/@[A-Za-z]*/g)];
  const active = matches.at(-1);
  if (active?.index === undefined) {
    return `${input}@${role} `;
  }

  return `${input.slice(0, active.index)}@${role}${input.slice(active.index + active[0].length)}`;
}

export const DEFAULT_WORKSPACE: WorkspaceViewModel = {
  task: {
    id: 'lru-demo',
    title: 'TTL-aware LRU cache',
    status: 'Not started',
  },
  channel: {
    id: 'main',
    name: 'main',
  },
  channels: [{ id: 'main', name: 'main', kind: 'main', closed: false }],
  team: [
    { role: 'LEADER', name: 'Leader (You)', status: 'online' },
    { role: 'COORDINATOR', name: 'Coordinator', status: 'online' },
    { role: 'PM', name: 'PM', status: 'away' },
    { role: 'ARCHITECT', name: 'Architect', status: 'online' },
    { role: 'CODER', name: 'Coder', status: 'online' },
    { role: 'TESTER', name: 'Tester', status: 'online' },
    { role: 'REVIEWER', name: 'Reviewer', status: 'offline' },
  ],
  activeWorkers: [],
  messages: [],
};
