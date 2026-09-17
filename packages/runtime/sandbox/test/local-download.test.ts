// Mock reason (R11): deterministic DNS answers exercise private/mixed address
// rejection before HTTPS. This does not count as real download G5.
import { describe, expect, it, vi } from 'vitest';
import { downloadLocalPackage } from '../src/local-download';

const dns = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock('node:dns/promises', () => dns);
const input = {
  url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
  integrity:
    'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
  policy: {
    mode: 'brokered-https' as const,
    origins: ['https://registry.npmjs.org'],
    method: 'GET' as const,
    maxBytes: 16777216,
    timeoutMs: 30000,
    maxRedirects: 3,
  },
  authorize: async () => {},
};
describe('download authority and DNS boundary', () => {
  it.each([
    { addresses: [{ address: '127.0.0.1', family: 4 }] },
    {
      addresses: [
        { address: '104.16.1.35', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    },
    { addresses: [] },
  ])('rejects unsafe or empty DNS sets $addresses', async ({ addresses }) => {
    dns.lookup.mockResolvedValueOnce(addresses);
    await expect(downloadLocalPackage(input)).rejects.toThrow('download_address_denied');
  });
  it('rejects a revoked authority before resolution', async () => {
    dns.lookup.mockClear();
    await expect(
      downloadLocalPackage({
        ...input,
        authorize: async () => {
          throw Error('authorization_closed');
        },
      }),
    ).rejects.toThrow('authorization_closed');
    expect(dns.lookup).not.toHaveBeenCalled();
  });
  it('rechecks authority after DNS and before the pinned connection', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '104.16.1.35', family: 4 }]);
    let checks = 0;
    await expect(
      downloadLocalPackage({
        ...input,
        authorize: async () => {
          if (++checks === 2) throw Error('authorization_closed');
        },
      }),
    ).rejects.toThrow('authorization_closed');
    expect(checks).toBe(2);
  });
  it('requires a canonical pinned integrity before performing network I/O', async () => {
    dns.lookup.mockClear();
    await expect(downloadLocalPackage({ ...input, integrity: 'sha512-anything' })).rejects.toThrow(
      'invalid_download_integrity',
    );
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});
