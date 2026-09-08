import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Hash the actual execution sources, including uncommitted and new files. */
export function executionFingerprint(): string {
  const paths = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
      }).split('\0'),
    ),
  ]
    .filter(
      (path) =>
        path &&
        (/^(packages|apps|tests)\//.test(path) ||
          /^(package.json|pnpm-lock.yaml|.*config.*|pnpm-workspace.yaml)$/.test(path)),
    )
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  hash.update(
    readFileSync(`packages/runtime/sandbox/build/secure-files-${process.platform}-${process.arch}`),
  );
  return hash.digest('hex');
}
