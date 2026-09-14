import { describe, expect, it } from 'vitest';
import { desktopEnvironment, parseServiceEvent, requestAllowed } from '../src/protocol.js';

describe('desktop trust boundaries', () => {
  it('accepts only a loopback ready event with a supported protocol and credential status', () => {
    const ready = {
      type: 'ready',
      version: 1,
      origin: 'http://127.0.0.1:54321',
      credentials: 'ready',
    };
    expect(parseServiceEvent(ready)).toEqual(ready);
    for (const value of [
      { ...ready, version: 2 },
      { ...ready, origin: 'http://evil.test:54321' },
      { ...ready, origin: 'http://127.0.0.1:54321/path' },
      { ...ready, credentials: 'unknown' },
      { ...ready, secret: 'must not cross IPC' },
      null,
    ])
      expect(() => parseServiceEvent(value)).toThrow();
  });

  it('requires the private capability and exact request origin for resources and SSE', () => {
    const origin = 'http://127.0.0.1:54321';
    const headers = { host: '127.0.0.1:54321', 'x-agora-desktop': 'a'.repeat(64) };
    expect(requestAllowed(headers, origin, 'a'.repeat(64))).toBe(true);
    for (const changes of [
      { 'x-agora-desktop': 'b'.repeat(64) },
      { host: 'localhost:54321' },
      { origin: 'https://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-agora-desktop': ['a'.repeat(64), 'a'.repeat(64)] },
      { 'x-agora-desktop': 'é'.repeat(64) },
    ])
      expect(requestAllowed({ ...headers, ...changes }, origin, 'a'.repeat(64))).toBe(false);
  });

  it('rebuilds service environment without shell or model secrets', () => {
    const env = desktopEnvironment({
      HOME: '/home/test',
      LANG: 'en_US.UTF-8',
      PATH: '/evil',
      NODE_OPTIONS: '--inspect',
      NODE_PATH: '/evil',
      ELECTRON_RUN_AS_NODE: '1',
      DEEPSEEK_API_KEY: 'secret',
      AGORA_CREDENTIALS_KEY: 'secret',
      AGORA_DATA_ROOT: '/old',
    });
    expect(env).toEqual({
      HOME: '/home/test',
      LANG: 'en_US.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      NODE_ENV: 'production',
      NEXT_MANUAL_SIG_HANDLE: 'true',
      AGORA_LOCAL_LAUNCH: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    });
  });
});
