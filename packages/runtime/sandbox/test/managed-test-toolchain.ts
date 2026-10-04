/** Test preparation is explicit, pinned and independent of installed apps. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export function managedTestToolchain() {
  const root = resolve('test-outputs/managed-toolchain', `darwin-${process.arch}`);
  if (!existsSync(`${root}/manifest.json`))
    throw Error(
      'Managed test tools are missing. Build desktop/native helpers, then run node scripts/prepare-test-toolchain.mjs.',
    );
  return root;
}
