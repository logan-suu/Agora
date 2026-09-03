/**
 * Pure parser for Node test-runner output.
 *
 * Node 20 emits TAP v13 by default, while Node 24 emits the `spec` reporter by
 * default. This parser accepts both forms and extracts the aggregate counts
 * plus the structured failure details needed by the `test-server`.
 *
 * Kept free of I/O and MCP imports so it is unit-testable in isolation
 * (decision R11 / the fs-service split convention).
 */

/** A single failing test, mirroring `State.testResults.failures[]`. */
export interface TapFailure {
  test: string;
  message: string;
  file: string;
  line: number;
}

/** Aggregate summary parsed from a TAP stream. */
export interface TapSummary {
  total: number;
  passed: number;
  failed: number;
  failures: TapFailure[];
  /** Coverage percentage when the runner emitted a `# coverage N%` line. */
  coverage?: number;
}

const TESTS_RE = /^#\s*tests\s+(\d+)/;
const PASS_RE = /^#\s*pass\s+(\d+)/;
const FAIL_RE = /^#\s*fail\s+(\d+)/;
const COVERAGE_RE = /^#\s*coverage\s+([\d.]+)%/;
const SPEC_SUMMARY_RE = /^ℹ\s+(tests|pass|fail)\s+(\d+)\s*$/;
/** TAP plan line (`1..N`), a fallback aggregate count when `# tests` is absent. */
const PLAN_RE = /^(\s*)1\.\.(\d+)\s*$/;
const NOT_OK_RE = /^(\s*)not ok\s+\d+(?:\s*-\s*(.*))?$/;
const SUBTEST_RE = /^(\s*)#\s*Subtest:\s*(.+)$/;
const DIAG_KEY_RE = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * Parse TAP v13 or Node's default spec reporter into an aggregate summary.
 *
 * Summary count lines (`# tests` / `# pass` / `# fail` / `# coverage`) may
 * appear both inside nested subtests and at the top level; the top-level
 * aggregate is always the *last* occurrence, so the last match wins. The `1..N`
 * plan line is used as a fallback for `total` when no `# tests` comment is
 * present. `not ok` assertions are collected at any indentation (so nested
 * failures are not missed) along with their YAML diagnostics block.
 */
export function parseTap(output: string): TapSummary {
  const lines = output.split(/\r?\n/);
  let total = 0;
  let passed = 0;
  let failed = 0;
  let coverage: number | undefined;
  const failures: TapFailure[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    let m = line.match(TESTS_RE);
    if (m) total = Number(m[1]);
    m = line.match(PASS_RE);
    if (m) passed = Number(m[1]);
    m = line.match(FAIL_RE);
    if (m) failed = Number(m[1]);
    m = line.match(COVERAGE_RE);
    if (m) coverage = Number(m[1]);
    m = line.match(SPEC_SUMMARY_RE);
    if (m) {
      const value = Number(m[2]);
      if (m[1] === 'tests') total = value;
      if (m[1] === 'pass') passed = value;
      if (m[1] === 'fail') failed = value;
    }
    m = line.match(PLAN_RE);
    if (m) total = Number(m[2]);

    m = line.match(NOT_OK_RE);
    if (m) {
      const indent = (m[1] ?? '').length;
      let name = m[2]?.trim() ?? '';
      if (name === '') {
        name = findSubtestName(lines, i, indent);
      }
      const { block, nextIndex } = collectDiagnosticsBlock(lines, i + 1);
      failures.push(extractFailure(name, block));
      i = nextIndex;
      continue;
    }
    i++;
  }

  if (output.includes('✖ failing tests:')) {
    failures.push(...parseSpecFailures(lines));
  }

  return { total, passed, failed, failures, ...(coverage === undefined ? {} : { coverage }) };
}

/** Extract failure records from Node 24's default spec reporter detail section. */
function parseSpecFailures(lines: string[]): TapFailure[] {
  const failures: TapFailure[] = [];
  let inFailureSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '✖ failing tests:') {
      inFailureSection = true;
      continue;
    }
    if (!inFailureSection || !line.startsWith('test at ')) continue;

    const location = parseLocation(line.slice('test at '.length));
    let headerIndex = i + 1;
    while ((lines[headerIndex] ?? '').trim() === '') headerIndex++;
    const header = (lines[headerIndex] ?? '').match(/^✖\s+(.+?)(?:\s+\([^)]*\))?\s*$/);
    if (header === null) continue;

    let messageIndex = headerIndex + 1;
    while ((lines[messageIndex] ?? '').trim() === '') messageIndex++;
    const message = (lines[messageIndex] ?? '').trim() || 'test failed';
    failures.push({
      test: (header[1] ?? '').trim(),
      message,
      file: location?.file ?? '',
      line: location?.line ?? 0,
    });
    i = headerIndex;
  }

  return failures;
}

