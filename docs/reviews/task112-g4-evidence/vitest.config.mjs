import base from '../../../vitest.config.ts';
import { defineConfig } from 'vitest/config';
export default defineConfig({ ...base, test: { ...base.test, setupFiles: [...base.test.setupFiles, '.data/diagnostics/agora112-full-g4-review/select.setup.ts'], reporters: ['default', 'json'], outputFile: { json: '.data/diagnostics/agora112-full-g4-review/results.json' } } });
