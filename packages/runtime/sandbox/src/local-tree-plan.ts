/** Read-only application planning from already captured immutable manifests.
 * No returned plan grants authority or attests to current live-directory state. */
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import {
  compareLocalTrees,
  type DeliveryTree,
  type TreeComparison,
} from '../../../core/domain/src/local-tree-comparison';
import { localRecordHash } from './local-registry-records';
import type {
  LocalFileManifest,
  LocalVersionScope,
  LocalVersionStore,
} from './local-version-store';

export type LocalTreePlanInput = {
  scope: LocalVersionScope;
  baseline: WorkspaceVersionV1;
  artifact: WorkspaceVersionV1;
  current: WorkspaceVersionV1;
};
export type LocalTreePlan = LocalTreePlanInput & {
  schemaVersion: 'local-tree-plan-v1';
  inputHash: string;
  comparison: TreeComparison;
  writes: { path: string; contentHash: string }[];
};
function logical(manifest: LocalFileManifest): DeliveryTree {
  return {
    directories: manifest.directories.filter((d) => d.path !== '').map((d) => d.path),
    files: manifest.files.map(({ path, version }) => ({
      path,
      sha256: version.sha256,
      size: version.size,
      executable: version.executable,
    })),
  };
}
export async function planLocalTreeApplication(
  versions: LocalVersionStore,
  request: LocalTreePlanInput,
): Promise<LocalTreePlan> {
  localRecordHash(request);
  if (Object.keys(request).sort().join(',') !== 'artifact,baseline,current,scope')
    throw Error('invalid_tree_plan');
  const input = structuredClone(request);
  // read() verifies scope, full structure and every immutable content object.
  // Physical current-state checks belong to the later authorized apply service.
  const baseline = await versions.read(input.baseline, input.scope),
    artifact = await versions.read(input.artifact, input.scope),
    current = await versions.read(input.current, input.scope);
  const comparison = compareLocalTrees(
    logical(baseline),
    logical(artifact),
    logical(current),
    current.excludedPaths,
  );
  const sources = new Map(artifact.files.map((file) => [file.path, file]));
  const writes: LocalTreePlan['writes'] = [];
  for (const step of comparison.operations ?? []) {
    if (step.op !== 'put') continue;
    const source = sources.get(step.path),
      after = step.after;
    if (
      !source ||
      after?.kind !== 'file' ||
      source.contentHash !== after.file.sha256 ||
      source.version.size !== after.file.size ||
      source.version.executable !== after.file.executable
    )
      throw Error('tree_plan_source_mismatch');
    writes.push({ path: step.path, contentHash: source.contentHash });
  }
  return {
    ...input,
    schemaVersion: 'local-tree-plan-v1',
    inputHash: localRecordHash(input),
    comparison,
    writes,
  };
}
