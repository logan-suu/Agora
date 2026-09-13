# Install Agora on a new Mac

This guide starts before any development tools are installed. Agora currently runs locally on macOS and requires Docker Desktop for isolated code execution. Installing Agora does not install or start those system tools for you. You do not need Homebrew, a paid IDE, or a GitHub account to clone this public repository.

- [Prepare your Mac](#prepare-your-mac)
- [Install the required tools](#install-the-required-tools)
- [Download and build Agora](#download-and-build-agora)
- [Start and configure your team](#start-and-configure-your-team)
- [Troubleshooting](#troubleshooting)
- [Next time](#next-time)

## Prepare your Mac

Open **Apple menu → About This Mac** to check your macOS version and whether your Mac uses an Apple chip or Intel processor. Select the matching Docker download and check Docker's current [Mac system requirements](https://docs.docker.com/desktop/setup/install/mac-install/#system-requirements). Linux and Windows product launchers are not available yet.

You need an internet connection to download tools, JavaScript packages, and the initial Docker image. Online model services also need network access. Agora keeps its backend and project data on your computer.

Open **Terminal** from **Applications → Utilities** (or search for Terminal with Spotlight). Copy each command block into Terminal, press Return, and wait for it to finish before continuing. Commands that show a version should return to the prompt without an error. Installers may request your Mac password or system permission.

## Install the required tools

### 1. Git and Apple Command Line Tools

Run:

```bash
xcode-select --install
```

Complete Apple's installation dialog. If the tools are already installed, continue with the checks below. The full Xcode application is not required; its Command Line Tools supply Git and the compiler Agora uses during setup. See [Apple's installation instructions](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/).

```bash
git --version
/usr/bin/clang --version
```

Both commands should print version information. If either fails after installation, see [Troubleshooting](#troubleshooting).

### 2. Node.js 24

Open the [official Node.js download page](https://nodejs.org/en/download), select **version 24 LTS**, **macOS**, and the **Installer (.pkg)** option. Run the installer, then close and reopen Terminal. Agora currently checks for Node **24**, so choose that major version even if the page offers a newer release.

```bash
node --version
npm --version
```

The first command must print `v24.x.x`. The second checks npm, the package installer included with Node.js. If you already manage Node versions, activate Node 24 in the terminal you will use for Agora.

### 3. pnpm 9.15.9

Agora uses a pinned pnpm version to install its JavaScript packages. Run:

```bash
npm install --global pnpm@9.15.9
pnpm --version
```

The result must be `9.15.9`. Do not substitute an unversioned latest release. The [pnpm installation documentation](https://pnpm.io/installation) covers other installation methods; this repository's version pin still applies.

If npm reports `EACCES` or pnpm is not found, use the user-directory instructions in [Troubleshooting](#troubleshooting), then repeat the version check.

### 4. Docker Desktop

Download Docker Desktop from the [official Mac installation page](https://docs.docker.com/desktop/setup/install/mac-install/), selecting **Apple silicon** or **Intel** for your Mac. Drag Docker into Applications, open it, and complete its first-run setup. Review and accept Docker's terms if they apply to your use.

Wait until Docker Desktop reports that its engine is running. Merely copying the application to Applications is not enough. Check both the command and the engine:

```bash
docker --version
docker info --format '{{.ServerVersion}}'
```

Both commands should print a version. Keep Docker Desktop running while using Agora. If the first works but the second fails, follow the Docker engine troubleshooting below.

## Download and build Agora

Choose a folder for your projects. For example, the following creates a Projects folder in your home directory and clones Agora into it:

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/logan-suu/Agora.git
cd Agora
pnpm install --frozen-lockfile
pnpm run setup
pnpm run doctor
```

Run the final three commands from the **Agora** folder. `pnpm install` downloads the locked JavaScript dependencies. `pnpm run setup` checks system tools, builds the native helpers, and builds the web application. It can take several minutes; wait for **Setup complete. Run pnpm start.**

Use **`pnpm run setup`**, including `run`: `pnpm setup` invokes pnpm's own shell-setup command. A successful doctor check lists the available dependencies and build artifacts. It does not call your model service or access the Keychain; Keychain access is checked when starting Agora.

If a command fails, resolve its error before running the next command. The diagnostic lists missing tools with repair steps. Once Node and the repository are available, you can run diagnostics even when pnpm is broken or packages are not yet installed:

```bash
node apps/web/scripts/local.mjs doctor
```

If Node itself is unavailable, return to step 2; the diagnostic script needs Node to run.

## Start and configure your team

From the Agora folder, run:

```bash
pnpm start
```

Wait for **Agora is ready at http://127.0.0.1:3000**, then open that address in your browser. Keep this Terminal window open while using Agora.

On first startup, Agora creates an encryption key in your macOS Keychain. Allow the Agora Keychain helper if macOS asks for access. Normal setup requires no `.env` file or manually generated encryption key.

In the interface, choose **Set model for all Agents**, enter your compatible model service's Base URL, API key and model name, then save. You can also configure agents individually. A local service can use the explicit no-authentication option. **Test connection** sends a model request and may incur your provider's normal charges; saving settings does not.

Enter a task ID and goal, then start the task. Watch the group chat and respond to any Leader approval request. The first task may need to download the sandbox image. See the [README](../README.md#quick-start-macos) for the task flow, connection options, and recovery details.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `command not found: node` or a version other than `v24.x.x` | Install or activate Node 24, reopen Terminal, then check `node --version`. With multiple installations, `which node` shows which one the shell selects. |
| `command not found: pnpm` or a version other than `9.15.9` | Install the pinned version from step 3. Check `which pnpm` for an older installation taking precedence. Use the user-directory steps below for permission/PATH problems. |
| Git or clang is unavailable; `invalid active developer path` | Finish `xcode-select --install`, then retry both checks. Use `xcode-select -p` to inspect the selected tools. If macOS says they are installed but the checks still fail, follow [Apple's tool selection guidance](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/). |
| Docker CLI is unavailable | Install and open Docker Desktop. If already installed, check its CLI tools location in Docker Desktop settings and reopen Terminal. For a user-directory CLI installation, ensure `$HOME/.docker/bin` is on your PATH. |
| Docker engine is not reachable | Open Docker Desktop from Applications or run `open -a Docker`. Finish setup and wait for its engine. Retry `docker info`. If it still fails, check `docker context ls`, socket permissions, and [Docker's troubleshooting guide](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/). |
| Agora packages are missing | From the Agora folder, run `pnpm install --frozen-lockfile`, then `pnpm run setup`. |
| Build artifacts are missing or unsafe | Run `pnpm run setup`, then `pnpm run doctor`. These are also required after updating source. |
| Package download or Docker image download fails | Check your network and any required proxy configuration. Retry the failed command after connectivity is restored. A successful dependency check does not guarantee registry or model-service access. |
| Port 3000 is occupied | Run `pnpm start --port 3100`, then use the address it prints. |
| Keychain access is denied or locked | Allow access or unlock your Keychain, then restart Agora. For existing encrypted data, follow the [credential recovery instructions](../README.md#configuration-and-recovery); retain the original key. |

### pnpm permission and PATH errors

If the global npm installation fails with `EACCES`, you can install pnpm in your own directory. This follows npm's [user-directory approach](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/) without changing the global npm prefix:

```bash
npm install --global --prefix "$HOME/.local" pnpm@9.15.9
export PATH="$HOME/.local/bin:$PATH"
pnpm --version
```

For macOS's default zsh, open its startup configuration in TextEdit (the first command creates the file if absent and preserves existing content):

```bash
touch "$HOME/.zprofile"
open -e "$HOME/.zprofile"
```

Add the following line once and save the file so new Terminal windows also find pnpm:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Reopen Terminal and check `pnpm --version` again. If you use a different shell, add the same PATH setting to its startup configuration. You can still run the Node diagnostic command above while fixing pnpm.

## Next time

Open Docker Desktop, open Terminal in your Agora folder, and run `pnpm start`. Stop Agora with **Ctrl+C** in its terminal or `pnpm stop` from another terminal in the same folder. Shutdown waits for active work to finish or reach an existing approval gate; it preserves your data and Keychain key.

After pulling a new version of Agora, run `pnpm install --frozen-lockfile`, `pnpm run setup`, and `pnpm run doctor` again before starting it. You do not need to reinstall working system tools for each launch.
