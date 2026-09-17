import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['test-outputs/langgraph-spike-round2/src/live.test.ts'],fileParallelism:false,testTimeout:180000,hookTimeout:30000}});
