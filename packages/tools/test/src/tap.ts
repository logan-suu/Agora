/**
 * Pure TAP (Test Anything Protocol) parser for test-runner output.
 *
 * Node's built-in test runner (`node --test`) emits TAP v13 when stdout is not
 * a TTY. This parser extracts the aggregate test counts plus the structured
 * failure details (test name, message, source file/line) needed by the
 * `test-server` to produce a `State.testResults`-shaped result.
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
const NOT_OK_RE = /^(\s*)not ok\s+\d+(?:\s*-\s*(.*))?$/;
const SUBTEST_RE = /^(\s*)#\s*Subtest:\s*(.+)$/;
const DIAG_KEY_RE = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * Parse a TAP v13 stream into an aggregate summary.
 *
 * Summary count lines (`# tests` / `# pass` / `# fail` / `# coverage`) may
 * appear both inside nested subtests and at the top level; the top-level
 * aggregate is always the *last* occurrence, so the last match wins. `not ok`
 * assertions are collected at any indentation (so nested failures are not
 * missed) along with their YAML diagnostics block.
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

  return { total, passed, failed, failures, ...(coverage === undefined ? {} : { coverage }) };
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
 */
function collectDiagnosticsBlock(
  lines: string[],
  start: number,
): { block: string[]; nextIndex: number } {
  let j = start;
  // skip blank/`ok` noise until the `---` block opener
  while (j < lines.length && !/^\s*---\s*$/.test(lines[j] ?? '')) {
    j++;
  }
  if (j >= lines.length) {
    return { block: [], nextIndex: lines.length };
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

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}
