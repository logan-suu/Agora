import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['.data/diagnostics/agora112-lru-timeout/observe.setup.ts'],
    include: ['packages/core/__tests__/e2e/lru-cache.test.ts'],
    fileParallelism: false,
  },
});
