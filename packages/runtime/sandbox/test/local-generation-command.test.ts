// Pure wrapper construction; real execution is covered by native integration.
import { expect, it } from 'vitest';
import { localGenerationArguments } from '../src/local-generation-command';

it.each([
  '../escape.js',
  '@input/../escape.js',
  '@input//absolute',
  '@input/a/./b',
  '@input/\u0000bad',
  '--eval',
])('rejects an unbound generator entry %s', (entry) => {
  expect(() => localGenerationArguments('/fixed/input', '/fixed/output', [entry])).toThrow(
    'invalid_generation_entry',
  );
});
it('quotes script arguments without evaluating shell metacharacters', () => {
  const args = ['@input/generate.cjs', '$(touch /not-authorized)', '`not-a-shell`', "'quoted'"];
  const built = localGenerationArguments('/fixed/input', '/fixed/output', args);
  expect(built[0]).toBe('-e');
  expect(built[1]).toContain(JSON.stringify(args));
  expect(built[1]).toContain('process.execPath');
  expect(built[1]).not.toContain('shell:true');
});
