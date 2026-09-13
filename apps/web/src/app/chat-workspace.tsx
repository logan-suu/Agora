'use client';

import * as React from 'react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { ChatHistory } from './chat-history';
import {
  applyMention,
  type ChannelView,
  type ChatMessageView,
  DEFAULT_WORKSPACE,
  fetchChannelRegistry,
  fetchTaskRuntime,
  fetchTraceSnapshot,
  filterMentionOptions,
  getMentionQuery,
  type LeaderActionNotice,
  leaderActionNoticeFromResponse,
  mergeMessageById,
  type PendingMessageSubmission,
  type PresenceStatus,
  prepareMessageSubmission,
  sortMessagesByTimestamp,
  type TaskRuntimeView,
  type TeamMemberView,
  type TraceSnapshotView,
  type WorkspaceViewModel,
} from './chat-model';
import { MessageContent } from './message-content';
import { MessageMarkdown } from './message-markdown';
import { ModelSettingsDialog } from './model-settings-dialog';
import { RequirementProposalCard } from './requirement-proposal-card';
import { traceLanes } from './trace-lanes';

interface ChatWorkspaceProps {
  model?: WorkspaceViewModel;
  projectId?: string;
}

const roleLabels: Record<string, string> = {
  ARCHITECT: 'Architect',
  CODER: 'Coder',
  COORDINATOR: 'Coordinator',
  LEADER: 'Leader (You)',
  leader: 'Leader (You)',
  PM: 'PM',
  REVIEWER: 'Reviewer',
  TESTER: 'Tester',
};

const roleInitials: Record<string, string> = {
  ARCHITECT: 'A',
  CODER: 'CO',
  COORDINATOR: 'C',
  LEADER: 'L',
  leader: 'L',
  PM: 'P',
  REVIEWER: 'R',
  TESTER: 'T',
};

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      {children}
    </svg>
  );
}

function MenuIcon() {
  return (
    <Icon>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" />
    </Icon>
  );
}

function MoreIcon() {
  return (
    <Icon>
      <circle cx="12" cy="5" fill="currentColor" r="1.4" />
      <circle cx="12" cy="12" fill="currentColor" r="1.4" />
      <circle cx="12" cy="19" fill="currentColor" r="1.4" />
    </Icon>
  );
}

function TerminalMark() {
  return (
    <span className="terminal-mark" aria-hidden="true">
      <Icon size={22}>
        <path
          d="m7 8 4 4-4 4m6 0h4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </Icon>
    </span>
  );
}

function RoleAvatar({ role, status }: { role: string; status?: PresenceStatus | undefined }) {
  return (
    <span className={`role-avatar role-${role.toLowerCase()}`} aria-hidden="true">
      {roleInitials[role] ?? role.slice(0, 2)}
      {status ? <span className={`presence presence-${status}`} /> : null}
    </span>
  );
}

function TeamRow({
  member,
  onConfigure,
}: {
  member: TeamMemberView;
  onConfigure: (role: string) => void;
}) {
  return (
    <li className="team-row">
      <RoleAvatar role={member.role} status={member.status} />
      <span>
        <strong>{member.name}</strong>
        <small>{member.status}</small>
      </span>
      {member.role.toUpperCase() !== 'LEADER' ? (
        <button
          type="button"
          className="team-model-button"
          aria-label={`Configure ${member.role} model`}
          onClick={() => onConfigure(member.role)}
        >
          Model
        </button>
      ) : null}
    </li>
  );
}

