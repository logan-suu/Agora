'use client';

import { useEffect, useState } from 'react';
import './preview.css';

const credentialMessages: Record<string, string> = {
  ready: 'Available and protected by macOS Keychain',
  locked: 'Unlock your macOS Keychain, then restart Agora.',
  denied: 'Allow Keychain access, then restart Agora.',
  missing: 'Restore the original Agora Keychain item before using saved credentials.',
  mismatch: 'Restore the original encryption key. Saved credentials have been retained.',
  ambiguous: 'Conflicting Keychain entries need recovery. Saved credentials have been retained.',
};

export function DesktopPreview() {
  const [credentials, setCredentials] = useState('checking');
  const [toolsReady, setToolsReady] = useState(false);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const events = new EventSource('/api/desktop/events');
    events.addEventListener('status', (event) => {
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (
          value &&
          typeof value === 'object' &&
          'credentials' in value &&
          typeof value.credentials === 'string'
        ) {
          setCredentials(value.credentials);
          setToolsReady(
            'toolchain' in value &&
              value.toolchain !== null &&
              typeof value.toolchain === 'object' &&
              'state' in value.toolchain &&
              value.toolchain.state === 'ready',
          );
          setConnected(true);
        }
      } catch {
        setConnected(false);
      }
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);
  return (
    <main className="desktop-preview">
      <header>
        <span className="desktop-wordmark">
          Agora<span aria-hidden="true">.</span>
        </span>
        <span className="desktop-tag">Desktop preview</span>
      </header>
      <section className="desktop-intro">
        <p className="desktop-eyebrow">YOUR TEAM, ON YOUR MAC</p>
        <h1>
          A home for your
          <br />
          next great idea.
        </h1>
        <p>
          Agora is installed. This preview checks your local environment
          <br className="desktop-wide" /> and keeps you informed while the desktop experience takes
          shape.
        </p>
      </section>
      <section className="desktop-checks" aria-label="Environment checks">
        <div>
          <span className={connected ? 'desktop-dot ready' : 'desktop-dot'} />
          <div>
            <h2>Local service</h2>
            <p role="status">
              {connected ? 'Connected · running on this Mac' : 'Connecting to your local service…'}
            </p>
          </div>
          <span className="desktop-check-label">{connected ? 'Ready' : 'Checking'}</span>
        </div>
        <div>
          <span className={credentials === 'ready' ? 'desktop-dot ready' : 'desktop-dot'} />
          <div>
            <h2>Secure credentials</h2>
            <p>
              {credentialMessages[credentials] ??
                (credentials === 'checking'
                  ? 'Checking macOS Keychain…'
                  : 'Keychain needs attention. Saved credentials are retained; restart after recovery.')}
            </p>
          </div>
        </div>
        <div>
          <span className={connected && toolsReady ? 'desktop-dot ready' : 'desktop-dot'} />
          <div>
            <h2>Development tools</h2>
            <p>
              {connected && toolsReady
                ? 'Node, Git, npm, pnpm and native helpers are installed and verified.'
                : 'Waiting for bundled tool verification…'}
            </p>
          </div>
        </div>
        <div>
          <span className="desktop-dot" />
          <div>
            <h2>Project development</h2>
            <p>Available in a later desktop release.</p>
          </div>
          <span className="desktop-check-label">Coming later</span>
        </div>
      </section>
      <footer>
        <span>Private by design. Your data stays on this Mac.</span>
        <span>Installation & environment preview</span>
      </footer>
    </main>
  );
}
