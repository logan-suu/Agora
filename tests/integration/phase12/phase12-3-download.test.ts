// Real public HTTPS download with a lockfile-pinned tarball. No package code is
// executed and no credentials or project contents leave the host. Bytes remain
// in memory; evidence keeps only URL, length, integrity and source hashes.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { downloadLocalPackage } from '../../../packages/runtime/sandbox/src/local-download';

it('fetches only the pinned public package through the real TLS/DNS broker', async () => {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    node: process.version,
    kind: 'trusted-download-primitive-only',
  };
  try {
    let checked = 0;
    const result = await downloadLocalPackage({
      url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
      integrity:
        'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
      policy: {
        mode: 'brokered-https',
        origins: ['https://registry.npmjs.org'],
        method: 'GET',
        maxBytes: 16777216,
        timeoutMs: 30000,
        maxRedirects: 3,
      },
      authorize: async () => {
        checked++;
      },
    });
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBeLessThan(16777216);
    expect(result.hops.at(-1)?.status).toBe(200);
    expect(result.hops.every((h) => new URL(h.url).origin === 'https://registry.npmjs.org')).toBe(
      true,
    );
    expect(checked).toBe(result.hops.length * 3);
    report.result = {
      size: result.bytes.length,
      sha256: result.sha256,
      integrity: result.integrity,
      hops: result.hops,
      authorityChecks: checked,
    };
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.sources = Object.fromEntries(
      [
        'packages/runtime/sandbox/src/local-download.ts',
        'packages/runtime/sandbox/src/local-download-policy.ts',
        'tests/integration/phase12/phase12-3-download.test.ts',
      ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
    );
    report.cleanup = { downloadOnDisk: false, packageExecuted: false, persistentDownloadCopies: 0 };
    const folder = resolve('docs/reviews/task123-download-evidence');
    mkdirSync(folder, { recursive: true });
    writeFileSync(resolve(folder, `download-${Date.now()}.json`), JSON.stringify(report, null, 2));
  }
}, 35000);
