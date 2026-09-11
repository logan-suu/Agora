import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PUBLIC_NAMES, type PublicName } from './accounting';

export const PUBLIC_REVISION = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f';
export const TEST_COUNTS: Record<PublicName, number> = {
  'grade-school': 10,
  wordy: 23,
  'book-store': 17,
  forth: 49,
};
export function publicFiles(name: string) {
  if (!PUBLIC_NAMES.includes(name as PublicName)) throw new Error('unknown public task');
  return [
    { path: `${name}.js`, audience: 'agent' },
    { path: '.docs/instructions.md', audience: 'agent' },
    ...(name === 'book-store' ? [{ path: '.docs/instructions.append.md', audience: 'agent' }] : []),
    { path: 'LICENSE', audience: 'metadata' },
    { path: 'package.json', audience: 'verifier' },
    { path: 'babel.config.js', audience: 'verifier' },
    { path: `${name}.spec.js`, audience: 'verifier' },
    { path: '.meta/proof.ci.js', audience: 'reference' },
  ];
}
export function activateTests(source: string): string {
  if (/\b(?:test|it|describe)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe)\s*\(/.test(source))
    throw new Error('unsupported skipped or focused tests');
  return source.replace(/\bxtest\(/g, 'test(');
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export async function downloadPublicTask(root: string, name: PublicName) {
  const files = [];
  for (const entry of publicFiles(name)) {
    const url = `https://raw.githubusercontent.com/Aider-AI/polyglot-benchmark/${PUBLIC_REVISION}/javascript/exercises/practice/${name}/${entry.path}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`source download failed: ${name}/${entry.path} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const path = join(root, name, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    files.push({ ...entry, sha256: sha256(bytes) });
  }
  const manifest = { name, revision: PUBLIC_REVISION, expectedTests: TEST_COUNTS[name], files };
  await writeFile(join(root, name, 'source-manifest.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  });
  return manifest;
}
export async function readPublicFile(
  root: string,
  name: PublicName,
  path: string,
): Promise<string> {
  if (!publicFiles(name).some((f) => f.path === path))
    throw new Error('file is not in source allowlist');
  const manifest = JSON.parse(await readFile(join(root, name, 'source-manifest.json'), 'utf8'));
  const data = await readFile(join(root, name, path));
  if (
    manifest.revision !== PUBLIC_REVISION ||
    manifest.name !== name ||
    manifest.files.find((f: { path: string }) => f.path === path)?.sha256 !== sha256(data)
  )
    throw new Error('source hash mismatch');
  return data.toString('utf8');
}

export function validateJestResult(
  value: unknown,
  expectedTests: number,
  exitCode: number,
): boolean {
  if (!value || typeof value !== 'object') throw new Error('missing verifier report');
  const r = value as Record<string, unknown>;
  for (const key of [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numRuntimeErrorTestSuites',
  ]) {
    if (!Number.isInteger(r[key]) || (r[key] as number) < 0)
      throw new Error('invalid verifier counts');
  }
  if (
    expectedTests <= 0 ||
    r.numTotalTests !== expectedTests ||
    r.numPendingTests !== 0 ||
    r.numTodoTests !== 0 ||
    r.numRuntimeErrorTestSuites !== 0 ||
    (r.numPassedTests as number) + (r.numFailedTests as number) !== expectedTests ||
    !Array.isArray(r.testResults)
  )
    throw new Error('incomplete verifier coverage');
  const assertions = r.testResults.flatMap((suite) =>
    Array.isArray(suite.assertionResults) ? suite.assertionResults : [],
  );
  if (
    assertions.length !== expectedTests ||
    assertions.some((a) => !['passed', 'failed'].includes(a.status))
  )
    throw new Error('missing verifier assertions');
  if (assertions.filter((a) => a.status === 'passed').length !== r.numPassedTests)
    throw new Error('inconsistent verifier assertions');
  const passed = r.numFailedTests === 0;
  if (typeof r.success !== 'boolean' || r.success !== passed || (exitCode === 0) !== passed)
    throw new Error('inconsistent verifier outcome');
  return passed;
}
