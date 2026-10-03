'use client';

import { useEffect, useState } from 'react';
import type { ModelSettingsView } from '../../lib/model-settings';
import type { TeamMemberView } from '../chat-model';
import { ChatWorkspace } from '../chat-workspace';
import { type ModelDraft, ModelSettingsDialog } from '../model-settings-dialog';

type Scope = { projectId: string; taskId: string };
type Entry = Scope & {
  operationId: string;
  selectionRef: string;
  path: string;
  goal: string;
  readOnly?: boolean;
};
type Proposal = {
  entry: Entry;
  grant: Scope & {
    actionId: string;
    expectedRevision: number;
    selectionRef: string;
    policyProposalId: string;
    inputHash: string;
  };
  policy: { actions: string[] };
};
type Inspection = {
  inspectionRef: string;
  baselineFiles: number;
  files: { name: string; kind: string }[];
  truncated: boolean;
  scripts: Record<string, string>;
  readme?: { name: string; text: string };
  limitations: string[];
};
async function command(body: object) {
  const response = await fetch('/api/desktop/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(
      data.error === 'workspace_inspection_stale'
        ? 'Your files changed since the preview. Refresh file inspection before starting work.'
        : (data.error ?? 'Unable to complete this step.'),
    );
  return data;
}
export function DesktopFirstRun({ draining }: { draining: boolean }) {
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [scope, setScope] = useState<Scope>();
  const [selection, setSelection] = useState<{ selectionRef: string; path: string }>();
  const [goal, setGoal] = useState('');
  const [proposal, setProposal] = useState<Proposal>();
  const [inspection, setInspection] = useState<Inspection>();
  const [saved, setSaved] = useState<Entry[]>([]);
  const [models, setModels] = useState(false);
  const [modelDraft, setModelDraft] = useState<ModelDraft>();
  const [chat, setChat] = useState<Scope & { goal: string; readOnly?: boolean }>();
  const [team, setTeam] = useState<TeamMemberView[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/desktop/entry', { signal: abort.signal, cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        setSaved(data.projects);
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load projects.');
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    setTeam([]);
    if (!chat) return;
    const abort = new AbortController();
    fetch(`/api/model-settings?projectId=${encodeURIComponent(chat.projectId)}`, {
      signal: abort.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Unable to load project members.');
        const settings: ModelSettingsView = await response.json();
        setTeam(
          settings.roles.map(({ role, status }) => ({
            role,
            name: role === 'PM' ? role : role[0] + role.slice(1).toLowerCase(),
            status: status === 'enabled' ? 'online' : 'offline',
          })),
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load project members.');
      });
    return () => abort.abort();
  }, [chat]);
  async function work(fn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setPending(false);
    }
  }
  async function choose() {
    const next = (await command({ action: 'scope', operationId })) as Scope;
    const desktop = (
      window as typeof window & {
        agoraDesktop?: {
          selectDirectory(
            input: Scope & { actionId: string },
          ): Promise<{ selectionRef: string; path: string } | null>;
        };
      }
    ).agoraDesktop;
    if (!desktop) throw Error('Open Agora on this Mac to select a folder.');
    const selected = await desktop.selectDirectory({ ...next, actionId: operationId });
    if (!selected) return;
    await command({ action: 'selection', operationId, selectionRef: selected.selectionRef });
    setScope(next);
    setSelection(selected);
  }
  async function approve() {
    if (!proposal) return;
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: proposal.entry.projectId,
        taskId: proposal.entry.taskId,
        channelId: 'main',
        msgId: proposal.grant.actionId,
        display: `/workspace grant ${JSON.stringify(proposal.grant)}`,
      }),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? 'Authorization failed.');
    setInspection(await command({ action: 'inspect', projectId: proposal.entry.projectId }));
  }
  if (chat)
    return (
      <div className="desktop-workspace">
        <div className="desktop-run-banner">
          <button
            type="button"
            onClick={() => {
              setChat(undefined);
              setScope(undefined);
              setSelection(undefined);
              setProposal(undefined);
              setInspection(undefined);
              setGoal('');
              setModelDraft(undefined);
              setOperationId(crypto.randomUUID());
            }}
          >
            Back to projects
          </button>
          <span>
            {draining
              ? chat.readOnly
                ? 'Waiting for active work to finish. This saved task remains read-only.'
                : 'Waiting for active work to finish. Decisions can be saved; execution will not resume while quitting.'
              : 'Local acceptance preview · your selected workspace'}
          </span>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <ChatWorkspace
          key={chat.taskId}
          projectId={chat.projectId}
          readOnly={chat.readOnly === true}
          model={{
            task: { id: chat.taskId, title: chat.goal, status: 'Loading' },
            channel: { id: 'main', name: 'main' },
            team,
            activeWorkers: [],
            messages: [],
          }}
        />
      </div>
    );
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <p className="desktop-eyebrow">LOCAL ACCEPTANCE PREVIEW</p>
      <h1 id="first-run-title">Start with your project.</h1>
      <p>
        Choose a folder within the approved preview area. New folders can be created in the system
        dialog. Your files are read only after you approve access.
      </p>
      {draining ? (
        <p role="status">Agora is waiting for active work to finish before stopping.</p>
      ) : null}
      {error ? (
        <p role="alert" className="model-error">
          {error}
        </p>
      ) : null}
      <div className="first-run-card">
        <h2>1. Choose a project</h2>
        {selection ? <p className="first-run-path">{selection.path}</p> : null}
        <button
          type="button"
          disabled={pending || draining || Boolean(selection)}
          onClick={() => void work(choose)}
        >
          Open or create a folder
        </button>
        {selection ? (
          <button
            type="button"
            disabled={pending || Boolean(proposal)}
            onClick={() => {
              setSelection(undefined);
              setScope(undefined);
              setModelDraft((current) =>
                current ? { ...current, auth: 'replace', connectionId: '', apiKey: '' } : undefined,
              );
              setOperationId(crypto.randomUUID());
            }}
          >
            Choose another folder
          </button>
        ) : null}
      </div>
      <div className="first-run-card">
        <h2>2. Configure your team’s model</h2>
        <p>
          Set one connection for all six Agents, then test and save it. You can adjust individual
          roles. The connection test sends a small request to your provider.
        </p>
        <button type="button" disabled={pending || draining} onClick={() => setModels(true)}>
          Model settings
        </button>
      </div>
      {scope && selection ? (
        <div className="first-run-card">
          <h2>3. Describe the work</h2>
          <label htmlFor="first-run-goal">What should your team do?</label>
          <textarea
            id="first-run-goal"
            maxLength={16000}
            rows={4}
            value={goal}
            disabled={pending || Boolean(proposal) || draining}
            onChange={(e) => setGoal(e.target.value)}
          />
          <button
            type="button"
            disabled={pending || draining || !goal.trim() || Boolean(proposal)}
            onClick={() =>
              void work(async () =>
                setProposal(
                  await command({
                    action: 'prepare',
                    operationId,
                    selectionRef: selection.selectionRef,
                    goal,
                  }),
                ),
              )
            }
          >
            Review workspace access
          </button>
        </div>
      ) : null}
      {proposal ? (
        <div className="first-run-card">
          <h2>4. Approve workspace access</h2>
          <p className="first-run-path">{proposal.entry.path}</p>
          <p>
            Allow reading, version-protected edits, managed Node commands and generated output in
            this folder. Commands cannot use the network; output stays in private operation folders.
            Existing changes have not yet been inspected. No model work starts with this approval.
          </p>
          <button
            type="button"
            disabled={pending || draining || Boolean(inspection)}
            onClick={() => void work(approve)}
          >
            Approve and inspect
          </button>
        </div>
      ) : null}
      {inspection && proposal ? (
        <div className="first-run-card">
          <h2>5. Start your team</h2>
          <p>
            A protected baseline of {inspection.baselineFiles} files has been captured, including
            existing changes. Starting work verifies that this baseline still matches your files.
          </p>
          <p>
            {inspection.files.length} top-level entries
            {inspection.truncated ? ' (list truncated)' : ''}. Project scripts are declarations, not
            verified commands.
          </p>
          <details>
            <summary>Recognized files and declared scripts</summary>
            <ul>
              {inspection.files.map((file) => (
                <li key={file.name}>
                  {file.name} ({file.kind})
                </li>
              ))}
            </ul>
            <pre>{JSON.stringify(inspection.scripts, null, 2)}</pre>
            {inspection.readme ? (
              <>
                <h3>{inspection.readme.name} · untrusted project content</h3>
                <pre>{inspection.readme.text}</pre>
              </>
            ) : null}
          </details>
          {inspection.limitations.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <button
            type="button"
            disabled={pending || draining}
            onClick={() =>
              void work(async () => {
                await command({
                  action: 'start',
                  projectId: proposal.entry.projectId,
                  requestId: `start-${operationId}`,
                  inspectionRef: inspection.inspectionRef,
                });
                setSaved((current) => [
                  proposal.entry,
                  ...current.filter((entry) => entry.projectId !== proposal.entry.projectId),
                ]);
                setChat(proposal.entry);
              })
            }
          >
            Start work
          </button>
          <button
            type="button"
            disabled={pending || draining}
            onClick={() =>
              void work(async () => {
                setInspection(
                  await command({ action: 'inspect', projectId: proposal.entry.projectId }),
                );
              })
            }
          >
            Refresh file inspection
          </button>
        </div>
      ) : null}
      {saved.length ? (
        <div className="first-run-card">
          <h2>Saved projects</h2>
          {saved.map((entry) => (
            <div key={entry.projectId}>
              <p className="first-run-path">{entry.path}</p>
              <p>{entry.goal}</p>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (entry.goal) setChat(entry);
                  else {
                    setOperationId(entry.operationId);
                    setScope(entry);
                    setSelection(undefined);
                    setProposal(undefined);
                    setInspection(undefined);
                    setModelDraft(undefined);
                    setGoal('');
                  }
                }}
              >
                {entry.goal ? 'View saved work' : 'Continue setup · select the same folder'}
              </button>
            </div>
          ))}
          <p>Opening saved work does not restart it or call a model.</p>
        </div>
      ) : null}
      {models ? (
        <ModelSettingsDialog
          {...(scope ? { projectId: scope.projectId } : {})}
          {...(modelDraft ? { initialDraft: modelDraft } : {})}
          initialTarget="all"
          onClose={(draft) => {
            setModelDraft(draft);
            setModels(false);
          }}
        />
      ) : null}
    </section>
  );
}
