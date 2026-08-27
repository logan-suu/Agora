import { describe, expect, it } from 'vitest';
import { parseTap } from '../src/tap';

/** Real output of `node --test` on a two-test file (one pass, one fail). */
const REAL_FAILING_SAMPLE = `TAP version 13
# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 0.595792
  ...
# Subtest: fails
not ok 2 - fails
  ---
  duration_ms: 0.333458
  location: '/abs/path/to/sample.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    expected one
    
    1 !== 2
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 2
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///abs/path/to/sample.test.mjs:4:30)
    Test.run (node:internal/test_runner/test:979:25)
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 54.896875
`;

describe('parseTap', () => {
  it('aggregates counts and extracts failure details from a real node --test sample', () => {
    const summary = parseTap(REAL_FAILING_SAMPLE);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    const failure = summary.failures[0];
    expect(failure?.test).toBe('fails');
    expect(failure?.file).toBe('/abs/path/to/sample.test.mjs');
    expect(failure?.line).toBe(4);
    expect(failure?.message).toContain('expected one');
    expect(failure?.message).toContain('1 !== 2');
  });

  it('reports zero failures for an all-pass run', () => {
    const output = `TAP version 13
# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 0.5
  ...
1..1
# tests 1
# pass 1
# fail 0
`;
    const summary = parseTap(output);
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  it('uses the preceding Subtest name when the not ok line has no name', () => {
    const output = `TAP version 13
# Subtest: anonymous failure
not ok 1
  ---
  location: '/tmp/x.test.js:9:1'
  error: boom
  ...
1..1
# tests 1
# pass 0
# fail 1
`;
    const summary = parseTap(output);
    expect(summary.failures[0]?.test).toBe('anonymous failure');
    expect(summary.failures[0]?.message).toBe('boom');
    expect(summary.failures[0]?.line).toBe(9);
  });

  it('falls back to operator/expected/actual when no error field is present', () => {
    const output = `TAP version 13
not ok 1 - mismatch
  ---
  location: '/x.test.js:3:1'
  operator: 'deepEqual'
  expected: 42
  actual: 43
  ...
1..1
# tests 1
# pass 0
# fail 1
`;
    const failure = parseTap(output).failures[0];
    expect(failure?.message).toContain('deepEqual');
    expect(failure?.message).toContain('expected: 42');
    expect(failure?.message).toContain('actual: 43');
  });

  it('captures coverage percentage when emitted', () => {
    const output = `TAP version 13
1..1
# tests 1
# pass 1
# fail 0
# coverage 87.5%
`;
    expect(parseTap(output).coverage).toBe(87.5);
  });

  it('leaves coverage undefined when absent', () => {
    const summary = parseTap('TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n');
    expect('coverage' in summary).toBe(false);
  });

  it('returns zero counts for empty output', () => {
    const summary = parseTap('');
    expect(summary.total).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  it('picks the last (top-level) aggregate summary over nested ones', () => {
    const output = `TAP version 13
# Subtest: describe
    # Subtest: inner
    ok 1 - inner
    1..1
    # tests 1
    # pass 1
    # fail 0
ok 1 - describe
1..1
# tests 1
# pass 1
# fail 0
`;
    const summary = parseTap(output);
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(0);
  });
});
