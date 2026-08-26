import { describe, expect, it } from 'vitest';
import { PHASE0_ROSTER } from '../src/index';

function spec(role: string) {
  const found = PHASE0_ROSTER.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`missing role spec: ${role}`);
  return found;
}

describe('PHASE0_ROSTER', () => {
  it('contains exactly the C4 triad with harness executors enabled (decision D2)', () => {
    expect(PHASE0_ROSTER.map((entry) => entry.role)).toEqual(['COORDINATOR', 'CODER', 'TESTER']);
    for (const entry of PHASE0_ROSTER) {
      expect(entry.enabled).toBe(true);
      expect(entry.executor).toBe('harness');
    }
  });

  it('whitelists tools per role exactly as the detailed design §2 permission matrix', () => {
    expect(spec('COORDINATOR').tools).toEqual([]);
    expect(spec('CODER').tools).toEqual([
      'fs.read',
      'fs.write',
      'git',
      'sandbox.applyPatch',
      'lint',
    ]);
    expect(spec('TESTER').tools).toEqual(['fs.read', 'fs.write', 'sandbox.run', 'git']);
  });

  it('keeps the coordinator tool-free because it only consumes projected summaries', () => {
    expect(spec('COORDINATOR').tools.length).toBe(0);
  });

  it('carries the §2 system prompts including their non-negotiable constraints', () => {
    expect(spec('COORDINATOR').systemPrompt).toContain('你不写需求/设计/代码');
    expect(spec('CODER').systemPrompt).toContain('只在被分配的 subtask');
    expect(spec('CODER').systemPrompt).toContain('advisory');
    expect(spec('TESTER').systemPrompt).toContain('不修业务代码');
  });

  it('declares projection slices and routeWhen placeholders for Phase 0 routing', () => {
    expect(spec('COORDINATOR').projection).toEqual(['global.summary']);
    expect(spec('COORDINATOR').routeWhen).toBe('always');
    expect(spec('CODER').projection).toEqual([
      'assignedSubtask',
      'architecture',
      'conventions',
      'failingTests',
      'fileRefs',
    ]);
    expect(spec('CODER').routeWhen).toBe('designReady || testsFailed');
    expect(spec('TESTER').projection).toEqual([
      'acceptance',
      'branchOrPatch',
      'interfaceContracts',
    ]);
    expect(spec('TESTER').routeWhen).toBe('codingDone');
  });

  it('leaves model unset pending agent/request routing in task 0.5', () => {
    for (const entry of PHASE0_ROSTER) {
      expect(entry.model).toBeUndefined();
    }
  });
});
