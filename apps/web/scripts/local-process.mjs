import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

export function childEnvironment(source = process.env) {
  const result = { ...source };
  delete result.AGORA_CREDENTIALS_KEY;
  return result;
}
export function controlPath(root) {
  return join(
    tmpdir(),
    `agora-${process.getuid()}-${createHash('sha256').update(root).digest('hex').slice(0, 20)}.sock`,
  );
}
export function keychainStore(
  helper,
  { service = 'com.agora.local.credentials', account = userInfo().username, keychain } = {},
) {
  const invoke = (operation, key) =>
    new Promise((resolveResult, reject) => {
      const args = [operation, service, account, ...(keychain ? [keychain] : [])];
      const child = execFile(
        helper,
        args,
        { env: childEnvironment(), timeout: 60000, maxBuffer: 4096 },
        (error, stdout) => {
          if (error) {
            if (error.code === 10 && operation === 'read') {
              resolveResult(undefined);
              return;
            }
            const codes = { 11: 'denied', 12: 'locked', 14: 'ambiguous', 15: 'invalid' };
            reject(
              Object.assign(new Error('macOS Keychain access failed.'), {
                code: codes[error.code] ?? 'unavailable',
              }),
            );
            return;
          }
          const value = stdout.trim();
          if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
            reject(new Error('Invalid Keychain response.'));
            return;
          }
          resolveResult(value);
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(key ?? '');
    });
  return { read: () => invoke('read'), create: (key) => invoke('create', key) };
}
export function runTool(command, args, cwd, visible = false) {
  return new Promise((resolveResult, reject) => {
    let output = '';
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(),
      stdio: visible ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    });
    const timer = visible ? undefined : setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stdout?.on('data', (bytes) => {
      if (output.length < 4096) output += bytes.toString();
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`${command} is unavailable. Install it and retry.`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult(output.trim());
      else reject(new Error(`${command} failed. Check the dependency and retry.`));
    });
  });
}
