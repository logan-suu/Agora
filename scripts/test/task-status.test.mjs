import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { query, validateIndex } from '../task-status.mjs';

function fixture() {
  return {
    current_phase: 1,
    last_updated: '2026-09-13',
    standing_decisions: [{ id: 'D1', rule: 'Projection only.', source: 'docs/spec.md §1' }],
    milestones: [{ id: 'M0', status: 'pending' }],
    phases: [
      {
        id: 0,
        status: 'done',
        name: 'Foundation',
        integration_test: '0.1',
        exit_criteria: ['Real execution'],
        tasks: [
          { id: '0.1', title: 'Foundation', status: 'done', dependencies: [], notes: 'Evidence.' },
        ],
      },
      {
        id: 1,
        status: 'in_progress',
        name: 'Next',
        integration_test: '1.2',
        exit_criteria: ['Acceptance'],
        tasks: [
          {
            id: '1.1',
            title: 'Implement',
            status: 'pending',
            dependencies: ['0.1'],
            notes: 'Not started.',
          },
          {
            id: '1.2',
            title: 'Exit',
            status: 'pending',
            dependencies: ['1.1'],
            notes: 'Not started.',
          },
        ],
      },
    ],
  };
}

test('summary reports readiness without mutating canonical state or dumping history', async () => {
  const d = fixture();
  const before = JSON.stringify(d);
  const result = await query(d, ['summary']);
  assert.deepEqual(result.cascadeCandidates, ['1.1']);
  assert.equal(result.counts.done, 1);
  assert.equal(result.nextReady, null);
  assert.equal(JSON.stringify(d), before);
  assert.equal(JSON.stringify(result).includes('Evidence.'), false);
  assert.deepEqual(result.incompleteMilestones, [{ id: 'M0', status: 'pending' }]);
});

test('task returns dependencies, previous phase gate, and history path', async () => {
  const d = fixture();
  const result = await query(d, ['task', '1.1']);
  assert.equal(result.dependencies[0].status, 'done');
  assert.equal(result.previousPhaseGate.status, 'done');
  assert.equal(result.historyPath, 'docs/task-history/1.1.md');
  d.phases[0].tasks[0].status = 'in_progress';
  assert.equal((await query(d, ['task', '1.1'])).previousPhaseGate.status, 'in_progress');
  assert.deepEqual((await query(d, ['summary'])).cascadeCandidates, []);
});

test('phase and decision selection are explicit; unknown or extra arguments fail', async () => {
  const d = fixture();
  assert.equal((await query(d, ['phase', '0'])).tasks.length, 1);
  assert.equal((await query(d, ['decisions', 'D1']))[0].source, 'docs/spec.md §1');
  for (const args of [
    ['task', '../secret'],
    ['task', '9.9'],
    ['phase', '2'],
    ['decisions', 'D2'],
    ['summary', 'all'],
    ['check', 'extra'],
    ['unknown'],
  ]) {
    await assert.rejects(query(d, args));
  }
});

test('invalid dependency graphs and oversized summaries fail explicitly', () => {
  const missing = fixture();
  missing.phases[1].tasks[0].dependencies = ['9.9'];
  assert.throws(() => validateIndex(missing), /Unknown dependency/);
  const cycle = fixture();
  cycle.phases[1].tasks[0].dependencies = ['1.2'];
  assert.throws(() => validateIndex(cycle), /cycle/);
  const duplicate = fixture();
  duplicate.phases[1].tasks[0].id = '0.1';
  assert.throws(() => validateIndex(duplicate));
  const long = fixture();
  long.phases[0].tasks[0].notes = 'x'.repeat(801);
  assert.throws(() => validateIndex(long), /notes/);
  const noPhase = fixture();
  noPhase.current_phase = 9;
  assert.throws(() => validateIndex(noPhase), /current_phase/);
});

test('history is bounded, paginated, Unicode-safe and read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-tracking-query-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'docs/task-history'), { recursive: true });
    const path = join(root, 'docs/task-history/1.1.md');
    const body = '头🙂中间尾';
    await writeFile(path, body);
    const first = await query(fixture(), ['history', '1.1', '--offset', '0', '--limit', '2'], root);
    assert.equal(first.text, '头🙂');
    assert.equal(first.nextOffset, 2);
    assert.equal(first.omittedAfter, 3);
    const tail = await query(fixture(), ['history', '1.1', '--limit', '2'], root);
    assert.equal(tail.text, '间尾');
    assert.equal(tail.omittedBefore, 3);
    assert.equal(tail.nextOffset, null);
    assert.equal(await readFile(path, 'utf8'), body);
    for (const args of [
      ['history', '1.1', '--limit', '0'],
      ['history', '1.1', '--limit', '12001'],
      ['history', '1.1', '--offset', '-1'],
      ['history', '1.1', '--offset', '999'],
      ['history', '1.1', '--limit', '2', '--limit', '3'],
      ['history', '1.1', '--all'],
      ['history', '0.1'],
    ])
      await assert.rejects(query(fixture(), args, root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('check verifies independent migrated-note identities and rejects missing or altered evidence', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir } = await import('node:fs/promises');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const root = await mkdtemp(join(tmpdir(), 'agora-tracking-check-'));
  try {
    await mkdir(join(root, 'docs/task-history'), { recursive: true });
    const d = fixture();
    d.phases[0].tasks[0].notes = 'Evidence: docs/task-history/0.1.md';
    const original = 'Passed after a recorded failure.\nLiteral \\n retained.';
    const hash = sha(original);
    const body = `Original notes SHA-256: \`${hash}\`\n<!-- BEGIN ARCHIVED NOTES -->\n${original}\n<!-- END ARCHIVED NOTES -->\n`;
    const path = join(root, 'docs/task-history/0.1.md');
    const manifest = { 0.1: hash };
    await writeFile(
      join(root, 'docs/task-history/standing-decisions-2026-09-13.json'),
      JSON.stringify({
        decisions: d.standing_decisions,
        sha256: sha(JSON.stringify(d.standing_decisions)),
        notesSha256: manifest,
        notesManifestSha256: sha(JSON.stringify(manifest)),
      }),
    );
    await writeFile(path, body);
    assert.equal((await query(d, ['check'], root)).histories, 1);
    await writeFile(path, `${body}\nNew checkpoint appended.`);
    assert.equal((await query(d, ['check'], root)).valid, true);
    await writeFile(path, body.replace('recorded failure', 'unrecorded failure'));
    await assert.rejects(query(d, ['check'], root), /hash mismatch/);
    await writeFile(path, 'Archive markers removed.');
    await assert.rejects(query(d, ['check'], root), /archive markers/);
    await writeFile(path, body);
    d.phases[0].tasks[0].notes = 'History reference removed.';
    await assert.rejects(query(d, ['check'], root), /Missing migrated history reference/);
    d.phases[0].tasks[0].notes = 'docs/task-history/0.1.md docs/task-history/1.1.md';
    await assert.rejects(query(d, ['check'], root), /identity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI finds the canonical repository from another working directory', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../task-status.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'summary'], {
    cwd: tmpdir(),
  });
  const summary = JSON.parse(stdout);
  assert.equal(typeof summary.current_phase.id, 'number');
  assert.equal(Array.isArray(summary.decisionIds), true);
  await assert.rejects(
    promisify(execFile)(process.execPath, [cli, 'task', '../../secret']),
    (error) => error.code === 1 && error.stdout === '' && error.stderr.includes('Unknown task'),
  );
});
