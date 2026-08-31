'use client';

import * as React from 'react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  applyMention,
  type ChatMessageView,
  DEFAULT_WORKSPACE,
  filterMentionOptions,
  getMentionQuery,
  mergeMessageById,
  type PendingMessageSubmission,
  type PresenceStatus,
  prepareMessageSubmission,
  sortMessagesByTimestamp,
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

function RightSidebar({ model, open }: { model: WorkspaceViewModel; open: boolean }) {
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
          <li className="progress-done">Define message model</li>
          <li className="progress-active">Build accessible UI components</li>
          <li>Verify responsive states</li>
          <li>Run quality gates</li>
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
    </aside>
  );
}

interface ComposerProps {
  draft: string;
  mentionOptions: string[];
  onDraftChange: (value: string) => void;
  onMention: (role: string) => void;
  onSubmit: () => void;
}

function Composer({ draft, mentionOptions, onDraftChange, onMention, onSubmit }: ComposerProps) {
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
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the team or @mention a role…"
          rows={1}
          value={draft}
        />
        <span className="composer-hint">Shift + Enter for new line</span>
      </label>
      <button className="send-button" disabled={draft.trim().length === 0} type="submit">
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
  const [draft, setDraft] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'live' | 'offline'>(
    'connecting',
  );
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string>();
  const pendingSubmission = React.useRef<PendingMessageSubmission | undefined>(undefined);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const mentionQuery = getMentionQuery(draft);
  const mentionOptions = useMemo(
    () => (mentionQuery === undefined ? [] : filterMentionOptions(mentionQuery)),
    [mentionQuery],
  );

  useEffect(() => {
    const search = new URLSearchParams({
      projectId,
      taskId: model.task.id,
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
  }, [model.channel.id, model.task.id, projectId]);

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
          taskId: model.task.id,
          channelId: model.channel.id,
          msgId: submission.msgId,
          display,
          payload: { intent: 'chat', text: display },
        }),
      });
      if (!response.ok) throw new Error(`Message submission failed (${response.status})`);
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
          {model.channel.name}
        </div>
        <div className="preview-status">
          <span />
          {connectionStatus === 'live'
            ? 'Live'
            : connectionStatus === 'offline'
              ? 'Offline'
              : 'Connecting'}
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

      <LeftSidebar model={model} open={leftOpen} />
      <section className="chat-column">
        <div className="mobile-context">
          <TerminalMark />
          <span>
            {model.task.id} {model.task.title} · {model.task.status} · {model.activeWorkers.length}{' '}
            active
          </span>
        </div>
        <MessageList messages={messages} team={model.team} />
        <Composer
          draft={draft}
          mentionOptions={mentionOptions}
          onDraftChange={setDraft}
          onMention={selectMention}
          onSubmit={sendMessage}
        />
        {submissionError ? (
          <p className="submission-error" role="alert">
            {submissionError}
          </p>
        ) : null}
      </section>
      <RightSidebar model={model} open={rightOpen} />

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
