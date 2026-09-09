'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  AgentModelView,
  ModelSettingsCommand,
  ModelSettingsView,
} from '../lib/model-settings';

const emptyDraft = {
  model: '',
  baseURL: '',
  contextWindow: 32768,
  maxTokens: 4096,
  auth: 'replace' as 'replace' | 'keep' | 'none',
  connectionId: '',
  apiKey: '',
};
function draftFor(role?: AgentModelView) {
  return role?.connectionId
    ? {
        model: role.model,
        baseURL: role.baseURL ?? '',
        contextWindow: role.contextWindow ?? 32768,
        maxTokens: role.maxTokens ?? 4096,
        auth: 'keep' as const,
        connectionId: role.connectionId,
        apiKey: '',
      }
    : { ...emptyDraft };
}

export function ModelSettingsDialog({
  projectId,
  initialTarget,
  onClose,
}: {
  projectId: string;
  initialTarget: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<ModelSettingsView>();
  const [target, setTarget] = useState(initialTarget);
  const [draft, setDraft] = useState({ ...emptyDraft });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    fetch(`/api/model-settings?projectId=${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Unable to load model settings.');
        if (controller.signal.aborted) return;
        setSettings(value);
        setDraft(
          draftFor((value as ModelSettingsView).roles.find((r) => r.role === initialTarget)),
        );
        setTarget(initialTarget);
        setError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load model settings.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [projectId, initialTarget, reload]);
  const available =
    settings?.roles.filter((r) => r.status === 'enabled' || r.status === 'disabled') ?? [];
  const targets = available.filter((r) => target === 'all' || r.role === target);
  const connections =
    settings?.roles.filter(
      (r, index, roles) =>
        r.connectionId &&
        roles.findIndex((other) => other.connectionId === r.connectionId) === index,
    ) ?? [];
  const selected = settings?.roles.find((r) => r.role === target);
  async function submit(action: ModelSettingsCommand['action']) {
    if (!settings || pending) return;
    setPending(true);
    setError('');
    setNotice('');
    const command: ModelSettingsCommand = {
      projectId,
      expectedRevision: settings.revision,
      target,
      action,
      ...(action === 'reset' ? {} : draft),
    };
    try {
      const response = await fetch('/api/model-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Unable to save model settings.');
      if (action === 'test') setNotice('Connection test passed. Settings have not been saved.');
      else {
        setSettings(value);
        const role = (value as ModelSettingsView).roles.find((r) =>
          target === 'all' ? targets.some((t) => t.role === r.role) : r.role === target,
        );
        setDraft(draftFor(role));
        setNotice(
          action === 'reset'
            ? `Deployment defaults restored for ${targets.length} Agent(s).`
            : `Saved for ${targets.length} Agent(s). New tasks will use these settings.`,
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="model-dialog"
      aria-labelledby="model-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="model-dialog-heading">
        <div>
          <span className="model-eyebrow">TEAM CONFIGURATION</span>
          <h2 id="model-settings-title">Agent models</h2>
        </div>
        <button
          type="button"
          className="model-close"
          aria-label="Close model settings"
          onClick={onClose}
          disabled={pending}
        >
          ×
        </button>
      </div>
      <p className="model-description">
        Choose a model for each Agent, or set the same model for the whole team. Changes apply to
        new tasks. Running and paused tasks keep their original settings.
      </p>
      {error ? (
        <p className="model-error" role="alert">
          {error}{' '}
          <button type="button" disabled={pending} onClick={() => setReload((n) => n + 1)}>
            Reload settings
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="model-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!settings ? (
        <p role="status">{pending ? 'Loading settings…' : 'Settings could not be loaded.'}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit('save');
          }}
        >
          <fieldset disabled={pending}>
            <label>
              Apply to
              <select
                value={target}
                onChange={(event) => {
                  const next = event.target.value;
                  setTarget(next);
                  setDraft(draftFor(settings.roles.find((r) => r.role === next)));
                  setNotice('');
                  setError('');
                }}
              >
                <option value="all">All Agents ({available.length})</option>
                {available.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.role}
                    {r.status === 'disabled' ? ' (disabled)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="model-targets" aria-label="Target Agents">
              {targets.length
                ? targets.map((r) => <span key={r.role}>{r.role}</span>)
                : 'No configurable Agents.'}
            </fieldset>
            {selected ? (
              <p className="model-current">
                Current:{' '}
                {selected.connectionId
                  ? `${selected.model} · ${selected.baseURL} · ${selected.apiKeyConfigured ? 'API key saved' : 'No authentication'}`
                  : `Deployment default · ${selected.model}`}
              </p>
            ) : (
              <p className="model-current">
                One save updates all listed Agents. You can customize any Agent afterward.
              </p>
            )}
            <label>
              Connection
              <select
                value={draft.connectionId}
                onChange={(event) => {
                  const role = connections.find((r) => r.connectionId === event.target.value);
                  setDraft(draftFor(role));
                  setNotice('');
                }}
              >
                <option value="">New connection</option>
                {connections.map((r) => (
                  <option key={r.connectionId} value={r.connectionId}>
                    {r.role} · {r.baseURL} · {r.apiKeyConfigured ? 'key saved' : 'no auth'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Base URL
              <input
                type="url"
                required
                value={draft.baseURL}
                placeholder="https://gateway.example/v1"
                autoComplete="off"
                onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })}
              />
            </label>
            <small className="model-hint">
              Chat Completions with streaming and function tools. HTTPS, or HTTP on localhost.
            </small>
            <label>
              Model name
              <input
                required
                value={draft.model}
                maxLength={256}
                placeholder="Enter the provider’s model ID"
                autoComplete="off"
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
            </label>
            <label>
              Authentication
              <select
                value={draft.auth}
                onChange={(event) =>
                  setDraft({ ...draft, auth: event.target.value as typeof draft.auth, apiKey: '' })
                }
              >
                {draft.connectionId ? (
                  <option value="keep">Keep selected connection’s key</option>
                ) : null}
                <option value="replace">Use a new API key</option>
                <option value="none">No authentication (local service)</option>
              </select>
            </label>
            {draft.auth === 'replace' ? (
              <label>
                API Key
                <input
                  type="password"
                  required
                  value={draft.apiKey}
                  autoComplete="new-password"
                  maxLength={8192}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
                <small className="model-hint">
                  Encrypted on the server. Saved keys are never displayed.
                </small>
              </label>
            ) : null}
            {!settings.credentialsAvailable ? (
              <p className="model-hint">
                To save API keys, the server needs AGORA_CREDENTIALS_KEY. No-auth connections remain
                available.
              </p>
            ) : null}
            <details className="model-advanced">
              <summary>Advanced · token limits</summary>
              <div className="model-limits">
                <label>
                  Context window
                  <input
                    type="number"
                    min={1024}
                    max={2000000}
                    required
                    value={draft.contextWindow}
                    onChange={(event) =>
                      setDraft({ ...draft, contextWindow: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Max output tokens
                  <input
                    type="number"
                    min={1}
                    max={draft.contextWindow}
                    required
                    value={draft.maxTokens}
                    onChange={(event) =>
                      setDraft({ ...draft, maxTokens: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <small className="model-hint">
                Set limits supported by your provider. Defaults: 32,768 context / 4,096 output.
              </small>
            </details>
            <div className="model-actions">
              <button
                type="button"
                className="model-reset"
                disabled={!targets.length}
                onClick={() => void submit('reset')}
              >
                Restore defaults
              </button>
              <button type="button" disabled={!targets.length} onClick={() => void submit('test')}>
                Test connection
              </button>
              <button
                type="submit"
                className="model-save"
                disabled={
                  !targets.length || (draft.auth === 'replace' && !settings.credentialsAvailable)
                }
              >
                {pending
                  ? 'Working…'
                  : target === 'all'
                    ? `Apply to all ${targets.length} Agents`
                    : 'Save model'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <div className="model-footer">
        <span>Saving does not call the model. Testing sends a short request.</span>
        <button type="button" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
