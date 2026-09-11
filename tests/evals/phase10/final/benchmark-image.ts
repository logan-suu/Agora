import type { Dockerode } from '@agora/runtime-sandbox';

/** Resolve a local tag once, then inspect the immutable identity returned by the daemon. */
export async function inspectBenchmarkImage(docker: Pick<Dockerode, 'listImages' | 'getImage'>) {
  const candidates = (await docker.listImages()).filter((entry) =>
    entry.RepoTags?.includes('agora-benchmark:task105'),
  );
  if (candidates.length !== 1 || !candidates[0] || !/^sha256:[a-f0-9]{64}$/.test(candidates[0].Id))
    throw new Error('benchmark image must resolve uniquely to a digest');
  const image = await docker.getImage(candidates[0].Id).inspect();
  if (image.Id !== candidates[0].Id) throw new Error('benchmark image identity drift');
  return image;
}
