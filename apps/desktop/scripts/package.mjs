import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { packager } from '@electron/packager';
import { auditResources, copyTracedFile, reviewTraceFile } from '../dist/build-resources.js';
import { inventoryToolchain } from '../dist/toolchain-installation.js';
import { toolVersions } from '../dist/toolchains.js';
import { signValidationBundle } from './sign.mjs';

const [sourceArg, nodeArg, zipArg, outputArg, gitArg, pnpmArg, arch] = process.argv.slice(2);
if (!outputArg || !gitArg || !pnpmArg || !['arm64', 'x64'].includes(arch) || arch !== process.arch)
  throw new Error(
    'Usage: package.mjs <clean-source> <node-distribution> <electron-zip-directory> <new-output> <git-distribution> <pnpm-distribution> <native-arch>',
  );
const source = await realpath(resolve(sourceArg)),
  node = resolve(nodeArg),
  zip = resolve(zipArg),
  output = resolve(outputArg);
await mkdir(output);
const stage = join(output, 'stage');
await mkdir(stage);
const service = join(stage, 'service');
await mkdir(service);
const web = join(source, 'apps/web');
const require = createRequire(join(web, 'package.json'));
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const files = new Set();
for (const name of await readdir(join(web, '.next'), { recursive: true })) {
  if (!name.endsWith('.nft.json')) continue;
  const trace = join(web, '.next', name);
  for (const file of JSON.parse(await readFile(trace, 'utf8')).files)
    files.add(resolve(dirname(trace), file));
}
const customEntries = [
  'next',
  'next/dist/compiled/webpack/webpack-lib',
  'next/dist/compiled/@babel/runtime/package.json',
  'react',
  'react-dom',
  'dockerode',
  '@deepseek-ai/dsh-llm-pi-ai',
].map((name) => require.resolve(name));
const webpackRoot = dirname(require.resolve('next/dist/compiled/webpack/webpack'));
for (const name of await readdir(webpackRoot)) {
  if (name.endsWith('.js')) customEntries.push(join(webpackRoot, name));
}
const traced = await nodeFileTrace(customEntries, { base: source, processCwd: web });
for (const name of traced.fileList) files.add(join(source, name));
const excluded = [];
for (const file of files) {
  const name = relative(source, file);
  const classification = reviewTraceFile(name);
  if (classification !== 'runtime') {
    excluded.push({ path: name, reason: classification });
    files.delete(file);
  }
}
await writeFile(join(output, 'trace-review.json'), JSON.stringify({ excluded }, null, 2));
for (const file of [...files]) {
  if (!file.endsWith('/package.json')) continue;
  for (const name of await readdir(dirname(file))) {
    if (
      /^(license|licence|notice|copying|copyright)(\.|$)/i.test(name) &&
      (await lstat(join(dirname(file), name))).isFile()
    )
      files.add(join(dirname(file), name));
  }
}
// Copy real targets first so pnpm directory symlinks resolve during validation.
const ordered = await Promise.all(
  [...files].map(async (file) => ({ file, link: (await lstat(file)).isSymbolicLink() })),
);
for (const { file } of ordered.sort((a, b) => Number(a.link) - Number(b.link)))
  await copyTracedFile(source, service, file);
const required = JSON.parse(await readFile(join(web, '.next/required-server-files.json'), 'utf8'));
for (const name of required.files) await copyTracedFile(source, service, resolve(web, name));
for (const name of [
  'BUILD_ID',
  'app-build-manifest.json',
  'app-path-routes-manifest.json',
  'build-manifest.json',
  'package.json',
  'react-loadable-manifest.json',
])
  await copyTracedFile(source, service, join(web, '.next', name));
for (const directory of ['server', 'static']) {
  const root = join(web, '.next', directory);
  for (const name of await readdir(root, { recursive: true })) {
    const path = join(root, name);
    if ((await lstat(path)).isFile() && !name.endsWith('.nft.json'))
      await copyTracedFile(source, service, path);
  }
}
for (const name of ['package.json', 'scripts/local-process.mjs'])
  await copyTracedFile(source, service, join(web, name));
const dist = join(source, 'apps/desktop/dist');
for (const name of [
  'service.js',
  'service-entry.js',
  'protocol.js',
  'preview-server.js',
  'storage.js',
  'upgrades.js',
  'upgrade-files.js',
  'toolchain-installation.js',
  'toolchains.js',
])
  await copyTracedFile(source, service, join(dist, name));
