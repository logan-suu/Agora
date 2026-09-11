import { posix } from 'node:path';

/** Docker Desktop listContainers exposes VM paths while inspect exposes host paths. */
export function mountBelongsToTask(
  source: string,
  taskRoot: string,
  platform = process.platform,
): boolean {
  const canonical = (value: string) => {
    let path = posix.normalize(value);
    if (platform === 'darwin') {
      if (path.startsWith('/host_mnt/')) path = path.slice('/host_mnt'.length);
      if (/^\/(var|tmp)(\/|$)/.test(path)) path = `/private${path}`;
    }
    return path;
  };
  if (!posix.isAbsolute(source) || !posix.isAbsolute(taskRoot)) return false;
  const path = canonical(source),
    root = canonical(taskRoot).replace(/\/$/, '');
  return root.length > 0 && (path === root || path.startsWith(`${root}/`));
}
