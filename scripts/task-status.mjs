import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const states = ['pending', 'ready', 'in_progress', 'blocked', 'done'];
const count = (value) => [...value].length;
const historyPath = (id) => `docs/task-history/${id}.md`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function validateIndex(data) {
  requireValue(Array.isArray(data.phases) && data.phases.length > 0, 'Missing phases');
  const tasks = new Map();
  const phases = new Map();
  for (const phase of data.phases) {
    requireValue(
      Number.isSafeInteger(phase.id) && phase.id >= 0 && !phases.has(phase.id),
      'Invalid or duplicate phase id',
    );
    requireValue(
      ['not_started', 'in_progress', 'done'].includes(phase.status),
      `Invalid phase status: ${phase.id}`,
    );
    requireValue(Array.isArray(phase.tasks), `Missing tasks: ${phase.id}`);
    phases.set(phase.id, phase);
    for (const task of phase.tasks) {
      requireValue(
        typeof task.id === 'string' && /^\d+\.\d+$/.test(task.id) && !tasks.has(task.id),
        `Invalid or duplicate task id: ${task.id}`,
      );
      requireValue(Number(task.id.split('.')[0]) === phase.id, `Task phase mismatch: ${task.id}`);
      requireValue(states.includes(task.status), `Invalid task status: ${task.id}`);
      requireValue(
        Array.isArray(task.dependencies) &&
          new Set(task.dependencies).size === task.dependencies.length,
        `Invalid dependencies: ${task.id}`,
      );
      requireValue(
        typeof task.notes === 'string' && count(task.notes) <= 800,
        `Invalid or oversized notes: ${task.id}`,
      );
      tasks.set(task.id, task);
    }
  }
  requireValue(phases.has(data.current_phase), 'Unknown current_phase');
  for (const phase of phases.values()) {
    requireValue(
      phase.id === 0 || phases.has(phase.id - 1),
      `Missing preceding phase: ${phase.id}`,
    );
    requireValue(
      phase.tasks.some((task) => task.id === phase.integration_test),
      `Invalid integration_test: ${phase.id}`,
    );
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    requireValue(tasks.has(id), `Unknown dependency: ${id}`);
    requireValue(!visiting.has(id), `Dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  requireValue(Array.isArray(data.standing_decisions), 'Missing standing_decisions');
  const decisions = new Map();
  for (const decision of data.standing_decisions) {
    requireValue(
      typeof decision.id === 'string' && decision.id.length > 0 && !decisions.has(decision.id),
      'Invalid or duplicate decision id',
    );
    requireValue(
      typeof decision.rule === 'string' && count(decision.rule) <= 500 && decision.rule.length > 0,
      `Invalid decision rule: ${decision.id}`,
    );
    requireValue(
      typeof decision.source === 'string' && decision.source.length > 0,
      `Missing decision source: ${decision.id}`,
    );
    decisions.set(decision.id, decision);
  }
  return { tasks, phases, decisions };
}

const counts = (tasks) =>
  Object.fromEntries(
    states.map((state) => [state, tasks.filter((task) => task.status === state).length]),
  );
const brief = ({ id, title, status, dependencies, last_updated }) => ({
  id,
  title,
  status,
  dependencies,
  last_updated,
});

export async function query(data, args = [], repo = root) {
  const { tasks, phases, decisions } = validateIndex(data);
  const [command = 'summary', ...rest] = args;
  const all = [...tasks.values()];
  const current = phases.get(data.current_phase);
  const getTask = (id) => {
    requireValue(tasks.has(id), `Unknown task: ${id}`);
    return tasks.get(id);
  };
  switch (command) {
    case 'summary': {
      requireValue(rest.length === 0, 'Usage: summary');
      const { tasks: phaseTasks, ...phase } = current;
      return {
        last_updated: data.last_updated,
        current_phase: phase,
        counts: counts(all),
        currentPhaseCounts: counts(phaseTasks),
        inProgress: all.filter((task) => task.status === 'in_progress').map(brief),
        blocked: all.filter((task) => task.status === 'blocked').map(brief),
        nextReady: phaseTasks.filter((task) => task.status === 'ready').map(brief)[0] ?? null,
        cascadeCandidates: all
          .filter(
            (task) =>
              task.status === 'pending' &&
              task.dependencies.every((id) => tasks.get(id).status === 'done'),
          )
          .map((task) => task.id),
        incompleteMilestones: data.milestones.filter((milestone) => milestone.status !== 'done'),
        decisionIds: [...decisions.keys()],
      };
    }
    case 'task': {
      requireValue(rest.length === 1, 'Usage: task <id>');
      const task = getTask(rest[0]);
      const phase = phases.get(Number(task.id.split('.')[0]));
      const previous = phases.get(phase.id - 1);
      return {
        task,
        dependencies: task.dependencies.map((id) => brief(tasks.get(id))),
        phase: {
          id: phase.id,
          status: phase.status,
          integration_test: phase.integration_test,
          exit_criteria: phase.exit_criteria,
        },
        previousPhaseGate: previous ? brief(tasks.get(previous.integration_test)) : null,
        historyPath: historyPath(task.id),
      };
    }
    case 'phase': {
      requireValue(
        rest.length === 1 && /^(0|[1-9]\d*)$/.test(rest[0]) && phases.has(Number(rest[0])),
        'Usage: phase <known integer id>',
      );
      const phase = phases.get(Number(rest[0]));
      return { ...phase, tasks: phase.tasks.map(brief) };
    }
    case 'decisions':
      return (rest.length ? rest : [...decisions.keys()]).map((id) => {
        requireValue(decisions.has(id), `Unknown decision: ${id}`);
        return decisions.get(id);
      });
    case 'history': {
      const task = getTask(rest[0]);
      const flags = new Map();
      for (let i = 1; i < rest.length; i += 2) {
        const [flag, value] = rest.slice(i, i + 2);
        requireValue(
          ['--offset', '--limit'].includes(flag) && !flags.has(flag) && /^\d+$/.test(value ?? ''),
          'Usage: history <id> [--offset N] [--limit N]',
        );
        requireValue(Number.isSafeInteger(Number(value)), 'Invalid history number');
        flags.set(flag, Number(value));
      }
      const limit = flags.get('--limit') ?? 6000;
      requireValue(limit >= 1 && limit <= 12000, 'History limit must be 1..12000');
      const text = [...(await readFile(resolve(repo, historyPath(task.id)), 'utf8'))];
      const offset = flags.get('--offset') ?? Math.max(0, text.length - limit);
      requireValue(offset <= text.length, 'History offset exceeds length');
      const end = Math.min(text.length, offset + limit);
      return {
        path: historyPath(task.id),
        totalCharacters: text.length,
        offset,
        omittedBefore: offset,
        omittedAfter: text.length - end,
        previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
        nextOffset: end < text.length ? end : null,
        text: text.slice(offset, end).join(''),
      };
    }
    case 'check': {
      requireValue(rest.length === 0, 'Usage: check');
      const archive = JSON.parse(
        await readFile(
          resolve(repo, 'docs/task-history/standing-decisions-2026-09-13.json'),
          'utf8',
        ),
      );
      requireValue(
        sha256(JSON.stringify(archive.decisions)) === archive.sha256,
        'Decision archive hash mismatch',
      );
      requireValue(
        archive.notesSha256 &&
          sha256(JSON.stringify(archive.notesSha256)) === archive.notesManifestSha256,
        'Notes manifest hash mismatch',
      );
      for (const id of Object.keys(archive.notesSha256)) {
        requireValue(
          tasks.has(id) && tasks.get(id).notes.includes(historyPath(id)),
          `Missing migrated history reference: ${id}`,
        );
      }
      let histories = 0;
      for (const task of all) {
        const references = task.notes.match(/docs\/task-history\/[^\s；。)]+\.md/g) ?? [];
        for (const reference of references) {
          requireValue(reference === historyPath(task.id), `History identity mismatch: ${task.id}`);
          const body = await readFile(resolve(repo, reference), 'utf8');
          const start = '<!-- BEGIN ARCHIVED NOTES -->\n';
          const finish = '\n<!-- END ARCHIVED NOTES -->';
          if (
            archive.notesSha256[task.id] ||
            body.includes('<!-- BEGIN ARCHIVED NOTES') ||
            body.includes('<!-- END ARCHIVED NOTES') ||
            body.includes('Original notes SHA-256:')
          ) {
            const hash = body.match(/Original notes SHA-256: `([a-f0-9]{64})`/);
            requireValue(
              hash && body.split(start).length === 2 && body.split(finish).length === 2,
              `Invalid archive markers: ${task.id}`,
            );
            const original = body.split(start)[1].split(finish)[0];
            requireValue(
              sha256(original) === hash[1] &&
                (!archive.notesSha256[task.id] || hash[1] === archive.notesSha256[task.id]),
              `Archive hash mismatch: ${task.id}`,
            );
          }
          histories += 1;
        }
      }

      return {
        valid: true,
        tasks: tasks.size,
        phases: phases.size,
        decisions: decisions.size,
        histories,
      };
    }
    default:
      throw new Error(
        'Use summary, task <id>, phase <id>, decisions [id ...], history <id> [--offset N] [--limit N], or check.',
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const data = JSON.parse(await readFile(resolve(root, 'docs/task-status.json'), 'utf8'));
    console.log(JSON.stringify(await query(data, process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`Task status: ${error.message}`);
    process.exitCode = 1;
  }
}
