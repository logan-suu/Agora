import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PROTOCOL = {
  version: 'opencode-go-objection-scope-v14',
  executionEnvironment: 'node20-no-git-cli-use-granted-mcp-tools',
  publicContractVisibility: 'source-pinned-behavioral-facts-in-all-variant-goals',
  publicTestVisibility: 'readable-non-executable-contract-with-xtest-activated',
  holdoutTestVisibility: 'withheld',
  referenceVisibility: 'withheld',
};
export function resolveGroupId(value = 'phase10-final-v14'): string {
  if (!/^phase10-final-v[1-9][0-9]{0,5}$/.test(value)) throw new Error('invalid benchmark group');
  return value;
}
export function budgetTrialId(group: string, trial: string): string {
  return `${resolveGroupId(group)}:${trial}`;
}
/** Read at request/attempt boundaries; never abort an active stream or cleanup. */
export function operatorStopRequested(root: string): boolean {
  return existsSync(join(root, 'stop-requested.json'));
}
