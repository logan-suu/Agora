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

import {
  applyMention,
  type ChatMessageView,
  DEFAULT_WORKSPACE,
  fetchTaskRuntime,
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
  type WorkspaceViewModel,
} from './chat-model';

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

function TeamRow({ member }: { member: TeamMemberView }) {
  return (
    <li className="team-row">
      <RoleAvatar role={member.role} status={member.status} />
      <span>
        <strong>{member.name}</strong>
        <small>{member.status}</small>
      </span>
    </li>
  );
}

function LeftSidebar({ model, open }: { model: WorkspaceViewModel; open: boolean }) {
  return (
    <aside className="left-sidebar" data-open={open} aria-label="Workspace navigation">
      <section className="sidebar-section">
        <h2>Channels</h2>
        <button className="channel-row channel-row-selected" type="button">
          <span aria-hidden="true">#</span>
          {model.channel.name}
        </button>
      </section>
      <section className="sidebar-section team-section">
        <h2>Team</h2>
        <ul className="team-list">
          {model.team.map((member) => (
            <TeamRow key={member.role} member={member} />
          ))}
        </ul>
      </section>
    </aside>
  );
}

function displayWithMentions(display: string): ReactNode[] {
  return React.Children.toArray(
    display.split(/(@[A-Z]+)/g).map((part, index) =>
      part.startsWith('@') ? (
        <span className="mention" key={`${part}-${index}`}>
          {part}
        </span>
      ) : (
        part
      ),
    ),
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
}: {
  message: ChatMessageView;
  status?: PresenceStatus | undefined;
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
        <p>{displayWithMentions(message.display)}</p>
        {message.reference ? <code>{message.reference}</code> : null}
      </div>
    </article>
  );
}

function MessageList({ messages, team }: { messages: ChatMessageView[]; team: TeamMemberView[] }) {
  const statuses = new Map(team.map((member) => [member.role, member.status]));

  return (
    <section className="message-list" aria-label="Messages" aria-live="polite">
      {sortMessagesByTimestamp(messages).map((message) => (
        <MessageRow key={message.msgId} message={message} status={statuses.get(message.fromRole)} />
      ))}
    </section>
  );
}

function RightSidebar({
  model,
  open,
  task,
}: {
  model: WorkspaceViewModel;
  open: boolean;
  task?: TaskRuntimeView | undefined;
}) {
  return (
    <aside className="right-sidebar" data-open={open} aria-label="Task status">
      <section className="task-summary">
        <h2>Current task</h2>
        <p className="task-title">
          <span>{model.task.id}</span> {model.task.title}
        </p>
        <span className="task-status">{model.task.status}</span>
      </section>
      <section className="task-progress">
        <h2>Progress</h2>
        <ol>
          <li className={task ? 'progress-done' : 'progress-active'}>Create task</li>
          <li className={task?.runStatus === 'running' ? 'progress-active' : undefined}>
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
}

function Composer({
  draft,
  mentionOptions,
  onDraftChange,
  onMention,
  onSubmit,
  disabled = false,
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
        disabled={disabled || draft.trim().length === 0}
        type="submit"
      >
        Send
      </button>
    </form>
  );
}

export function ChatWorkspace({
  model = DEFAULT_WORKSPACE,
  projectId = 'agora',
}: ChatWorkspaceProps) {
  const [messages, setMessages] = useState(model.messages);
  const [taskId, setTaskId] = useState(model.task.id);
  const [goal, setGoal] = useState(model.task.title);
  const [task, setTask] = useState<TaskRuntimeView>();
  const [taskError, setTaskError] = useState<string>();
  const [taskPending, startTaskTransition] = useTransition();
  const [draft, setDraft] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'connecting' | 'live' | 'offline'
  >('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string>();
  const [submissionNotice, setSubmissionNotice] = useState<LeaderActionNotice>();
  const pendingSubmission = React.useRef<PendingMessageSubmission | undefined>(undefined);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const mentionQuery = getMentionQuery(draft);
  const mentionOptions = useMemo(
    () => (mentionQuery === undefined ? [] : filterMentionOptions(mentionQuery)),
    [mentionQuery],
  );

  const runtimeModel = useMemo<WorkspaceViewModel>(() => {
    const currentRole = task?.runStatus === 'running' ? task.currentRole : null;
    return {
      ...model,
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
  }, [goal, model, task, taskId]);

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
      channelId: model.channel.id,
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
  }, [model.channel.id, projectId, taskId, task !== undefined]);

  useEffect(() => {
    if (task?.runStatus !== 'running') return;
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
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, task?.runStatus, taskId]);

  function changeTaskId(value: string) {
    setTaskId(value);
    setTask(undefined);
    setTaskError(undefined);
    setMessages([]);
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
          channelId: model.channel.id,
          msgId: submission.msgId,
          display,
        }),
      });
      if (!response.ok) throw new Error(`Message submission failed (${response.status})`);
      setSubmissionNotice(leaderActionNoticeFromResponse(await response.json()));
      if (pendingSubmission.current?.msgId === submission.msgId) {
        pendingSubmission.current = undefined;
      }
      setDraft('');
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : 'Message submission failed');
    } finally {
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

      <LeftSidebar model={runtimeModel} open={leftOpen} />
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
          error={taskError}
          onTaskIdChange={changeTaskId}
          onGoalChange={setGoal}
          onStart={startTask}
        />
        <MessageList messages={messages} team={runtimeModel.team} />
        <Composer
          draft={draft}
          mentionOptions={mentionOptions}
          onDraftChange={setDraft}
          onMention={selectMention}
          onSubmit={sendMessage}
          disabled={task === undefined}
        />
        {submissionError ? (
          <p className="submission-error" role="alert">
            {submissionError}
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
      <RightSidebar model={runtimeModel} open={rightOpen} task={task} />

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
