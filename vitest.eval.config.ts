import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/evals/**/*.eval.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
