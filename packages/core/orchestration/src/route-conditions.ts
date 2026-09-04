import { type AppState, activeRequirements } from '@agora/core-domain';

export const ROUTE_WHEN_KEYS = [
  'always',
  'goalAmbiguous',
  'requirementsReady',
  'designReady',
  'codingDone',
  'testsPassed',
  'testsFailed',
] as const;
export type RouteWhenKey = (typeof ROUTE_WHEN_KEYS)[number];

function evaluateAtom(state: AppState, atom: string): boolean {
  const requirements = activeRequirements(state);
  switch (atom) {
    case 'always':
      return true;
    case 'goalAmbiguous':
      return requirements.length === 0;
    case 'requirementsReady':
      return requirements.length > 0;
    case 'designReady':
      return state.architecture !== undefined;
    case 'codingDone':
      return state.subtasks.some(
        (subtask) => subtask.ownerRole === 'CODER' && subtask.status === 'done',
      );
    case 'testsPassed':
      return state.testResults?.passed === true;
    case 'testsFailed':
      return state.testResults !== undefined && !state.testResults.passed;
    default:
      throw new Error(`unknown routeWhen condition "${atom}"`);
  }
}

export function evaluateRouteWhen(state: AppState, routeWhen: string): boolean {
  const atoms = routeWhen
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (atoms.length === 0) {
    throw new Error('empty routeWhen condition');
  }
  return atoms.some((atom) => evaluateAtom(state, atom));
}
