import type { AgoraEvalTask } from '../../core/contracts';
import { HOLDOUTS, type HoldoutName } from '../../fixtures/phase10/holdout';
import { PUBLIC_NAMES, type PublicName, type Trial } from './accounting';
import { CONFIG } from './model-adapter';
import {
  activateTests,
  PUBLIC_REVISION,
  publicFiles,
  readPublicFile,
  sha256,
} from './public-adapter';
import { assertPublicContractSources, publicContractText } from './public-contracts';
import { EXECUTION_ENVIRONMENT, withExecutionEnvironment } from './task-environment';

export async function taskDefinition(trial: Trial, sources: string) {
  let goal: string, seed: Record<string, string>, revision: string, source: string;
  let files: readonly string[];
  let requirementUpdate: string | undefined, background: readonly string[] | undefined;
  if (trial.suite === 'public') {
    if (!PUBLIC_NAMES.includes(trial.task as PublicName)) throw new Error('invalid public task');
    const name = trial.task as PublicName;
    const input = await readPublicTaskSeed(name, sources);
    assertPublicContractSources(name, input.provenance);
    goal = publicTaskGoal(name, input.instructions);
    seed = {
      ...input.seed,
      'TASK.md': `${EXECUTION_ENVIRONMENT}\n\n${publicContractText(name)}\n\nOriginal upstream instructions (subject to the clarification above):\n${input.instructions.join('\n\n')}\n`,
    };
    revision = PUBLIC_REVISION;
    source = 'https://github.com/Aider-AI/polyglot-benchmark';
    files = [`${name}.js`];
  } else {
    if (!(trial.task in HOLDOUTS)) throw new Error('invalid holdout task');
    const holdout = HOLDOUTS[trial.task as HoldoutName];
    goal = withExecutionEnvironment(holdout.goal);
    seed = { 'TASK.md': `${goal}\n` };
    revision = sha256(JSON.stringify(holdout));
    source = 'Agora internal holdout, frozen before model exposure';
    files = holdout.files;
    background = holdout.background;
    if ('requirementUpdate' in holdout) requirementUpdate = holdout.requirementUpdate;
  }
  const task: AgoraEvalTask = {
    schemaVersion: 1,
    id: `phase10-${trial.task}`,
    version: trial.suite === 'public' ? '6' : '2',
    source,
    profiles: ['model', 'deterministic'],
    goal,
    repository: { fixture: trial.task, revision },
    ...(requirementUpdate
      ? { leaderEvents: [{ at: { kind: 'step' as const, value: 1 }, display: requirementUpdate }] }
      : {}),
    expectedOutcome: { assertions: ['independent-outcome'], requiredFiles: files },
    expectedInvariants: [
      'safety.cleanup',
      'safety.verifier-integrity',
      'model-routing',
      ...(trial.variant === 'single'
        ? ['single-safe-boundary']
        : [
            'completion-bound',
            'gate-released',
            'fixed-plan',
            ...(requirementUpdate ? ['requirement-applied'] : []),
            ...(trial.variant === 'sparse' ? ['context-policy-reached'] : []),
          ]),
    ],
    limits: {
      maxIterations: 8,
      maxDurationMs: CONFIG.maxDurationMs,
      maxModelCalls: CONFIG.maxCalls,
      maxToolCalls: CONFIG.maxTools,
      maxCostUsd: 2,
    },
  };
  return { task, seed, files, requirementUpdate, background };
}

/** Read only model-visible public inputs; verifier configuration and proof are excluded. */
export async function readPublicTaskSeed(name: PublicName, sources: string) {
  const paths = publicFiles(name)
    .filter((f) => f.audience === 'agent')
    .map((f) => f.path);
  paths.push(`${name}.spec.js`);
  const inputs = await Promise.all(
    paths.map(async (path) => ({ path, text: await readPublicFile(sources, name, path) })),
  );
  const get = (path: string) => {
    const input = inputs.find((f) => f.path === path);
    if (!input) throw new Error('missing public input');
    return input.text;
  };
  const instructions = inputs.filter((f) => f.path.endsWith('.md')).map((f) => f.text);
  return {
    instructions,
    provenance: inputs.map((f) => ({ path: f.path, sha256: sha256(f.text) })),
    seed: {
      [`${name}.js`]: get(`${name}.js`),
      [`${name}.spec.txt`]: activateTests(get(`${name}.spec.js`)),
      'package.json': '{"type":"module"}\n',
      'TASK.md': `${instructions.join('\n\n')}\n`,
    },
  };
}
export function publicTaskGoal(name: PublicName, instructions: readonly string[]): string {
  const plan = {
    version: 1,
    subtasks: [{ id: 'A', title: `Implement ${name}.js`, dependsOn: [] }],
  };
  return `${EXECUTION_ENVIRONMENT}\n\nBuild a modular API system implementing the following JavaScript exercise. Use exactly this executionPlan when planning: ${JSON.stringify(plan)}. No extra modules, server or CLI are needed.\n\n${publicContractText(name)}\n\nRoles with file tools should read the existing ${name}.js starter and ${name}.spec.txt to resolve interface ambiguities. All upstream cases have been activated without changing their assertions. Preserve the contract text file; its .txt extension keeps it out of the production Node test collector. Implement the named exports without changing the public API. The workspace package.json declares type=module so Node built-in *.test.mjs tests can import the original .js ESM file. Use no network or extra dependencies. The public Jest file is a readable contract; write your own Node tests for the production pipeline. An independent verifier uses its own unchanged copy of upstream tests and configuration, not files edited in your workspace. TESTER must commit cumulative Node built-in tests and run node --test --test-reporter=tap; REVIEWER reviews the tested artifact. Follow the normal Leader completion gate when using the multi-role system.\n\nOriginal upstream instructions (subject to the explicit public contract clarification above):\n${instructions.join('\n\n')}`;
}
