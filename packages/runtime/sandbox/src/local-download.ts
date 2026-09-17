/** Private HTTPS broker primitive. The caller supplies a fresh canonical grant
 * check. No HTTP listener or worker-accessible proxy is created. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  isPublicDownloadAddress,
  type LocalDownloadPolicy,
  qualifyDownloadUrl,
  validateDownloadPolicy,
} from './local-download-policy';

export interface LocalDownloadInput {
  url: string;
  integrity: string;
  policy: LocalDownloadPolicy;
  authorize(): Promise<void>;
  signal?: AbortSignal;
}
export interface LocalDownloadResult {
  bytes: Buffer;
  sha256: string;
  integrity: string;
  hops: { url: string; address: string; status: number }[];
}
const error = (code: string) => new Error(code);
function expectedIntegrity(value: string): Buffer {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value))
    throw error('invalid_download_integrity');
  const bytes = Buffer.from(value.slice(7), 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value.slice(7))
    throw error('invalid_download_integrity');
  return bytes;
}
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(error('download_cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function receive(
  url: URL,
  address: { address: string; family: number },
  limit: number,
  signal: AbortSignal,
) {
  const pinned: LookupFunction = (hostname, options, callback) => {
    if (hostname !== url.hostname) {
      callback(error('download_destination_changed'), '');
      return;
    }
    callback(null, options.all ? [address] : address.address, address.family);
  };
  return new Promise<{ status: number; location?: string; bytes: Buffer }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: pinned,
        family: address.family,
        servername: url.hostname,
        rejectUnauthorized: true,
        signal,
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
        maxHeaderSize: 16384,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (!location) {
            reject(error('download_redirect_invalid'));
            return;
          }
          resolve({ status, location, bytes: Buffer.alloc(0) });
          return;
        }
        if (
          status !== 200 ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy();
          reject(error('download_response_rejected'));
          return;
        }
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
          response.destroy();
          reject(error('download_size_exceeded'));
          return;
        }
        let received = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limit) {
            response.destroy();
            req.destroy();
            reject(error('download_size_exceeded'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('error', () => reject(error('download_transport_failed')));
        response.on('aborted', () => reject(error('download_incomplete')));
        response.on('end', () => {
          if (!response.complete || (length !== undefined && Number(length) !== received)) {
            reject(error('download_incomplete'));
            return;
          }
          resolve({ status, bytes: Buffer.concat(chunks, received) });
        });
      },
    );
    req.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        if (socket.remoteAddress !== address.address)
          req.destroy(error('download_destination_changed'));
      }),
    );
    req.on('error', () =>
      reject(error(signal.aborted ? 'download_cancelled' : 'download_transport_failed')),
    );
    req.end();
  });
}
export async function downloadLocalPackage(
  input: LocalDownloadInput,
): Promise<LocalDownloadResult> {
  const policy = validateDownloadPolicy(input.policy),
    expected = expectedIntegrity(input.integrity);
  let url = qualifyDownloadUrl(input.url, policy);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), policy.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const hops: LocalDownloadResult['hops'] = [];
  try {
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      signal.throwIfAborted();
      await untilAborted(input.authorize(), signal);
      const addresses = await untilAborted(
        lookup(url.hostname, { all: true, verbatim: true }),
        signal,
      );
      if (!addresses.length || addresses.some((a) => !isPublicDownloadAddress(a.address)))
        throw error('download_address_denied');
      const address = addresses.find((a) => a.family === 4) ?? addresses[0];
      if (!address) throw error('download_address_denied');
      await untilAborted(input.authorize(), signal);
      const result = await receive(url, address, policy.maxBytes, signal);
      hops.push({ url: url.href, address: address.address, status: result.status });
      await untilAborted(input.authorize(), signal);
      if (result.location !== undefined) {
        if (hop === policy.maxRedirects) throw error('download_redirect_limit');
        url = qualifyDownloadUrl(new URL(result.location, url).href, policy);
        continue;
      }
      const actual = createHash('sha512').update(result.bytes).digest();
      if (!timingSafeEqual(expected, actual)) throw error('download_integrity_mismatch');
      signal.throwIfAborted();
      return {
        bytes: result.bytes,
        sha256: createHash('sha256').update(result.bytes).digest('hex'),
        integrity: input.integrity,
        hops,
      };
    }
    throw error('download_redirect_limit');
  } finally {
    clearTimeout(timer);
  }
}
