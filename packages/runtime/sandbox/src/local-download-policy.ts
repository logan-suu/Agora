/** Trusted broker policy; this data never grants a worker network authority. */
import { BlockList, isIP } from 'node:net';

export interface LocalDownloadPolicy {
  mode: 'brokered-https';
  origins: string[];
  method: 'GET';
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}
const denied = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(network, bits, 'ipv4');
for (const [network, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied.addSubnet(network, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicDownloadAddress(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}
function parseUrl(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === '\\') ||
    /\s/.test(value)
  )
    throw Error('download_url_denied');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error('download_url_denied');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !url.hostname.includes('.') ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    url.hostname.endsWith('.') ||
    isIP(url.hostname)
  )
    throw Error('download_url_denied');
  return url;
}
export function validateDownloadPolicy(policy: LocalDownloadPolicy): LocalDownloadPolicy {
  if (
    !policy ||
    Object.keys(policy).sort().join(',') !==
      'maxBytes,maxRedirects,method,mode,origins,timeoutMs' ||
    policy.mode !== 'brokered-https' ||
    policy.method !== 'GET' ||
    !Array.isArray(policy.origins) ||
    !policy.origins.length ||
    policy.origins.length > 16 ||
    new Set(policy.origins).size !== policy.origins.length ||
    !Number.isInteger(policy.maxBytes) ||
    policy.maxBytes < 1 ||
    policy.maxBytes > 16777216 ||
    !Number.isInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > 30000 ||
    !Number.isInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > 3
  )
    throw Error('invalid_download_policy');
  for (const origin of policy.origins)
    if (parseUrl(origin).origin !== origin) throw Error('invalid_download_policy');
  return structuredClone(policy);
}
export function qualifyDownloadUrl(value: string, policy: LocalDownloadPolicy): URL {
  const approved = validateDownloadPolicy(policy),
    url = parseUrl(value);
  if (!approved.origins.includes(url.origin)) throw Error('download_origin_denied');
  return url;
}
