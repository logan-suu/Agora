import { expect } from 'vitest';
const selected = ['packages/core/__tests__/e2e/lru-cache.test.ts', 'packages/runtime/executor/test/g5-real-chain.test.ts', 'packages/runtime/executor/test/channel-summary-g5-real-chain.test.ts'];
if (selected.some(path => expect.getState().testPath?.endsWith(path))) await import('./observe.setup.ts');
