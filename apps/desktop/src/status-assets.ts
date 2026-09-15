import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function statusAssets(directory: string) {
  const files = new Map(
    (
      [
        ['status.html', 'text/html; charset=utf-8'],
        ['status.js', 'text/javascript; charset=utf-8'],
        ['status.css', 'text/css; charset=utf-8'],
      ] as const
    ).map(([name, type]) => {
      const path = join(directory, name);
      return [pathToFileURL(path).href, { path, type: type }] as const;
    }),
  );
  return {
    urls: new Set(files.keys()),
    page: pathToFileURL(join(directory, 'status.html')).href,
    async handle(request: Request): Promise<Response> {
      const file = files.get(request.url);
      if (request.method !== 'GET' || !file) return new Response(null, { status: 403 });
      return new Response(new Uint8Array(await readFile(file.path)), {
        headers: { 'Content-Type': file.type, 'X-Content-Type-Options': 'nosniff' },
      });
    },
  };
}