function LeftSidebar({
  model,
  channels,
  selectedChannelId,
  open,
  onSelectChannel,
  onConfigureModel,
}: {
  model: WorkspaceViewModel;
  channels: ChannelView[];
  selectedChannelId: string;
  open: boolean;
  onSelectChannel: (channelId: string) => void;
  onConfigureModel: (role: string) => void;
}) {
  return (
    <aside className="left-sidebar" data-open={open} aria-label="Workspace navigation">
      <section className="sidebar-section">
        <h2>Channels</h2>
        {channels.map((channel) => (
          <button
            className={`channel-row${channel.id === selectedChannelId ? ' channel-row-selected' : ''}`}
            key={channel.id}
            type="button"
            onClick={() => onSelectChannel(channel.id)}
          >
            <span aria-hidden="true">#</span>
            <span className="channel-row-label">{channel.name}</span>
            {channel.closed ? <small>closed</small> : null}
          </button>
        ))}
      </section>
      <section className="sidebar-section team-section">
        <h2>Team</h2>
        <button
          type="button"
          className="team-model-all"
          aria-label="Configure all Agent models"
          onClick={() => onConfigureModel('all')}
        >
          Set model for all Agents
        </button>
        <ul className="team-list">
          {model.team.map((member) => (
            <TeamRow key={member.role} member={member} onConfigure={onConfigureModel} />
          ))}
        </ul>
      </section>
    </aside>
  );
}

function displayMessageFromUnknown(value: unknown): ChatMessageView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.msgId !== 'string' ||
    typeof record.fromRole !== 'string' ||
    typeof record.display !== 'string' ||
    typeof record.ts !== 'number'
  ) {
    return undefined;
  }
  return {
    msgId: record.msgId,
    fromRole: record.fromRole,
    display: record.display,
    ts: record.ts,
  };
}

function parseDisplayMessage(data: string): ChatMessageView | undefined {
  try {
    return displayMessageFromUnknown(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function parseDisplayMessages(data: string): ChatMessageView[] | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (!Array.isArray(value)) return undefined;
    const messages = value.map(displayMessageFromUnknown);
    if (messages.some((message) => message === undefined)) return undefined;
    return messages as ChatMessageView[];
  } catch {
    return undefined;
  }
}

function MessageRow({
  message,
  status,
  children,
}: {
  message: ChatMessageView;
  status?: PresenceStatus | undefined;
  children?: ReactNode;
}) {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  }).format(message.ts);

  return (
    <article className="message-row" data-role={message.fromRole}>
      <div className="message-marker">
        <RoleAvatar role={message.fromRole} status={status} />
        <span className="timeline-dot" />
      </div>
      <div className="message-body">
        <header>
          <strong>{roleLabels[message.fromRole] ?? message.fromRole}</strong>
          <time dateTime={new Date(message.ts).toISOString()}>{time}</time>
        </header>
        <MessageContent role={message.fromRole} display={message.display} />
        {children}
        {message.reference ? <code>{message.reference}</code> : null}
      </div>
    </article>
  );
}

function MessageList({
  messages,
  team,
  proposal,
  busy,
  onRespond,
}: {
  messages: ChatMessageView[];
  team: TeamMemberView[];
  proposal: TaskRuntimeView['requirementProposal'];
  busy: boolean;
  onRespond: (action: 'confirm' | 'dismiss') => void;
}) {
  const statuses = new Map(team.map((member) => [member.role, member.status]));
  const ordered = useMemo(() => sortMessagesByTimestamp(messages), [messages]);
  const messageIds = useMemo(() => ordered.map((message) => message.msgId), [ordered]);

  return (
    <ChatHistory messageIds={messageIds}>
      {ordered.map((message) => (
        <MessageRow key={message.msgId} message={message} status={statuses.get(message.fromRole)}>
          {proposal?.proposalId === message.msgId ? (
            <RequirementProposalCard proposal={proposal} busy={busy} onRespond={onRespond} />
          ) : null}
        </MessageRow>
      ))}
    </ChatHistory>
  );
}

