import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['test-outputs/langgraph-spike-round2/src/diagnostic.test.ts'],fileParallelism:false}});
