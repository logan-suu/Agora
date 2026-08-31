import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
