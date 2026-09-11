// Docker API metadata is scripted to exercise identity failures without allocating containers.
import type { Dockerode } from '@agora/runtime-sandbox';
import { expect, it, vi } from 'vitest';
import { inspectBenchmarkImage } from './benchmark-image';

const id = `sha256:${'1'.repeat(64)}`;
function fixture(count: number, inspected = id) {
  const getImage = vi.fn(() => ({ inspect: async () => ({ Id: inspected }) }));
  const docker = {
    listImages: async () =>
      Array.from({ length: count }, () => ({ Id: id, RepoTags: ['agora-benchmark:task105'] })),
    getImage,
  };
  return { docker: docker as unknown as Dockerode, getImage };
}
it('inspects the unique digest without querying the tag endpoint', async () => {
  const { docker, getImage } = fixture(1);
  expect((await inspectBenchmarkImage(docker)).Id).toBe(id);
  expect(getImage).toHaveBeenCalledWith(id);
});
it('rejects missing, ambiguous and changed image identities', async () => {
  for (const count of [0, 2]) {
    const { docker, getImage } = fixture(count);
    await expect(inspectBenchmarkImage(docker)).rejects.toThrow('uniquely');
    expect(getImage).not.toHaveBeenCalled();
  }
  await expect(
    inspectBenchmarkImage(fixture(1, `sha256:${'2'.repeat(64)}`).docker),
  ).rejects.toThrow('drift');
});
