export function catalog(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('unsupported_build_architecture');
  const hashes = {
    arm64: {
      node: '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
      electron: '49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035',
      git: 'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe',
    },
    x64: {
      node: '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4',
      electron: '6e3278d96377085af532380e2b23a38cdcf4c58b4efb3f6ada2f251db95c9560',
      git: 'ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680',
    },
  }[arch];
  return [
    {
      name: 'pnpm.tgz',
      id: 'pnpm-9.15.9',
      url: 'https://registry.npmjs.org/pnpm/-/pnpm-9.15.9.tgz',
      sha256: 'cf86a7ad764406395d4286a6d09d730711720acc6d93e9dce9ac7ac4dc4a28a7',
      maxBytes: 10000000,
    },
    {
      name: 'node.tar.gz',
      id: `node-24.20.0-darwin-${arch}`,
      url: `https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-${arch}.tar.gz`,
      sha256: hashes.node,
      maxBytes: 100000000,
    },
    {
      name: 'electron.zip',
      id: `electron-44.3.0-darwin-${arch}`,
      url: `https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-darwin-${arch}.zip`,
      sha256: hashes.electron,
      maxBytes: 300000000,
    },
    {
      name: 'git.tar.gz',
      id: `git-2.53.0-darwin-${arch}`,
      url: `https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283-macOS-${arch}.tar.gz`,
      sha256: hashes.git,
      maxBytes: 100000000,
    },
  ];
}
