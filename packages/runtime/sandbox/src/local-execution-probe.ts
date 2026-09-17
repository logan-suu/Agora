/** Startup qualification runs only fixed trusted probes in owner-private roots.
 * Its receipt never authorizes a user project or replaces a live worker lease. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { LocalCommandBinding } from './local-command-binding';
import { LocalCommandJournal } from './local-command-journal';
import { buildLocalCommandPolicy } from './local-command-policy';
import { runHeldLocalCommand } from './local-command-start';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type { LocalCommandTools } from './local-workspace-commands';

export async function qualifyLocalExecution(
  owner: LocalRegistryOwner,
  objects: LocalControlObjects,
  tools: LocalCommandTools,
) {
  await owner.assertHeld();
  if (process.platform !== 'darwin' || arch() !== 'arm64') throw Error('sandbox_unavailable');
  const probeId = `probe:${randomUUID()}`;
  const base = join(owner.root, probeId);
  await mkdir(base, { mode: 0o700 });
  const input = join(base, 'input'),
    outputRoot = join(base, 'output'),
    dependencies = join(base, 'dependencies'),
    denied = join(base, 'private'),
    journalRoot = join(base, 'journal');
  for (const path of [input, outputRoot, dependencies, denied, journalRoot])
    await mkdir(path, { mode: 0o700 });
  await writeFile(join(input, 'readable'), 'fixed readable');
  await writeFile(join(denied, 'credential'), 'fixed private sentinel');
  const policy = buildLocalCommandPolicy({
    executable: tools.node.path,
    bootstrap: tools.bootstrap.path,
    sourceRoot: input,
    inputRoot: dependencies,
    outputRoot,
    deniedRoots: [denied, journalRoot],
  });
  const script = `const fs=require('node:fs');const assert=require('node:assert/strict');const net=require('node:net');const cp=require('node:child_process');const input=${JSON.stringify(input)};const denied=${JSON.stringify(denied)};assert.equal(fs.readFileSync(input+'/readable','utf8'),'fixed readable');assert.throws(()=>fs.writeFileSync(input+'/readable','bad'),e=>['EPERM','EACCES'].includes(e.code));assert.throws(()=>fs.readFileSync(denied+'/credential'),e=>['EPERM','EACCES'].includes(e.code));fs.writeFileSync('allowed','fixed output');assert.deepEqual(Object.keys(process.env).sort(),['HOME','LANG','LC_ALL','NODE_ENV','TMPDIR']);const child=cp.spawnSync(process.execPath,['-e',"require('node:assert/strict').throws(()=>require('node:fs').readFileSync("+JSON.stringify(denied+'/credential')+"),e=>['EPERM','EACCES'].includes(e.code))"],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const socket=net.connect({host:'127.0.0.1',port:9});socket.on('connect',()=>{throw Error('network unexpectedly allowed')});socket.on('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code),e.code);console.log('AGORA_LOCAL_PROBE_OK')});setTimeout(()=>{throw Error('network probe timeout')},1000).unref();`;
  const authority = {
    projectId: probeId,
    taskId: probeId,
    workspaceId: probeId,
    rootId: probeId,
    grantId: probeId,
    workerId: probeId,
    policyVersion: 'startup-probe-v1',
    grantRevision: 0,
    writerEpoch: 0,
    grantHash: localRecordHash({ probeId }),
    toolchainHash: localRecordHash(tools),
    networkHash: localRecordHash({ mode: 'disabled' }),
  };
  const invocation = {
    commandId: probeId,
    bootstrap: tools.bootstrap.path,
    executable: tools.node.path,
    helper: tools.processControl.path,
    argv: ['-e', script],
    policy,
    outputRoot,
  };
  const binding = new LocalCommandBinding(
    invocation,
    [input, outputRoot, dependencies, denied, journalRoot],
    authority,
    () => authority,
  );
  const binaries = binding.snapshot().tools;
  if (
    binaries[0]?.sha256 !== tools.bootstrap.sha256 ||
    binaries[1]?.sha256 !== tools.node.sha256 ||
    binaries[2]?.sha256 !== tools.processControl.sha256
  )
    throw Error('sandbox_unavailable');
  const journal = new LocalCommandJournal(journalRoot, true);
  const prepared = journal.reserve({
    commandId: probeId,
    workspaceId: probeId,
    policyHash: createHash('sha256').update(policy).digest('hex'),
    inputHash: localRecordHash({ tools, host: { arch: arch(), release: release() }, script }),
    roots: [outputRoot],
  });
  const result = await runHeldLocalCommand({
    ...invocation,
    binding,
    journal,
    revision: prepared.revision,
    timeoutMs: 5000,
    authorize: () => true,
    authorizeCurrent: async () => {
      await owner.assertHeld();
      return true;
    },
  });
  const passed =
    result.error === null &&
    result.payloadResult?.exitCode === 0 &&
    result.launchDurable &&
    result.observation?.durable === true &&
    result.observation.stop.registeredState === 'stopped' &&
    !result.observation.discoveryFailed &&
    result.observation.bindingFailure === null &&
    !result.observation.output.stdout.truncated &&
    !result.observation.output.stderr.truncated &&
    result.observation.output.stdout.error === null &&
    result.observation.output.stderr.error === null &&
    result.observation.output.stdout.bytes.toString() === 'AGORA_LOCAL_PROBE_OK\n' &&
    (await readFile(join(input, 'readable'), 'utf8')) === 'fixed readable' &&
    (await readFile(join(denied, 'credential'), 'utf8')) === 'fixed private sentinel';
  const receipt = {
    schemaVersion: 'local-execution-probe-v1',
    probeId,
    passed,
    host: { platform: process.platform, arch: arch(), release: release() },
    toolchainHash: localRecordHash(tools),
    policyHash: prepared.policyHash,
    recordHash: await objects.put(journal.snapshot()),
    result: {
      error: result.error,
      payloadResult: result.payloadResult,
      stdoutHash: await objects.putBytes(
        result.observation?.output.stdout.bytes ?? Buffer.alloc(0),
      ),
      stderrHash: await objects.putBytes(
        result.observation?.output.stderr.bytes ?? Buffer.alloc(0),
      ),
    },
    rootIdentity: `${(await lstat(base)).dev}:${(await lstat(base)).ino}`,
  };
  const receiptHash = await objects.put(receipt);
  await owner.assertHeld();
  if (!passed) throw Error(`sandbox_unavailable:${receiptHash}`);
  return { receiptHash, toolchainHash: receipt.toolchainHash, host: receipt.host };
}
