import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RootFiles } from './secure-files';

/** Canonical capability identity plus explicitly registered, immutable aliases. */
export class RootFileIndex<T extends RootFiles> {
  private readonly aliases = new Map<string, string>();
  private readonly capabilities = new Map<string, T>();

  set(path: string, files: T): void {
    const alias = resolve(path);
    const canonical = realpathSync(alias);
    const previous = this.aliases.get(alias);
    if (previous !== undefined && previous !== canonical)
      throw new Error('worktree root retargeted');
    const existing = this.capabilities.get(canonical);
    (existing ?? files).verifyRoot();
    this.capabilities.set(canonical, existing ?? files);
    this.aliases.set(alias, canonical);
    this.aliases.set(canonical, canonical);
  }

  get(path: string): T | undefined {
    const alias = resolve(path);
    const canonical = this.aliases.get(alias);
    if (canonical === undefined) return undefined;
    if (realpathSync(alias) !== canonical) throw new Error('worktree root retargeted');
    return this.capabilities.get(canonical);
  }

  delete(path: string): void {
    const canonical = this.aliases.get(resolve(path));
    if (canonical === undefined) return;
    this.capabilities.delete(canonical);
    for (const [alias, root] of this.aliases) {
      if (root === canonical) this.aliases.delete(alias);
    }
  }
}