/** Nearest preceding `# Subtest: <name>` at the same-or-shallower indentation. */
function findSubtestName(lines: string[], from: number, maxIndent: number): string {
  for (let k = from - 1; k >= 0; k--) {
    const m = lines[k]?.match(SUBTEST_RE);
    if (m && (m[1] ?? '').length <= maxIndent) {
      return (m[2] ?? '').trim();
    }
  }
  return '(unnamed)';
}

/**
 * Collect the YAML diagnostics lines that follow a `not ok` line, from the
 * `---` opener up to (but not including) the closing `...` / `---` terminator.
 * Returns the collected block plus the index just past the terminator, so the
 * caller can resume scanning after this failure's diagnostics.
 *
 * Only blank lines are skipped looking for the `---` opener: if the next
 * non-blank line is not an opener (e.g. a following `not ok` record with no
 * diagnostics of its own), an empty block is returned with `nextIndex` left at
 * that line so the caller still processes it.
 */
function collectDiagnosticsBlock(
  lines: string[],
  start: number,
): { block: string[]; nextIndex: number } {
  let j = start;
  while (j < lines.length && (lines[j] ?? '').trim() === '') {
    j++;
  }
  if (j >= lines.length || !/^\s*---\s*$/.test(lines[j] ?? '')) {
    return { block: [], nextIndex: j };
  }
  const openIndent = (lines[j]?.match(/^(\s*)/)?.[1]?.length ?? 0) as number;
  j++;
  const block: string[] = [];
  while (j < lines.length) {
    const l = lines[j] ?? '';
    const lIndent = l.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (/^\s*(\.\.\.|---)\s*$/.test(l) && lIndent <= openIndent) {
      break;
    }
    block.push(l);
    j++;
  }
  // j points at the terminator; advance past it
  return { block, nextIndex: j + 1 };
}

function extractFailure(name: string, block: string[]): TapFailure {
  let message: string | undefined;
  let file = '';
  let line = 0;
  let operator: string | undefined;
  let expected: string | undefined;
  let actual: string | undefined;

  let i = 0;
  while (i < block.length) {
    const raw = block[i] ?? '';
    const m = raw.match(DIAG_KEY_RE);
    if (m === null) {
      i++;
      continue;
    }
    const keyIndent = (m[1] ?? '').length;
    const key = m[2] ?? '';
    const value = m[3] ?? '';

    if (key === 'location' || key === 'at') {
      const loc = parseLocation(value);
      if (loc) {
        file = loc.file;
        line = loc.line;
      }
    } else if (key === 'error') {
      if (value === '|-' || value === '|') {
        // Multi-line block: consume following lines more indented than the key.
        const parts: string[] = [];
        let j = i + 1;
        while (j < block.length) {
          const l = block[j] ?? '';
          const li = l.match(/^(\s*)/)?.[1]?.length ?? 0;
          if (li <= keyIndent) {
            break;
          }
          parts.push(l.replace(/^\s+/, ''));
          j++;
        }
        message = parts.join('\n').trim();
        i = j;
        continue;
      } else if (value !== '') {
        message = value;
      }
    } else if (key === 'operator') {
      operator = unquote(value);
    } else if (key === 'expected') {
      expected = value;
    } else if (key === 'actual') {
      actual = value;
    }
    i++;
  }

  if (message === undefined || message === '') {
    if (operator !== undefined || expected !== undefined || actual !== undefined) {
      message =
        `assertion failed${operator !== undefined ? ` (${operator})` : ''}` +
        `${expected !== undefined ? ` expected: ${expected}` : ''}` +
        `${actual !== undefined ? ` actual: ${actual}` : ''}`;
    } else {
      message = 'test failed';
    }
  }

  return { test: name, message, file, line };
}

/**
 * Parse a `location:` / `at:` value like `'/abs/path/file.test.mjs:4:1'` or
 * `file:///abs/path/file.test.mjs:4:1` into `{ file, line }`. The greedy `.*`
 * prefix keeps any colons inside the path while leaving a trailing `:line:col`.
 */
function parseLocation(value: string): { file: string; line: number } | undefined {
  const cleaned = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^file:\/\//, '');
  const m = cleaned.match(/^(.*):(\d+):\d+$/);
  if (m) {
    return { file: m[1] ?? '', line: Number(m[2]) };
  }
  const m2 = cleaned.match(/^(.*):(\d+)$/);
  if (m2) {
    return { file: m2[1] ?? '', line: Number(m2[2]) };
  }
  return undefined;
}

/** Strip surrounding quotes from a YAML scalar value. */
function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}
