import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const protocolVersion = 1;
export const appId = 'com.agora.desktop';
export const credentialService = 'com.agora.desktop.credentials';
export const credentialStates = [
  'ready',
  'missing',
  'locked',
  'denied',
  'unavailable',
  'ambiguous',
  'invalid',
  'mismatch',
  'history_invalid',
] as const;
export type ServiceEvent =
  | { type: 'ready'; version: 1; origin: string; credentials: string }
  | { type: 'stopped'; version: 1 }
  | { type: 'failed'; version: 1; code: string };

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_protocol');
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value)))
    throw new Error('invalid_protocol');
}

export function isServiceOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.hostname === '127.0.0.1' &&
      url.protocol === 'http:' &&
      Number(url.port) > 0 &&
      Number(url.port) <= 65535 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function parseServiceEvent(value: unknown): ServiceEvent {
  const event = record(value);
  if (event.version !== protocolVersion) throw new Error('invalid_protocol');
  if (event.type === 'ready') {
    exactKeys(event, ['type', 'version', 'origin', 'credentials']);
    if (
      !isServiceOrigin(event.origin) ||
      !credentialStates.some((state) => state === event.credentials)
    )
      throw new Error('invalid_protocol');
  } else if (event.type === 'stopped') exactKeys(event, ['type', 'version']);
  else if (event.type === 'failed') {
    exactKeys(event, ['type', 'version', 'code']);
    if (typeof event.code !== 'string' || !/^[a-z_]{1,64}$/.test(event.code))
      throw new Error('invalid_protocol');
  } else throw new Error('invalid_protocol');
  return event as ServiceEvent;
}

export function requestAllowed(headers: IncomingHttpHeaders, origin: string, capability: string) {
  const supplied = headers['x-agora-desktop'];
  return (
    typeof supplied === 'string' &&
    Buffer.byteLength(supplied) === Buffer.byteLength(capability) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(capability)) &&
    headers.host === new URL(origin).host &&
    (headers.origin === undefined || headers.origin === origin) &&
    headers['sec-fetch-site'] !== 'cross-site'
  );
}

export function desktopEnvironment(
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (source[key]) env[key] = source[key];
  }
  return {
    ...env,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_ENV: 'production',
    NEXT_MANUAL_SIG_HANDLE: 'true',
    AGORA_LOCAL_LAUNCH: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}