await copyTracedFile(source, service, join(source, 'apps/desktop/package.json'));
const appSource = join(stage, 'app');
await mkdir(join(appSource, 'dist'), { recursive: true });
for (const name of [
  'main.js',
  'desktop-app.js',
  'preload.cjs',
  'protocol.js',
  'service-lifecycle.js',
  'window-security.js',
  'toolchain-installation.js',
  'toolchains.js',
])
  await cp(join(dist, name), join(appSource, 'dist', name));
await cp(join(source, 'apps/desktop/ui'), join(appSource, 'ui'), { recursive: true });
await writeFile(
  join(appSource, 'package.json'),
  JSON.stringify({ name: 'agora-desktop', version: '0.0.0', type: 'module', main: 'dist/main.js' }),
);
const tools = join(stage, `toolchains/darwin-${arch}`);
await mkdir(tools, { recursive: true });
await cp(node, join(tools, 'node'), { recursive: true, verbatimSymlinks: true });
await cp(join(source, `packages/runtime/state/build/keychain-${arch}`), join(tools, 'keychain'));
await cp(
  join(source, `packages/runtime/sandbox/build/secure-files-darwin-${arch}`),
  join(tools, 'secure-files'),
);
await cp(resolve(gitArg), join(tools, 'git'), { recursive: true, verbatimSymlinks: true });
await cp(resolve(pnpmArg), join(tools, 'pnpm'), { recursive: true, verbatimSymlinks: true });
await mkdir(join(tools, 'bin'));
await symlink('../node/bin/node', join(tools, 'bin/node'));
for (const [name, script] of [
  ['pnpm', 'pnpm/bin/pnpm.cjs'],
  ['npm', 'node/lib/node_modules/npm/bin/npm-cli.js'],
  ['npx', 'node/lib/node_modules/npm/bin/npx-cli.js'],
]) {
  // A relative launcher selects the bundled Node even under an empty host PATH.
  await writeFile(
    join(tools, 'bin', name),
    `#!/bin/sh
base="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$base/node/bin/node" "$base/${script}" "$@"
`,
    { mode: 0o755 },
  );
}
await writeFile(
  join(tools, 'SOURCES.json'),
  JSON.stringify(
    {
      node: 'https://nodejs.org/dist/v24.20.0/',
      git: 'https://github.com/desktop/dugite-native/tree/4098283',
      pnpm: 'https://github.com/pnpm/pnpm/tree/v9.15.9',
      helperSource: [
        'packages/runtime/sandbox/native/secure-files.c',
        'packages/runtime/state/native/keychain.c',
      ],
    },
    null,
    2,
  ),
);

await writeFile(
  join(output, 'service-manifest.json'),
  JSON.stringify(await auditResources(service), null, 2),
);
await auditResources(stage);
const apps = await packager({
  dir: appSource,
  out: join(output, 'app'),
  platform: 'darwin',
  arch,
  name: 'Agora',
  executableName: 'Agora',
  appBundleId: 'com.agora.desktop',
  electronVersion: '44.3.0',
  electronZipDir: zip,
  asar: true,
  asarIntegrityDigest: true,
  prune: false,
  extendInfo: { LSMinimumSystemVersion: '15.0' },
});
const app = join(apps[0], 'Agora.app');
// Packager's extraResource copy expands relative symlinks to absolute staging paths.
// Copy the audited resources with verbatim relative links before sealing the bundle.
for (const name of ['service', 'toolchains'])
  await cp(join(stage, name), join(app, 'Contents/Resources', name), {
    recursive: true,
    verbatimSymlinks: true,
  });
await auditResources(join(app, 'Contents/Resources'));
await flipFuses(app, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
// Ad-hoc validation only; signed release media and notarization belong to 11.4/11.5.
await signValidationBundle(app, async () => {
  const root = join(app, 'Contents/Resources/toolchains', `darwin-${arch}`);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        format: 1,
        platform: 'darwin',
        arch,
        versions: toolVersions,
        files: await inventoryToolchain(root),
      },
      null,
      2,
    ),
  );
});
const manifest = await auditResources(join(app, 'Contents/Resources'));
await writeFile(join(output, 'resource-manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(
  join(output, 'package-result.json'),
  JSON.stringify(
    {
      app,
      arch,
      minimumSystem: '15.0',
      signing: 'ad-hoc-validation-only',
      fuses: await getCurrentFuseWire(app),
      resources: manifest.length,
      bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    null,
    2,
  ),
);
console.log(`PACKAGED_APP=${app}`);
