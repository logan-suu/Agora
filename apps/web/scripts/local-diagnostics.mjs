import { runTool } from './local-process.mjs';

export const installGuide = 'docs/install-macos.md';
export const platformError = 'The Agora product launcher currently supports macOS only.';

export async function checkDependencies(
  repo,
  { platform = process.platform, nodeVersion = process.versions.node, run = runTool } = {},
) {
  if (platform !== 'darwin') throw new Error(platformError);
  const problems = [];
  if (Number(nodeVersion.split('.')[0]) !== 24) {
    problems.push(
      'Node.js 24 is required. Install the macOS Node.js 24 LTS installer from https://nodejs.org/en/download, reopen Terminal, and check node --version.',
    );
  }
  const pnpmHelp =
    'Install pnpm 9.15.9 with npm install --global pnpm@9.15.9, then check pnpm --version. For permission or PATH errors, follow the installation guide.';
  const checks = [
    ['pnpm', ['--version'], `pnpm is not available on PATH. ${pnpmHelp}`],
    [
      'git',
      ['--version'],
      'Git is not available. Run xcode-select --install, complete the Apple installer, then check git --version.',
    ],
    [
      '/usr/bin/clang',
      ['--version'],
      'Apple Command Line Tools (clang) are not available. Run xcode-select --install and complete the installer; if already installed, check the selected developer directory with xcode-select -p.',
    ],
    [
      'docker',
      ['--version'],
      'Docker CLI is not available on PATH. Install Docker Desktop for your Mac from https://docs.docker.com/desktop/setup/install/mac-install/, open it from Applications, and finish setup. If already installed, check its CLI tools/PATH settings and reopen Terminal.',
    ],
  ];
  const results = await Promise.allSettled(checks.map(([tool, args]) => run(tool, args, repo)));
  results.forEach((result, i) => {
    if (result.status === 'rejected') problems.push(checks[i][2]);
  });
  if (results[0].status === 'fulfilled' && results[0].value !== '9.15.9') {
    problems.push(`The active pnpm version does not match Agora. ${pnpmHelp}`);
  }
  if (results[3].status === 'fulfilled') {
    try {
      await run('docker', ['info', '--format', '{{.ServerVersion}}'], repo);
    } catch {
      problems.push(
        'Docker engine is not reachable. Open Docker Desktop from Applications (or run open -a Docker), finish its setup, and wait until the engine is running. Retry docker info; if it still fails, check Docker Desktop troubleshooting and your Docker context/socket permissions.',
      );
    }
  }
  if (problems.length) {
    throw new Error(
      `Agora cannot continue until these dependencies are ready:\n\n${problems.map((p) => `- ${p}`).join('\n\n')}\n\nFirst-time installation and troubleshooting: ${installGuide}\nAfter fixing the items, retry this command. If pnpm is unavailable, run node apps/web/scripts/local.mjs doctor from the Agora directory.`,
    );
  }
}
