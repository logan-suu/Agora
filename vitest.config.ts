import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Real Docker/Harness/Git suites share one host. Serialize files, while
    // preserving each scenario's internal worker concurrency and deadlines.
    fileParallelism: false,
    setupFiles: process.env.AGORA_EVAL_BUDGET_FILE
      ? ['tests/evals/phase10/final/regression-meter.setup.ts']
      : [],
    include: [
      'packages/**/test/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
