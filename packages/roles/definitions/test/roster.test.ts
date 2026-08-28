import { PHASE0_ROSTER, type RoleSpec } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECT_ROLE,
  DEFAULT_ROSTER,
  PM_ROLE,
  REVIEWER_ROLE,
  validateRoster,
} from '../src/index';

function spec(roster: readonly RoleSpec[], role: string): RoleSpec {
  const found = roster.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`missing role spec: ${role}`);
  return found;
}

describe('DEFAULT_ROSTER (task 2.1 six-role roster)', () => {
  it('contains exactly the six §2 roles in spec order', () => {
    expect(DEFAULT_ROSTER.map((entry) => entry.role)).toEqual([
      'COORDINATOR',
      'PM',
      'ARCHITECT',
      'CODER',
      'TESTER',
      'REVIEWER',
    ]);
  });

  it('enables every role on the harness executor with model unset (decision D2)', () => {
    for (const entry of DEFAULT_ROSTER) {
      expect(entry.enabled).toBe(true);
      expect(entry.executor).toBe('harness');
      expect(entry.model).toBeUndefined();
    }
  });

  it('whitelists tools per role exactly as the detailed design §2 permission matrix', () => {
    expect(spec(DEFAULT_ROSTER, 'COORDINATOR').tools).toEqual([]);
    expect(spec(DEFAULT_ROSTER, 'PM').tools).toEqual([]);
    expect(spec(DEFAULT_ROSTER, 'ARCHITECT').tools).toEqual(['fs.read', 'git.readonly']);
    expect(spec(DEFAULT_ROSTER, 'CODER').tools).toEqual([
      'fs.read',
      'fs.write',
      'sandbox.run',
      'git',
      'sandbox.applyPatch',
      'lint',
    ]);
    expect(spec(DEFAULT_ROSTER, 'TESTER').tools).toEqual([
      'fs.read',
      'fs.write',
      'sandbox.run',
      'git',
    ]);
    expect(spec(DEFAULT_ROSTER, 'REVIEWER').tools).toEqual(['fs.read', 'git.readonly', 'lint']);
  });

  it('keeps PM tool-free because it only consumes projected goal/requirements/leader decisions', () => {
    expect(spec(DEFAULT_ROSTER, 'PM').tools.length).toBe(0);
  });

  it('declares projection slices per the §2 spec for each new role', () => {
    expect(spec(DEFAULT_ROSTER, 'PM').projection).toEqual([
      'goal',
      'requirements',
      'leaderDecisions',
    ]);
    expect(spec(DEFAULT_ROSTER, 'ARCHITECT').projection).toEqual([
      'requirements',
      'repoStructure',
      'conventions',
    ]);
    expect(spec(DEFAULT_ROSTER, 'REVIEWER').projection).toEqual([
      'pendingPatch',
      'conventions',
      'architecture',
    ]);
  });

  it('carries the §2 system prompts including their non-negotiable constraints', () => {
    expect(spec(DEFAULT_ROSTER, 'PM').systemPrompt).toContain('blocking');
    expect(spec(DEFAULT_ROSTER, 'PM').systemPrompt).toContain('不擅自改需求');
    expect(spec(DEFAULT_ROSTER, 'ARCHITECT').systemPrompt).toContain('附理由写入台账');
    expect(spec(DEFAULT_ROSTER, 'REVIEWER').systemPrompt).toContain('leader 最终确认');
    expect(spec(DEFAULT_ROSTER, 'REVIEWER').systemPrompt).toContain('可执行修改意见');
  });

  it('declares routeWhen skeleton conditions for the new roles (evaluator lands in task 2.2)', () => {
    expect(spec(DEFAULT_ROSTER, 'PM').routeWhen).toBe('goalAmbiguous');
    expect(spec(DEFAULT_ROSTER, 'ARCHITECT').routeWhen).toBe('requirementsReady');
    expect(spec(DEFAULT_ROSTER, 'REVIEWER').routeWhen).toBe('testsPassed');
  });

  it('reuses the Phase 0 triad verbatim — no drift from PHASE0_ROSTER', () => {
    for (const role of ['COORDINATOR', 'CODER', 'TESTER']) {
      expect(spec(DEFAULT_ROSTER, role)).toEqual(spec(PHASE0_ROSTER, role));
    }
  });

  it('exposes the three new role specs as importable constants', () => {
    expect(PM_ROLE.role).toBe('PM');
    expect(ARCHITECT_ROLE.role).toBe('ARCHITECT');
    expect(REVIEWER_ROLE.role).toBe('REVIEWER');
  });
});

describe('validateRoster (roster loading guard)', () => {
  it('accepts the default roster', () => {
    expect(() => validateRoster(DEFAULT_ROSTER)).not.toThrow();
  });

  it('rejects duplicate role ids', () => {
    const dup: readonly RoleSpec[] = [...DEFAULT_ROSTER, PM_ROLE];
    expect(() => validateRoster(dup)).toThrow(/duplicate role/i);
  });

  it('rejects non-harness executors in phases 0-9 (decision D2)', () => {
    const external: RoleSpec = { ...PM_ROLE, executor: 'external' };
    expect(() => validateRoster([external])).toThrow(/harness/);
  });
});
