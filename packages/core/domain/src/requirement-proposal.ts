import { normalizePhase9LeaderIntent, type RequirementChange } from './leader-directive';
import type { Mutation } from './reducer';
import type { AppState, Message } from './state';

export type RequirementInterpretation =
  | { kind: 'proposal'; summary: string; changes: RequirementChange[] }
  | { kind: 'clarification' | 'reply'; text: string };

export interface RequirementInterpretationInput {
  sourceMsgId: string;
  text: string;
  goal: string;
  requirements: AppState['requirements'];
  decisions: AppState['decisionLedger'];
  previous?: { request: string; result: RequirementInterpretation };
}

export interface RequirementProposalView {
  proposalId: string;
  sourceMsgId: string;
  summary: string;
  status: 'pending' | 'stale';
  changes: {
    requirementId: string;
    before: RequirementChange['requirement'] | null;
    after: RequirementChange['requirement'];
  }[];
}

export function normalizeRequirementInterpretation(value: unknown): RequirementInterpretation {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid requirement interpretation');
  const v = value as Record<string, unknown>;
  if (v.kind === 'proposal') {
    exactKeys(v, ['kind', 'summary', 'changes']);
    const intent = normalizePhase9LeaderIntent({
      kind: 'requirements_change',
      changes: v.changes as RequirementChange[],
    });
    if (intent.kind !== 'requirements_change') throw new Error('Invalid requirement changes');
    return { kind: 'proposal', summary: text(v.summary), changes: intent.changes };
  }
  if (v.kind === 'clarification' || v.kind === 'reply') {
    exactKeys(v, ['kind', 'text']);
    return { kind: v.kind, text: text(v.text) };
  }
  throw new Error('Unknown requirement interpretation');
}

export function requirementBasis(state: AppState): string {
  return JSON.stringify({
    requirements: [...state.requirements].sort((a, b) => a.id.localeCompare(b.id)),
    decisions: state.decisionLedger,
  });
}

export function latestRequirementInterpretation(state: AppState): Message | undefined {
  return [...state.messages]
    .reverse()
    .find((m) => m.payload.kind === 'leader_requirement_interpretation');
}

export function readRequirementInterpretation(state: AppState, message: Message) {
  const p = message.payload;
  const source = state.messages.find((m) => m.msgId === p.sourceMsgId);
  if (
    message.channelId !== 'main' ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'chat' ||
    p.kind !== 'leader_requirement_interpretation' ||
    typeof p.basis !== 'string' ||
    !source ||
    source.fromRole !== 'leader' ||
    source.channelId !== 'main' ||
    source.payload.kind !== 'leader_intent' ||
    (source.payload.intent as { kind?: unknown })?.kind !== 'chat' ||
    (source.payload.intent as { text?: unknown })?.text !== source.display ||
    source.payload.requirementProposalId !== undefined ||
    message.msgId !== `requirement-proposal:${source.msgId}` ||
    state.messages.indexOf(source) >= state.messages.indexOf(message)
  )
    throw new Error('Invalid requirement proposal provenance');
  const result = normalizeRequirementInterpretation(p.result);
  if (message.display !== (result.kind === 'proposal' ? result.summary : result.text))
    throw new Error('Invalid requirement proposal display');
  readBasis(p.basis);
  return { source, basis: p.basis, result };
}

