import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
