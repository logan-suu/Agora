import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../core/contracts';
import { sha256 } from './public-adapter';

export interface FrozenManifest {
  schemaVersion: number;
  trials: readonly { id: string }[];
  frozen: unknown;
}
interface Group {
  manifest: FrozenManifest;
  fingerprint: string;
  createdAt: string;
  attempts: {
    id: string;
    status: 'pending' | 'started' | 'final';
    startedAt?: string;
    runRoot?: string;
    result?: unknown;
  }[];
}
export class GroupRegistry {
  constructor(
    readonly path: string,
    readonly manifest: FrozenManifest,
  ) {
    if (
      manifest.trials.length === 0 ||
      new Set(manifest.trials.map((t) => t.id)).size !== manifest.trials.length
    )
      throw new Error('invalid trial manifest');
    if (!existsSync(path))
      writeFileSync(
        path,
        JSON.stringify(
          {
            manifest,
            fingerprint: sha256(canonicalJson(manifest)),
            createdAt: new Date().toISOString(),
            attempts: manifest.trials.map((t) => ({ id: t.id, status: 'pending' })),
          },
          null,
          2,
        ),
        { flag: 'wx', mode: 0o600 },
      );
    this.read();
  }
  read(): Group {
    const group = JSON.parse(readFileSync(this.path, 'utf8')) as Group;
    if (
      group.fingerprint !== sha256(canonicalJson(this.manifest)) ||
      group.fingerprint !== sha256(canonicalJson(group.manifest))
    )
      throw new Error('frozen manifest drift');
    if (
      !Array.isArray(group.attempts) ||
      group.attempts.length !== this.manifest.trials.length ||
      group.attempts.some(
        (a, i) =>
          a.id !== this.manifest.trials[i]?.id ||
          !['pending', 'started', 'final'].includes(a.status) ||
          (a.status !== 'pending' && (!a.startedAt || !a.runRoot)),
      )
    )
      throw new Error('corrupt trial registry');
    return group;
  }
  private update(id: string, change: (attempt: Group['attempts'][number]) => void) {
    const group = this.read(),
      attempt = group.attempts.find((a) => a.id === id);
    if (!attempt) throw new Error('unregistered trial');
    change(attempt);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(group, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temp, this.path);
  }
  start(id: string, runRoot: string) {
    this.update(id, (attempt) => {
      if (attempt.status !== 'pending') throw new Error('trial already started');
      attempt.status = 'started';
      attempt.runRoot = runRoot;
      attempt.startedAt = new Date().toISOString();
    });
  }
  finish(id: string, result: unknown) {
    this.update(id, (attempt) => {
      if (attempt.status !== 'started') throw new Error('trial is not started');
      if (
        !result ||
        typeof result !== 'object' ||
        !('lifecycle' in result) ||
        result.lifecycle !== 'final'
      )
        throw new Error('missing final result');
      attempt.result = result;
      attempt.status = 'final';
    });
  }
  pending() {
    return this.read()
      .attempts.filter((a) => a.status === 'pending')
      .map((a) => a.id);
  }
}
/** Include actual uncommitted code as well as the lockfile; Git HEAD alone is insufficient. */
export function sourceFingerprint(root: string) {
  const files: { path: string; sha256: string }[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (['node_modules', '.next', '.git', '.data', 'dist', 'coverage'].includes(entry.name))
        continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(?:tsx?|mjs|cjs|json|ya?ml|c)$/.test(entry.name))
        files.push({ path: child, sha256: sha256(readFileSync(join(root, child))) });
    }
  };
  for (const path of ['packages', 'apps', 'tests/evals']) walk(path);
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'vitest.eval.config.ts',
    'tests/evals/fixtures/phase10/Dockerfile',
  ])
    files.push({ path, sha256: sha256(readFileSync(join(root, path))) });
  return { fingerprint: sha256(canonicalJson(files)), files };
}