export function requirementProposalResolution(
  state: AppState,
  proposal: Message,
): Message | undefined {
  const result = readRequirementInterpretation(state, proposal).result;
  const resolutions = state.messages.filter(
    (m) => m.payload.requirementProposalId === proposal.msgId,
  );
  if (resolutions.length > 1) throw new Error('Conflicting requirement proposal resolutions');
  const message = resolutions[0];
  if (!message) return undefined;
  const p = message.payload;
  const intent = p.intent as { kind?: unknown; text?: unknown } | undefined;
  const status = (p.action as { status?: unknown } | undefined)?.status;
  if (
    result.kind !== 'proposal' ||
    message.fromRole !== 'leader' ||
    message.channelId !== 'main' ||
    message.type !== 'chat' ||
    p.kind !== 'leader_intent' ||
    state.messages.indexOf(message) <= state.messages.indexOf(proposal)
  )
    throw new Error('Invalid requirement proposal resolution');
  if (p.requirementProposalAction === 'dismiss') {
    if (status !== 'none' || intent?.kind !== 'chat' || intent.text !== message.display)
      throw new Error('Invalid requirement proposal dismissal');
  } else if (p.requirementProposalAction === 'confirm') {
    if (
      status !== 'applied' ||
      JSON.stringify(
        normalizePhase9LeaderIntent(p.intent as Parameters<typeof normalizePhase9LeaderIntent>[0]),
      ) !== JSON.stringify({ kind: 'requirements_change', changes: result.changes })
    )
      throw new Error('Invalid requirement proposal confirmation');
  } else throw new Error('Invalid requirement proposal resolution');
  return message;
}

/** Model steps cannot author the server-owned interpretation or Leader confirmation envelopes. */
export function assertNoRequirementControlMessages(mutations: readonly Mutation[]): void {
  for (const mutation of mutations) {
    if (mutation.field !== 'messages') continue;
    const values = Array.isArray(mutation.value) ? mutation.value : [mutation.value];
    for (const value of values) {
      const message = value as Partial<Message> | null;
      const payload = message?.payload;
      if (
        message?.msgId?.startsWith('requirement-proposal:') ||
        payload?.kind === 'leader_requirement_interpretation' ||
        payload?.requirementProposalId !== undefined ||
        payload?.requirementProposalAction !== undefined
      )
        throw new Error('Model steps cannot author requirement control messages');
    }
  }
}

export function requirementProposalView(state: AppState): RequirementProposalView | null {
  const message = latestRequirementInterpretation(state);
  if (!message) return null;
  const proposal = readRequirementInterpretation(state, message);
  if (proposal.result.kind !== 'proposal') return null;
  if (requirementProposalResolution(state, message)) return null;
  const before = readBasis(proposal.basis);
  return {
    proposalId: message.msgId,
    sourceMsgId: proposal.source.msgId,
    summary: proposal.result.summary,
    status:
      state.phase === 'done' ||
      state.humanGate !== undefined ||
      proposal.basis !== requirementBasis(state)
        ? 'stale'
        : 'pending',
    changes: proposal.result.changes.map((c) => {
      const old = before.find((r) => r.id === c.requirementId);
      return {
        requirementId: c.requirementId,
        before: old
          ? { story: old.story, acceptance: [...old.acceptance], nonGoals: [...old.nonGoals] }
          : null,
        after: structuredClone(c.requirement),
      };
    }),
  };
}

function readBasis(basis: string): AppState['requirements'] {
  const value = JSON.parse(basis);
  if (!value || !Array.isArray(value.requirements) || !Array.isArray(value.decisions))
    throw new Error('Invalid proposal basis');
  const ids = new Set<string>();
  for (const requirement of value.requirements) {
    if (
      !requirement ||
      typeof requirement.id !== 'string' ||
      ids.has(requirement.id) ||
      typeof requirement.story !== 'string' ||
      !Array.isArray(requirement.acceptance) ||
      !requirement.acceptance.every((item: unknown) => typeof item === 'string') ||
      !Array.isArray(requirement.nonGoals) ||
      !requirement.nonGoals.every((item: unknown) => typeof item === 'string')
    )
      throw new Error('Invalid proposal basis');
    ids.add(requirement.id);
  }
  return value.requirements;
}

export function confirmedRequirementIntent(state: AppState, proposalId: string) {
  const view = requirementProposalView(state);
  if (!view || view.proposalId !== proposalId || view.status !== 'pending')
    throw new Error('This proposal is no longer current. Describe the change again.');
  return normalizePhase9LeaderIntent({
    kind: 'requirements_change',
    changes: view.changes.map((c) => ({ requirementId: c.requirementId, requirement: c.after })),
  });
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
    throw new Error('Interpretation text must contain 1 through 4000 characters');
  return value.trim();
}
function exactKeys(value: object, keys: string[]) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()))
    throw new Error('Invalid interpretation fields');
}
