// Real Electron evaluates the production ESM entry before ready. An isolated appData
// directory and immediate ready-event exit prevent service or credential initialization.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('finishes evaluating the production entry before waiting for Electron ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-entrypoint-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const source = fileURLToPath(new URL('../src/', import.meta.url));
    for (const name of await readdir(source)) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const compiled = ts.transpileModule(await readFile(join(source, name), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      });
      await writeFile(join(root, name.replace(/\.ts$/, '.js')), compiled.outputText);
    }
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', main: 'probe.mjs' }),
    );
    await writeFile(
      join(root, 'before.mjs'),
      `import { app } from 'electron';
app.setPath('appData', ${JSON.stringify(root)});
process.send({ kind: 'before-entry', ready: app.isReady() });
const deadline = setTimeout(() => {
  process.send({ kind: 'deadline', ready: app.isReady() }, () => app.exit(2));
}, 3000);
app.once('ready', () => {
  clearTimeout(deadline);
  process.send({ kind: 'ready' }, () => app.exit(0));
});
`,
    );
    await writeFile(join(root, 'probe.mjs'), "import './before.mjs';\nimport './main.js';\n");
    const messages: unknown[] = [];
    child = spawn(createRequire(import.meta.url)('electron'), [root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('message', (message) => messages.push(message));
    const code = await new Promise((resolve, reject) => {
      child?.once('error', reject);
      child?.once('exit', resolve);
    });
    expect(messages[0]).toEqual({ kind: 'before-entry', ready: false });
    expect(messages).toContainEqual({ kind: 'ready' });
    expect(code).toBe(0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
