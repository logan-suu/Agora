import { describe, expect, it } from 'vitest';
import { activateTests, publicFiles, validateJestResult } from './public-adapter';

describe('public benchmark boundary', () => {
  it('does not expose official tests, proof or metadata as model seed', () => {
    const seed = publicFiles('forth').filter((f) => f.audience === 'agent');
    expect(seed.map((f) => f.path)).toContain('forth.js');
    expect(seed.every((f) => !/spec|proof|\.meta/.test(f.path))).toBe(true);
    expect(() => publicFiles('../escape')).toThrow();
  });
  it('enables upstream xtest declarations without altering assertions', () => {
    const source = "xtest('edge', () => { expect(1).toBe(2); });";
    expect(activateTests(source)).toBe("test('edge', () => { expect(1).toBe(2); });");
    expect(() => activateTests("test.skip('edge', () => {});")).toThrow(/skip/);
  });
  it('rejects missing, skipped, zero-test and inconsistent verifier reports', () => {
    const report = {
      success: true,
      numTotalTests: 10,
      numPassedTests: 10,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numRuntimeErrorTestSuites: 0,
      testResults: [{ assertionResults: Array.from({ length: 10 }, () => ({ status: 'passed' })) }],
    };
    expect(validateJestResult(report, 10, 0)).toBe(true);
    expect(
      validateJestResult(
        {
          ...report,
          numPassedTests: 9,
          numFailedTests: 1,
          success: false,
          testResults: [
            {
              assertionResults: [
                ...Array.from({ length: 9 }, () => ({ status: 'passed' })),
                { status: 'failed' },
              ],
            },
          ],
        },
        10,
        1,
      ),
    ).toBe(false);
    for (const invalid of [
      null,
      {},
      { ...report, numTotalTests: 0 },
      { ...report, numPendingTests: 1 },
      { ...report, testResults: [] },
    ]) {
      expect(() => validateJestResult(invalid, 10, 0)).toThrow();
    }
  });
});
