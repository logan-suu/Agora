// Real managed pnpm/Node, HTTPS bytes and Seatbelt process supervision.
// The fixed authority seam qualifies offline installation mechanics only;
// canonical grant/download integration is independently covered by the grant suite.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { verifyToolchain } from '../../../apps/desktop/src/toolchain-installation';
import { LocalCommandBinding } from '../../../packages/runtime/sandbox/src/local-command-binding';
import { LocalCommandJournal } from '../../../packages/runtime/sandbox/src/local-command-journal';
import { buildLocalCommandPolicy } from '../../../packages/runtime/sandbox/src/local-command-policy';
import { runHeldLocalCommand } from '../../../packages/runtime/sandbox/src/local-command-start';
import { downloadLocalPackage } from '../../../packages/runtime/sandbox/src/local-download';
import { fixedAuthority } from './local-command-start-fixture';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
it('installs a pinned tarball with managed pnpm offline and builds/tests in a private copy', async () => {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = lstatSync(base);
  const tools = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
  const sources = [
    'tests/integration/phase12/phase12-3-installation.test.ts',
    'packages/runtime/sandbox/src/local-command-policy.ts',
    'packages/runtime/sandbox/src/local-command-start.ts',
    'packages/runtime/sandbox/src/local-command-binding.ts',
    'packages/runtime/sandbox/src/local-command-supervisor.ts',
    'packages/runtime/sandbox/src/local-command-stop.ts',
  ];
  const evidence: Record<string, unknown> = {
    base,
    identity: { dev: identity.dev, ino: identity.ino, uid: identity.uid },
    startedAt: new Date().toISOString(),
    os: execFileSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }),
    sources: Object.fromEntries(sources.map((path) => [path, hash(readFileSync(path))])),
    scope: 'Fixed installation mechanism qualification, not a completed product install port',
  };
  const initialEvidenceFolder = resolve('test-outputs/reviews/task123-installation-evidence');
  mkdirSync(initialEvidenceFolder, { recursive: true });
  writeFileSync(
    join(initialEvidenceFolder, `${base.split('-').at(-1)}.json`),
    JSON.stringify(evidence, null, 2),
  );
  let failure: unknown;
  try {
    evidence.toolchain = await verifyToolchain(tools);
    evidence.toolchainManifest = hash(readFileSync(join(tools, 'manifest.json')));
    const source = join(base, 'inputs'),
      outputRoot = join(base, 'output'),
      denied = join(base, 'private');
    const journalRoot = join(base, 'journal');
    for (const path of [source, outputRoot, denied, journalRoot]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(denied, 'credential'), 'fixed-secret');
    const bootstrap = join(base, 'bootstrap'),
      helper = join(base, 'control');
    for (const [name, destination] of [
      ['local-command-bootstrap', bootstrap],
      ['local-process-control', helper],
    ])
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        resolve(`packages/runtime/sandbox/native/${name}.c`),
        '-o',
        destination as string,
      ]);
    const downloaded = await downloadLocalPackage({
      url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
      integrity:
        'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
      policy: {
        mode: 'brokered-https',
        origins: ['https://registry.npmjs.org'],
        method: 'GET',
        maxBytes: 16777216,
        timeoutMs: 30000,
        maxRedirects: 3,
      },
      authorize: async () => {},
    });
    evidence.download = {
      sha256: downloaded.sha256,
      integrity: downloaded.integrity,
      byteLength: downloaded.bytes.length,
      hops: downloaded.hops,
    };
    writeFileSync(join(source, 'package.tgz'), downloaded.bytes, { mode: 0o400 });
    const executable = join(tools, 'node/bin/node');
    const pkg = {
      name: 'fixed-installation-fixture',
      version: '1.0.0',
      private: true,
      packageManager: 'pnpm@9.15.9',
      dependencies: { picocolors: `file:${join(source, 'package.tgz')}` },
      scripts: {
        postinstall: 'node install.cjs',
        build: 'node build.cjs',
        test: 'node --test test.cjs',
      },
    };
    writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(
      join(source, 'install.cjs'),
      `const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.throws(()=>fs.readFileSync(${JSON.stringify(join(denied, 'credential'))}), e=>['EPERM','EACCES'].includes(e.code)); assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(source, 'source.txt'))},'bad'), e=>['EPERM','EACCES'].includes(e.code)); assert.equal(process.env.AGORA_FIXED_FAKE_SECRET,undefined); fs.writeFileSync('installed','yes');`,
    );
    writeFileSync(
      join(source, 'build.cjs'),
      `const fs=require('node:fs'); const colors=require('picocolors'); fs.mkdirSync('dist'); fs.writeFileSync('dist/result.txt',colors.createColors(false).green('fixed output'));`,
    );
    writeFileSync(
      join(source, 'test.cjs'),
      `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('installed scripts and generated output',()=>{assert.equal(fs.readFileSync('installed','utf8'),'yes');assert.equal(fs.readFileSync('dist/result.txt','utf8'),'fixed output');assert.equal(require('picocolors/package.json').version,'1.1.1');});`,
    );
    writeFileSync(join(source, 'source.txt'), 'original source');
    const inputHashes = Object.fromEntries(
      readdirSync(source).map((name) => [name, hash(readFileSync(join(source, name)))]),
    );
    const driver = `const fs=require('node:fs'); const cp=require('node:child_process'); const path=require('node:path'); const source=${JSON.stringify(source)};for(const name of ['package.json','install.cjs','build.cjs','test.cjs','source.txt'])fs.copyFileSync(path.join(source,name),name);process.env.PATH=${JSON.stringify(join(tools, 'node/bin'))};process.env.CI='true';process.env.npm_config_shell_emulator='true';const manager=${JSON.stringify(join(tools, 'pnpm/bin/pnpm.cjs'))};for(const args of [['install','--offline','--no-frozen-lockfile','--store-dir',path.join(process.cwd(),'store'),'--cache-dir',path.join(process.cwd(),'cache'),'--package-import-method','copy'],['run','build'],['run','test']]){const result=cp.spawnSync(process.execPath,[manager,...args],{encoding:'utf8',env:process.env});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}`;
    const policy = buildLocalCommandPolicy({
      executable,
      bootstrap,
      sourceRoot: source,
      inputRoot: join(tools, 'pnpm'),
      outputRoot,
      deniedRoots: [denied, journalRoot],
    });
    const commandId = 'fixed-offline-install';
    const invocation = {
      commandId,
      executable,
      bootstrap,
      helper,
      argv: ['-e', driver],
      policy,
      outputRoot,
    };
    const authority = fixedAuthority();
    const binding = new LocalCommandBinding(
      invocation,
      [source, join(tools, 'pnpm'), outputRoot, denied, journalRoot],
      authority,
      () => authority,
    );
    const journal = new LocalCommandJournal(journalRoot, true);
    const reservation = journal.reserve({
      commandId,
      workspaceId: authority.workspaceId,
      policyHash: hash(policy),
      inputHash: hash(JSON.stringify({ invocation, inputHashes })),
      roots: [outputRoot],
    });
    evidence.policy = policy;
    evidence.inputHashes = inputHashes;
    const result = await runHeldLocalCommand({
      ...invocation,
      binding,
      journal,
      revision: reservation.revision,
      authorize: () => true,
      timeoutMs: 30000,
    });
    evidence.result = result;
    expect(result.error).toBeNull();
    expect(
      result.observation?.output.stderr.bytes.toString(),
      result.observation?.output.stdout.bytes.toString(),
    ).not.toContain('ERR_PNPM');
    expect(
      result.payloadResult,
      (result.observation?.output.stdout.bytes.toString() ?? '') +
        (result.observation?.output.stderr.bytes.toString() ?? ''),
    ).toEqual({ exitCode: 0, signal: null });
    expect(result.observation?.stop.registeredState).toBe('stopped');
    expect(readFileSync(join(outputRoot, 'dist/result.txt'), 'utf8')).toBe('fixed output');
    expect(
      Object.fromEntries(
        readdirSync(source).map((name) => [name, hash(readFileSync(join(source, name)))]),
      ),
    ).toEqual(inputHashes);
    expect(readFileSync(join(denied, 'credential'), 'utf8')).toBe('fixed-secret');
    expect(existsSync(join(source, 'node_modules'))).toBe(false);
  } catch (error) {
    failure = error;
    evidence.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  } finally {
    const entries: Record<string, string> = {};
    function inventory(path: string, prefix = '') {
      for (const name of readdirSync(path)) {
        const target = join(path, name),
          key = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(target);
        if (stat.isDirectory()) inventory(target, key);
        else if (stat.isFile()) entries[key] = hash(readFileSync(target));
      }
    }
    inventory(base);
    evidence.files = entries;
    const directory = resolve('test-outputs/reviews/task123-installation-evidence');
    mkdirSync(directory, { recursive: true });
    const report = join(directory, `${base.split('-').at(-1)}.json`);
    writeFileSync(report, JSON.stringify(evidence, null, 2));
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
      mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' }),
      current = lstatSync(base);
    if (
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      realpathSync(base) !== base
    ) {
      failure = new AggregateError(
        [failure, Error('installation_fixture_cleanup_unproven')].filter(Boolean),
        'installation_fixture_cleanup_unproven',
      );
      evidence.cleanup = { deleted: false, reason: 'identity_process_or_mount_unproven' };
    } else {
      const before = statfsSync(base);
      rmSync(base, { recursive: true });
      const after = statfsSync('/private/tmp');
      evidence.cleanup = {
        deleted: true,
        noHandles: true,
        noMounts: true,
        availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
      };
    }
    writeFileSync(report, JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
}, 60000);
