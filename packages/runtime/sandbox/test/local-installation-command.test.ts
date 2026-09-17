// Pure plan admission; actual package execution is covered by the native grant suite.
import { expect, it } from 'vitest';
import {
  checkLocalPackageManifest,
  parseLocalPackagePlan,
} from '../src/local-installation-command';

const plan = [
  {
    name: 'picocolors',
    version: '1.1.1',
    url: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
    integrity: `sha512-${'A'.repeat(86)}==`,
  },
];
it('requires complete exact manifest coverage and a pinned plan', () => {
  expect(parseLocalPackagePlan([JSON.stringify(plan)])).toEqual(plan);
  expect(
    checkLocalPackageManifest(
      Buffer.from(JSON.stringify({ dependencies: { picocolors: '1.1.1' } })),
      plan,
    ).dependencies.picocolors,
  ).toBe('1.1.1');
  expect(() =>
    checkLocalPackageManifest(
      Buffer.from(JSON.stringify({ dependencies: { picocolors: '^1.1.1' } })),
      plan,
    ),
  ).toThrow('installation_plan_manifest_mismatch');
  expect(() => checkLocalPackageManifest(Buffer.from('{}'), plan)).toThrow(
    'installation_plan_manifest_mismatch',
  );
});
it.each(['../escape', '@scope/../escape', '/absolute', 'a b'])(
  'rejects package identity %s',
  (name) =>
    expect(() => parseLocalPackagePlan([JSON.stringify([{ ...plan[0], name }])])).toThrow(
      'invalid_installation_plan',
    ),
);
it('rejects duplicate packages, fields and workspace resolution', () => {
  expect(() => parseLocalPackagePlan([JSON.stringify([...plan, ...plan])])).toThrow();
  expect(() =>
    parseLocalPackagePlan([JSON.stringify([{ ...plan[0], registry: 'other' }])]),
  ).toThrow();
  expect(() =>
    checkLocalPackageManifest(Buffer.from('{"workspaces":["packages/*"]}'), plan),
  ).toThrow('unsupported_installation_manifest');
});