function elapsed(startedAt: number, endedAt: number | undefined): string {
  if (endedAt === undefined) return 'running';
  const milliseconds = Math.max(0, endedAt - startedAt);
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

export function TracePanel({
  trace,
  error,
}: {
  trace?: TraceSnapshotView | undefined;
  error?: string | undefined;
}) {
  const timeline = trace === undefined ? undefined : traceLanes(trace, Date.now());
  return (
    <section className="trace-panel" aria-label="Trace">
      <div className="trace-heading">
        <h2>Trace</h2>
        {trace ? <small>{trace.sessions.length} sessions</small> : null}
      </div>
      {timeline !== undefined && timeline.lanes.length > 0 ? (
        <section className="trace-timeline" aria-label="Worker session timeline">
          <div className="trace-time-axis">
            <span>0s</span>
            <span>
              {elapsed(timeline.start, timeline.end)}
              {timeline.running ? ' · live' : ''}
            </span>
          </div>
          {timeline.lanes.map((lane) => (
            <div
              className="trace-lane"
              key={lane.rootSessionId}
              data-root-session={lane.rootSessionId}
            >
              <div className="trace-lane-label">
                <strong>{lane.role}</strong>
                <code title={lane.rootSessionId}>{lane.rootSessionId.slice(-8)}</code>
                {lane.parentOmitted ? <small>parent omitted</small> : null}
              </div>
              <div
                className="trace-lane-track"
                role="img"
                aria-label={`${lane.role} ${lane.rootSessionId}`}
              >
                {lane.sessions.flatMap((session) =>
                  session.turns.map((turn) => {
                    const left =
                      (100 * (turn.startedAt - timeline.start)) / (timeline.end - timeline.start);
                    const width =
                      (100 * ((turn.endedAt ?? timeline.end) - turn.startedAt)) /
                      (timeline.end - timeline.start);
                    const label = `${session.parentSessionId ? 'Fork · ' : ''}Turn ${turn.turn} · ${turn.status} · ${elapsed(turn.startedAt, turn.endedAt)}`;
                    return (
                      <span
                        key={`${session.sessionId}:${turn.turn}`}
                        className="trace-span"
                        data-status={turn.status}
                        style={{ left: `${left}%`, width: `${Math.max(0, width)}%` }}
                        title={label}
                      >
                        {session.parentSessionId ? (
                          <span className="trace-fork-mark" aria-hidden="true">
                            ↳
                          </span>
                        ) : null}
                        {turn.steps.map((step) => (
                          <span
                            key={step.step}
                            className="trace-step-span"
                            data-status={step.status}
                            style={{
                              left: `${(100 * (step.startedAt - turn.startedAt)) / Math.max(1, (turn.endedAt ?? timeline.end) - turn.startedAt)}%`,
                              width: `${(100 * ((step.endedAt ?? turn.endedAt ?? timeline.end) - step.startedAt)) / Math.max(1, (turn.endedAt ?? timeline.end) - turn.startedAt)}%`,
                            }}
                            title={`Step ${step.step} · ${step.status} · ${elapsed(step.startedAt, step.endedAt)}`}
                          />
                        ))}
                      </span>
                    );
                  }),
                )}
              </div>
            </div>
          ))}
          <p className="trace-timeline-legend">Each lane follows one session lineage. ↳ Fork</p>
        </section>
      ) : null}
      {error ? (
        <p className="trace-error" role="alert">
          {error}
        </p>
      ) : trace === undefined ? (
        <p className="trace-empty">Trace has not loaded yet.</p>
      ) : trace.sessions.length === 0 ? (
        <p className="trace-empty">No persisted steps yet.</p>
      ) : (
        <div className="trace-sessions">
          {trace.sessions.map((session) => (
            <details className="trace-session" key={session.sessionId} open>
              <summary>
                <span className="trace-role">{session.role}</span>
                <code title={session.sessionId}>{session.sessionId.slice(-8)}</code>
              </summary>
              {session.parentSessionId ? (
                <p className="trace-lineage">
                  Fork · resumed from{' '}
                  <code title={session.parentSessionId}>{session.parentSessionId.slice(-8)}</code>
                </p>
              ) : null}
              <ol className="trace-turns">
                {session.turns.map((turn) => (
                  <li key={turn.turn} className={`trace-turn trace-${turn.status}`}>
                    <div className="trace-row">
                      <strong>Turn {turn.turn}</strong>
                      <span>{turn.status.replace('_', ' ')}</span>
                    </div>
                    <ol className="trace-steps">
                      {turn.steps.map((step) => (
                        <li key={step.step}>
                          <div className="trace-row">
                            <span>Step {step.step}</span>
                            <small>
                              {step.status} · {elapsed(step.startedAt, step.endedAt)}
                            </small>
                          </div>
                          {step.retries && step.retries.length > 0 ? (
                            <ul className="trace-tools" aria-label="Request recovery">
                              {step.retries.map((retry) => (
                                <li
                                  key={`${retry.retryId}:${retry.retry}`}
                                  data-status={retry.status}
                                >
                                  <span>
                                    Retry {retry.retry}/{retry.maxRetries}
                                  </span>
                                  <small>
                                    {retry.status === 'waiting'
                                      ? 'Waiting to retry'
                                      : retry.status === 'backoff_completed'
                                        ? 'Backoff completed'
                                        : 'Closed without retry start'}
                                    {` · ${Math.round(retry.delayMs)} ms · ${retry.errorCode}`}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {step.tools.length > 0 ? (
                            <ul className="trace-tools">
                              {step.tools.map((tool) => (
                                <li key={tool.callId} data-status={tool.status}>
                                  <code>{tool.name}</code>
                                  <small>
                                    {tool.status}
                                    {tool.errorCode ? ` · ${tool.errorCode}` : ''}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      )}
      {trace && trace.omittedEventCount > 0 ? (
        <p className="trace-omitted">{trace.omittedEventCount} older trace events omitted</p>
      ) : null}
    </section>
  );
}

function TaskOverview({ task }: { task: WorkspaceViewModel['task'] }) {
  return (
    <section className="task-summary">
      <h2>Current task</h2>
      <div className="task-identity">
        <p className="task-id">{task.id}</p>
        <span className="task-status">{task.status}</span>
      </div>
      <h3 className="task-goal-label">Goal</h3>
      <details className="task-goal">
        <summary>
          <span className="task-goal-preview">{task.title}</span>
          <span className="task-goal-toggle">
            <span className="task-goal-expand">View full goal</span>
            <span className="task-goal-collapse">Collapse goal</span>
          </span>
        </summary>
        <div className="task-goal-full">
          <MessageMarkdown text={task.title} />
        </div>
      </details>
    </section>
  );
}

function RightSidebar({
  model,
  open,
  task,
  trace,
  traceError,
}: {
  model: WorkspaceViewModel;
  open: boolean;
  task?: TaskRuntimeView | undefined;
  trace?: TraceSnapshotView | undefined;
  traceError?: string | undefined;
}) {
  return (
    <aside className="right-sidebar" data-open={open} aria-label="Task status">
      <TaskOverview key={model.task.id} task={model.task} />
      <section className="task-progress">
        <h2>Progress</h2>
        <ol>
          <li className={task ? 'progress-done' : 'progress-active'}>Create task</li>
          <li
            className={
              task?.runStatus === 'completed'
                ? 'progress-done'
                : task?.runStatus === 'running'
                  ? 'progress-active'
                  : undefined
            }
          >
            Run six-role orchestration
          </li>
          <li className={task?.testResults?.passed ? 'progress-done' : undefined}>Pass tests</li>
          <li className={task?.runStatus === 'completed' ? 'progress-done' : undefined}>
            Produce artifact
          </li>
        </ol>
      </section>
      <section className="active-workers">
        <h2>Active workers</h2>
        <ul>
          {model.activeWorkers.map((worker) => (
            <li key={worker.role}>
              <RoleAvatar role={worker.role} status="active" />
              <span>
                <strong>{worker.name}</strong>
                <small>{worker.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {task?.artifactPath ? (
        <section className="artifact-summary">
          <h2>Artifact</h2>
          <code>{task.artifactPath}</code>
        </section>
      ) : null}
      <TracePanel trace={trace} error={traceError} />
    </aside>
  );
}

function TaskLauncher({
  taskId,
  goal,
  pending,
  task,
  error,
  onTaskIdChange,
  onGoalChange,
  onStart,
}: {
  taskId: string;
  goal: string;
  pending: boolean;
  task?: TaskRuntimeView | undefined;
  error?: string | undefined;
  onTaskIdChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onStart: () => void;
}) {
  return (
    <section className="task-launcher" aria-label="Task runner">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <label>
          <span>Task ID</span>
          <input value={taskId} onChange={(event) => onTaskIdChange(event.target.value)} />
        </label>
        <label className="goal-field">
          <span>Goal</span>
          <input value={goal} onChange={(event) => onGoalChange(event.target.value)} />
        </label>
        <button disabled={pending || taskId.trim() === '' || goal.trim() === ''} type="submit">
          {pending ? 'Starting…' : task?.runStatus === 'running' ? 'Running' : 'Start task'}
        </button>
      </form>
      <div className="runtime-strip" role="status">
        <span data-status={task?.runStatus ?? 'not-started'}>
          {task?.runStatus.replace('_', ' ') ?? 'not started'}
        </span>
        <span>Phase: {task?.phase ?? '—'}</span>
        <span>Worker: {task?.currentRole ?? '—'}</span>
        {task?.testResults ? (
          <span>
            Tests: {task.testResults.passed ? 'passed' : 'failed'} ({task.testResults.total})
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="task-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface ComposerProps {
  draft: string;
  mentionOptions: string[];
  onDraftChange: (value: string) => void;
  onMention: (role: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitting?: boolean;
}

function Composer({
  draft,
  mentionOptions,
  onDraftChange,
  onMention,
  onSubmit,
  disabled = false,
  submitting = false,
}: ComposerProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && mentionOptions.length === 0) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {mentionOptions.length > 0 ? (
        <div className="mention-menu" role="listbox" aria-label="Mention a role">
          {mentionOptions.slice(0, 3).map((role) => (
            <button key={role} type="button" role="option" onClick={() => onMention(role)}>
              <RoleAvatar role={role} />
              <span>
                <strong>{role}</strong>
                <small>@{role.toLowerCase()}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <label className="composer-field">
        <span className="sr-only">Message the team</span>
        <span className="composer-at" aria-hidden="true">
          @
        </span>
        <textarea
          aria-label="Message the team"
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the team or @mention a role…"
          rows={1}
          value={draft}
        />
        <span className="composer-hint">Shift + Enter for new line</span>
      </label>
      <button
        className="send-button"
        disabled={disabled || submitting || draft.trim().length === 0}
        aria-busy={submitting}
        type="submit"
      >
        {submitting ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

export function ChatWorkspace({
  model = DEFAULT_WORKSPACE,
  projectId = 'agora',
}: ChatWorkspaceProps) {
  const [messages, setMessages] = useState(model.messages);
  const [modelSettingsTarget, setModelSettingsTarget] = useState<string>();
  const [channels, setChannels] = useState<ChannelView[]>(
    model.channels ?? [{ ...model.channel, kind: 'main', closed: false }],
  );
  const [selectedChannelId, setSelectedChannelId] = useState(model.channel.id);
  const [channelRefreshNonce, setChannelRefreshNonce] = useState(0);
  const [taskId, setTaskId] = useState(model.task.id);
  const [goal, setGoal] = useState(model.task.title);
  const [task, setTask] = useState<TaskRuntimeView>();
  const [trace, setTrace] = useState<TraceSnapshotView>();
  const [traceError, setTraceError] = useState<string>();
  const [taskError, setTaskError] = useState<string>();
  const [taskPending, startTaskTransition] = useTransition();
  const [draft, setDraft] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'connecting' | 'live' | 'offline'
  >('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string>();
  const [channelRefreshError, setChannelRefreshError] = useState<string>();
  const [submissionNotice, setSubmissionNotice] = useState<LeaderActionNotice>();
  const pendingSubmission = React.useRef<PendingMessageSubmission | undefined>(undefined);
  const pendingProposalSubmission = React.useRef<{ key: string; msgId: string } | undefined>(
    undefined,
  );
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const mentionQuery = getMentionQuery(draft);
  const mentionOptions = useMemo(
    () => (mentionQuery === undefined ? [] : filterMentionOptions(mentionQuery)),
    [mentionQuery],
  );

  const runtimeModel = useMemo<WorkspaceViewModel>(() => {
    const currentRole = task?.runStatus === 'running' ? task.currentRole : null;
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ??
      channels[0] ?? {
        ...model.channel,
        kind: 'main' as const,
        closed: false,
      };
    return {
      ...model,
      channel: { id: selectedChannel.id, name: selectedChannel.name },
      channels,
      task: {
        id: taskId,
        title: goal,
        status: task?.runStatus.replace('_', ' ') ?? 'Not started',
      },
      team: model.team.map((member) => ({
        ...member,
        status:
          member.role === currentRole
            ? 'active'
            : member.status === 'active'
              ? 'online'
              : member.status,
      })),
      activeWorkers:
        currentRole === null
          ? []
          : [
              {
                role: currentRole,
                name: roleLabels[currentRole] ?? currentRole,
                detail: `Executing ${task?.phase ?? 'task'} stage`,
              },
            ],
      messages: [],
    };
  }, [channels, goal, model, selectedChannelId, task, taskId]);

  useEffect(() => {
    let active = true;
    const search = new URLSearchParams({ projectId, taskId });
    void fetch(`/api/tasks?${search.toString()}`)
      .then(async (response) => {
        if (!active || response.status === 404) return;
        if (!response.ok) throw new Error(`Task recovery failed (${response.status})`);
        const recovered = (await response.json()) as TaskRuntimeView;
        if (active) {
          setTask(recovered);
          setGoal(recovered.goal);
        }
      })
      .catch((error: unknown) => {
        if (active) setTaskError(error instanceof Error ? error.message : 'Task recovery failed');
      });
    return () => {
      active = false;
    };
  }, [projectId, taskId]);

  useEffect(() => {
    if (task === undefined) return;
    setConnectionStatus('connecting');
    const search = new URLSearchParams({
      projectId,
      taskId,
      channelId: runtimeModel.channel.id,
    });
    const source = new EventSource(`/api/stream?${search.toString()}`);

    const handleConnected = () => setConnectionStatus('live');
    const handleSnapshot = (event: MessageEvent<string>) => {
      const snapshot = parseDisplayMessages(event.data);
      if (snapshot !== undefined) setMessages(snapshot);
    };
    const handleMessage = (event: MessageEvent<string>) => {
      const message = parseDisplayMessage(event.data);
      if (message !== undefined) {
        setMessages((current) => mergeMessageById(current, message));
      }
    };

    source.addEventListener('connected', handleConnected);
    source.addEventListener('snapshot', handleSnapshot as EventListener);
    source.addEventListener('message', handleMessage as EventListener);
    source.onerror = () => setConnectionStatus('offline');

    return () => source.close();
  }, [projectId, runtimeModel.channel.id, taskId, task !== undefined]);

  useEffect(() => {
    if (task === undefined) return;
    let active = true;
    const refresh = async () => {
      try {
        const search = new URLSearchParams({ projectId, taskId });
        const refreshed = await fetchChannelRegistry(`/api/channels?${search.toString()}`);
        if (active) {
          setChannels(refreshed);
          setChannelRefreshError(undefined);
        }
      } catch (error) {
        if (active) {
          setChannelRefreshError(error instanceof Error ? error.message : 'Channel refresh failed');
        }
      }
    };
    void refresh();
    const timer =
      task.runStatus === 'running' ? setInterval(() => void refresh(), 2000) : undefined;
    return () => {
      active = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [channelRefreshNonce, projectId, task?.runStatus, taskId]);

  useEffect(() => {
    if (task === undefined) return;
    let active = true;
    const refresh = async () => {
      try {
        const search = new URLSearchParams({ projectId, taskId });
        const refreshed = await fetchTaskRuntime(`/api/tasks?${search.toString()}`);
        if (active) {
          setTask(refreshed);
          setTaskError(undefined);
        }
      } catch (error) {
        if (active) {
          setTaskError(error instanceof Error ? error.message : 'Task refresh failed');
        }
      }
    };
    void refresh();
    const timer =
      task.runStatus === 'running' ? setInterval(() => void refresh(), 1000) : undefined;
    return () => {
      active = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [channelRefreshNonce, projectId, task?.runStatus, taskId]);

  useEffect(() => {
    if (task === undefined) return;
    let active = true;
    let refreshing = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const search = new URLSearchParams({ projectId, taskId });
        const refreshed = await fetchTraceSnapshot(
          `/api/traces?${search.toString()}`,
          (input, init) => fetch(input, { ...init, signal: controller.signal }),
        );
        if (active) {
          setTrace(refreshed);
          setTraceError(undefined);
        }
      } catch (error) {
        if (active) {
          setTraceError(error instanceof Error ? error.message : 'Trace refresh failed');
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer =
      task.runStatus === 'running' ? setInterval(() => void refresh(), 1000) : undefined;
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [projectId, task?.runStatus, taskId]);

  function changeTaskId(value: string) {
    setTaskId(value);
    setTask(undefined);
    setTrace(undefined);
    setTraceError(undefined);
    setTaskError(undefined);
    setMessages([]);
    setChannels([{ id: 'main', name: 'main', kind: 'main', closed: false }]);
    setSelectedChannelId('main');
  }

  function startTask() {
    const normalizedTaskId = taskId.trim();
    const normalizedGoal = goal.trim();
    if (normalizedTaskId === '' || normalizedGoal === '' || taskPending) return;
    setTaskError(undefined);
    startTaskTransition(async () => {
      try {
        const response = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            taskId: normalizedTaskId,
            requestId: crypto.randomUUID(),
            goal: normalizedGoal,
          }),
        });
        const body = (await response.json()) as TaskRuntimeView & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Task start failed (${response.status})`);
        setTask(body);
        setChannelRefreshNonce((current) => current + 1);
      } catch (error) {
        setTaskError(error instanceof Error ? error.message : 'Task start failed');
      }
    });
  }

  function selectMention(role: string) {
    setDraft((current) => `${applyMention(current, role)} `);
  }

  async function sendMessage() {
    const display = draft.trim();
    if (display.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setSubmissionError(undefined);
    setSubmissionNotice(undefined);
    const submission = prepareMessageSubmission(pendingSubmission.current, display, () =>
      crypto.randomUUID(),
    );
    pendingSubmission.current = submission;
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          taskId,
          channelId: runtimeModel.channel.id,
          msgId: submission.msgId,
          display,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? `Message submission failed (${response.status})`);
      setSubmissionNotice(leaderActionNoticeFromResponse(body));
      setChannelRefreshNonce((current) => current + 1);
      if (pendingSubmission.current?.msgId === submission.msgId) {
        pendingSubmission.current = undefined;
      }
      setDraft((current) => (current.trim() === display ? '' : current));
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : 'Message submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function respondToProposal(action: 'confirm' | 'dismiss') {
    const proposal = task?.requirementProposal;
    if (!proposal || submitting) return;
    const key = JSON.stringify([projectId, taskId, proposal.proposalId, action]);
    const submission =
      pendingProposalSubmission.current?.key === key
        ? pendingProposalSubmission.current
        : { key, msgId: crypto.randomUUID() };
    pendingProposalSubmission.current = submission;
    setSubmitting(true);
    setSubmissionError(undefined);
    setSubmissionNotice(undefined);
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          taskId,
          channelId: 'main',
          msgId: submission.msgId,
          display:
            action === 'confirm'
              ? 'Confirm these requirement changes.'
              : 'Discard this change proposal.',
          requirementProposal: { proposalId: proposal.proposalId, action },
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? `Proposal submission failed (${response.status})`);
      if (pendingProposalSubmission.current?.msgId === submission.msgId)
        pendingProposalSubmission.current = undefined;
      setSubmissionNotice({
        kind: 'applied',
        text:
          action === 'confirm'
            ? 'Requirement changes applied.'
            : 'Proposal discarded. Requirements are unchanged.',
      });
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : 'Proposal submission failed');
    } finally {
      setChannelRefreshNonce((current) => current + 1);
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="mobile-control"
          type="button"
          aria-label="Open workspace navigation"
          aria-expanded={leftOpen}
          onClick={() => {
            setRightOpen(false);
            setLeftOpen((current) => !current);
          }}
        >
          <MenuIcon />
        </button>
        <div className="brand">
          <TerminalMark />
          <span>Agora</span>
        </div>
        <div className="channel-title">
          <span aria-hidden="true">#</span>
          {runtimeModel.channel.name}
        </div>
        <div className="preview-status">
          <span />
          {connectionStatus === 'live'
            ? 'Live'
            : connectionStatus === 'offline'
              ? 'Offline'
              : connectionStatus === 'connecting'
                ? 'Connecting'
                : 'Idle'}
        </div>
        <button
          className="icon-control"
          type="button"
          aria-label="Open task status"
          aria-expanded={rightOpen}
          onClick={() => {
            setLeftOpen(false);
            setRightOpen((current) => !current);
          }}
        >
          <MoreIcon />
        </button>
      </header>

      <LeftSidebar
        onConfigureModel={setModelSettingsTarget}
        model={runtimeModel}
        channels={channels}
        selectedChannelId={runtimeModel.channel.id}
        open={leftOpen}
        onSelectChannel={(channelId) => {
          setSelectedChannelId(channelId);
          setMessages([]);
          setLeftOpen(false);
        }}
      />
      {modelSettingsTarget !== undefined ? (
        <ModelSettingsDialog
          projectId={projectId}
          initialTarget={modelSettingsTarget}
          onClose={() => setModelSettingsTarget(undefined)}
        />
      ) : null}
      <section className="chat-column">
        <div className="mobile-context">
          <TerminalMark />
          <span>
            {runtimeModel.task.id} {runtimeModel.task.title} · {runtimeModel.task.status} ·{' '}
            {runtimeModel.activeWorkers.length} active
          </span>
        </div>
        <TaskLauncher
          taskId={taskId}
          goal={goal}
          pending={taskPending}
          task={task}
          error={taskError ?? task?.error}
          onTaskIdChange={changeTaskId}
          onGoalChange={setGoal}
          onStart={startTask}
        />
        <MessageList
          key={JSON.stringify([projectId, taskId, runtimeModel.channel.id])}
          messages={messages}
          team={runtimeModel.team}
          proposal={task?.requirementProposal}
          busy={submitting}
          onRespond={respondToProposal}
        />
        <Composer
          draft={draft}
          submitting={submitting}
          mentionOptions={mentionOptions}
          onDraftChange={setDraft}
          onMention={selectMention}
          onSubmit={sendMessage}
          disabled={
            task === undefined ||
            channels.find((channel) => channel.id === runtimeModel.channel.id)?.closed === true
          }
        />
        {submissionError ? (
          <p className="submission-error" role="alert">
            {submissionError}
          </p>
        ) : null}
        {channelRefreshError ? (
          <p className="submission-error" role="alert">
            {channelRefreshError}
          </p>
        ) : null}
        {submissionNotice ? (
          <p
            className={`submission-notice submission-notice-${submissionNotice.kind}`}
            role="status"
          >
            {submissionNotice.text}
          </p>
        ) : null}
      </section>
      <RightSidebar
        model={runtimeModel}
        open={rightOpen}
        task={task}
        trace={trace}
        traceError={traceError}
      />

      {leftOpen || rightOpen ? (
        <button
          className="mobile-backdrop"
          type="button"
          aria-label="Close sidebar"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}
