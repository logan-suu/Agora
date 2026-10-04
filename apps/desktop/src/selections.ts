/** Host-only directory selections. A selection is not a filesystem grant. */
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

type Scope = { projectId: string; taskId: string };
type Identity = { path: string; dev: string; ino: string }[];
const validId = (s: string) =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
};
async function identity(path: string): Promise<Identity> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw Error('selection_changed');
  const result: Identity = [];
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('selection_changed');
    result.push({ path: current, dev: String(info.dev), ino: String(info.ino) });
    if (dirname(current) === current) break;
  }
  return result;
}
export class DesktopSelections {
  private readonly entries = new Map<
    string,
    {
      scope: Scope;
      actionId: string;
      identity: Identity;
      view: { selectionRef: string; path: string };
    }
  >();
  private constructor(private readonly roots: Identity[]) {}
  static async create(roots: readonly string[]) {
    if (roots.length > 16) throw Error('invalid_acceptance_scope');
    return new DesktopSelections(await Promise.all(roots.map(identity)));
  }
  get enabled() {
    return this.roots.length > 0;
  }
  async assertAccepted(path: string): Promise<void> {
    await this.check(path);
  }
  private async check(path: string) {
    const root = this.roots.find((r) => r[0] && within(r[0].path, path));
    if (!root?.[0]) throw Error('outside_acceptance_scope');
    if (JSON.stringify(await identity(root[0].path)) !== JSON.stringify(root))
      throw Error('selection_changed');
    return identity(path);
  }
  async select(scope: Scope, actionId: string, path: string) {
    if (!validId(scope.projectId) || !validId(scope.taskId) || !validId(actionId))
      throw Error('invalid_selection_scope');
    const old = [...this.entries.values()].find(
      (e) =>
        e.actionId === actionId &&
        e.scope.projectId === scope.projectId &&
        e.scope.taskId === scope.taskId,
    );
    if (old) {
      if (old.view.path !== path) throw Error('selection_action_conflict');
      await this.resolve(scope, old.view.selectionRef);
      return { ...old.view };
    }
    if (this.entries.size >= 128) throw Error('selection_capacity');
    const proof = await this.check(path);
    const view = { selectionRef: `selection:${randomUUID()}`, path };
    this.entries.set(view.selectionRef, { scope: { ...scope }, actionId, identity: proof, view });
    return { ...view };
  }
  async resolve(scope: Scope, selectionRef: string) {
    const entry = this.entries.get(selectionRef);
    if (!entry || entry.scope.projectId !== scope.projectId || entry.scope.taskId !== scope.taskId)
      throw Error('selection_unavailable');
    if (JSON.stringify(await this.check(entry.view.path)) !== JSON.stringify(entry.identity))
      throw Error('selection_changed');
    return entry.view.path;
  }
}
