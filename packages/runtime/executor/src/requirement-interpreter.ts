import { randomUUID } from 'node:crypto';
import {
  normalizeRequirementInterpretation,
  type RequirementInterpretationInput,
  type RoleSpec,
} from '@agora/core-domain';
import type { RequirementInterpreter } from './base';
import { HarnessExecutor, type HarnessExecutorOptions } from './harness-executor';

const CONTRACT =
  'Return exactly one JSON object, no prose or markdown. Either {"kind":"proposal","summary":"human-readable explanation","changes":[{"requirementId":"existing or new safe ID","requirement":{"story":"complete story","acceptance":["complete criteria"],"nonGoals":["complete non-goals"]}}]}, or {"kind":"clarification","text":"question"}, or {"kind":"reply","text":"answer"}.';

/** Read-only interpretation of a single Leader input; no output mutation is committed. */
export class HarnessRequirementInterpreter implements RequirementInterpreter {
  constructor(
    private readonly model: string,
    private readonly options: HarnessExecutorOptions,
  ) {}

  async interpret(input: RequirementInterpretationInput & { projectId: string; taskId: string }) {
    const spec: RoleSpec = {
      role: 'COORDINATOR',
      executor: 'harness',
      model: this.model,
      tools: [],
      projection: [],
      routeWhen: 'never',
      systemPrompt:
        'You interpret a Leader message for a coding team. You have no tools and cannot execute or approve any action. ' +
        'Use only the supplied current structured requirements, decisions, goal and optional previous clarification/proposal. ' +
        'Write summary and clarification/reply text in the language of leaderInput.text, the latest Leader utterance. ' +
        'The goal, requirements and previous request may use another language: they must not determine the response language. ' +
        'Keep existing requirement wording in its original language so unchanged criteria are not unnecessarily translated. ' +
        'For an unambiguous requirement change, propose complete updated requirements including related acceptance expectations. ' +
        'Preserve unrelated constraints, acceptance criteria and non-goals. Do not revive withdrawn requirements. ' +
        'Do not hard-code example domains, numbers or IDs. Reuse existing IDs when changing existing requirements. ' +
        'If the requested target, units, scope or intent is ambiguous, ask a concise clarification question without proposing guessed changes. ' +
        'Ground the requested target and units in the current Leader text or the explicitly supplied previous clarification/proposal. ' +
        'A bare number with a pronoun, without that previous context, requires clarification even if one interpretation seems likely. ' +
        'Never infer a missing referent or unit from differences between the original goal and current requirements. The goal can be outdated; current requirements are authoritative. ' +
        'For conversation or unsupported actions (including completion approval, role management or decisions), answer or explain what is needed without claiming execution. ' +
        'The Leader must review and explicitly confirm proposals. Never say a proposed change is already applied. ' +
        CONTRACT,
    };
    const parse = (text: string | null) => {
      if (!text || text.length > 100_000) throw new Error('Invalid interpretation output');
      const fenced = /^```json\s*\n([\s\S]*?)```$/.exec(text.trim());
      return normalizeRequirementInterpretation(JSON.parse(fenced?.[1] ?? text));
    };
    const executor = new HarnessExecutor(spec, {
      ...this.options,
      tools: [],
      allowTools: [],
      outputFormatHint: CONTRACT,
      validateTurnOutput: ({ text }) => {
        parse(text);
      },
    });
    try {
      const result = await executor.step({
        sessionId: `leader-input:${input.sourceMsgId}:${randomUUID()}`,
        view: { role: 'COORDINATOR', slices: { leaderInput: structuredClone(input) } },
      });
      return parse(typeof result.output.text === 'string' ? result.output.text : null);
    } finally {
      await executor.dispose();
    }
  }
}
