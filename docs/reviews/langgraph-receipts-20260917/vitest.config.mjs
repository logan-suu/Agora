import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test-outputs/langgraph-receipts/src/receipts.test.ts'], fileParallelism: false, testTimeout: 30000 } });
