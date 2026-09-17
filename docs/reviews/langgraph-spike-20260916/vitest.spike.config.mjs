import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-outputs/langgraph-spike-20260916/src/live.test.ts'],
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 30000,
  },
});
