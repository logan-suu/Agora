// Pure policy checks use no network or transport doubles. Actual HTTPS and
// isolated installation are covered by the separate native acceptance fixture.
import { describe, expect, it } from 'vitest';

const policy = {
  mode: 'brokered-https' as const,
  origins: ['https://registry.npmjs.org'],
  method: 'GET' as const,
  maxBytes: 16777216,
  timeoutMs: 30000,
  maxRedirects: 3,
};
describe('trusted download qualification', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::a00:1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    'not-an-ip',
    '1.2.3.4%eth0',
  ])('rejects nonpublic destination %s', async (address) => {
    const { isPublicDownloadAddress } = await import('../src/local-download-policy');
    expect(isPublicDownloadAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '104.16.1.35', '2606:4700::1111', '2001:4860:4860::8888'])(
    'accepts native public address %s',
    async (address) => {
      const { isPublicDownloadAddress } = await import('../src/local-download-policy');
      expect(isPublicDownloadAddress(address)).toBe(true);
    },
  );
  it.each([
    'http://registry.npmjs.org/a',
    'https://registry.npmjs.org:444/a',
    'https://user:password@registry.npmjs.org/a',
    'https://registry.npmjs.org.evil.example/a',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'file:///etc/passwd',
    'https://registry.npmjs.org/a#hidden',
    'https://registry.npmjs.org/\\evil',
  ])('rejects unapproved URL %s', async (url) => {
    const { qualifyDownloadUrl } = await import('../src/local-download-policy');
    expect(() => qualifyDownloadUrl(url, policy)).toThrow();
  });
  it('checks every redirected URL against the original policy', async () => {
    const { qualifyDownloadUrl } = await import('../src/local-download-policy');
    expect(
      qualifyDownloadUrl('https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz', policy)
        .hostname,
    ).toBe('registry.npmjs.org');
    expect(() =>
      qualifyDownloadUrl(
        new URL('https://metadata.google.internal/', 'https://registry.npmjs.org').href,
        policy,
      ),
    ).toThrow();
    expect(() =>
      qualifyDownloadUrl('https://registry.npmjs.org/a', {
        ...policy,
        origins: ['https://registry.npmjs.org/ignored-path'],
      }),
    ).toThrow();
  });
});
