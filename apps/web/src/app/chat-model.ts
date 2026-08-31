export type PresenceStatus = 'online' | 'active' | 'away' | 'offline';

export interface ChatMessageView {
  msgId: string;
  fromRole: string;
  display: string;
  ts: number;
  payload?: Record<string, unknown>;
  reference?: string;
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
  team: TeamMemberView[];
  activeWorkers: ActiveWorkerView[];
  messages: ChatMessageView[];
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

const baseTimestamp = Date.UTC(2026, 7, 31, 14, 12);

export const DEFAULT_WORKSPACE: WorkspaceViewModel = {
  task: {
    id: '5.2',
    title: 'Group chat UI',
    status: 'In progress',
  },
  channel: {
    id: 'main',
    name: 'main',
  },
  team: [
    { role: 'LEADER', name: 'Leader (You)', status: 'online' },
    { role: 'COORDINATOR', name: 'Coordinator', status: 'online' },
    { role: 'PM', name: 'PM', status: 'away' },
    { role: 'ARCHITECT', name: 'Architect', status: 'online' },
    { role: 'CODER', name: 'Coder', status: 'active' },
    { role: 'TESTER', name: 'Tester', status: 'active' },
    { role: 'REVIEWER', name: 'Reviewer', status: 'offline' },
  ],
  activeWorkers: [
    { role: 'CODER', name: 'Coder', detail: 'Implementing the chat UI' },
    { role: 'TESTER', name: 'Tester', detail: 'Running interaction checks' },
  ],
  messages: [
    {
      msgId: 'message-1',
      fromRole: 'LEADER',
      display: '@CODER tighten the cache eviction tests before review.',
      ts: baseTimestamp,
    },
    {
      msgId: 'message-2',
      fromRole: 'COORDINATOR',
      display: 'Acknowledged. Prioritizing tests and moving review behind the next green run.',
      reference: 'docs/task-status.json',
      ts: baseTimestamp + 60_000,
    },
    {
      msgId: 'message-3',
      fromRole: 'CODER',
      display:
        'Added TTL boundary tests and LRU pressure cases. The eviction path is stable locally.',
      reference: 'tests/cache/eviction.test.ts',
      ts: baseTimestamp + 6 * 60_000,
    },
    {
      msgId: 'message-4',
      fromRole: 'TESTER',
      display: 'The focused suite is green. Running the full regression now.',
      reference: 'test-results/phase5.md',
      ts: baseTimestamp + 12 * 60_000,
    },
    {
      msgId: 'message-5',
      fromRole: 'COORDINATOR',
      display: 'Great. Ping this channel when it is stable, then we will hand off to Reviewer.',
      ts: baseTimestamp + 15 * 60_000,
    },
  ],
};
