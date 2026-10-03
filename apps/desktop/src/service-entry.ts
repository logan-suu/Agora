import { isAbsolute } from 'node:path';
import { exactKeys, protocolVersion, record } from './protocol.js';
import { DesktopService, type ServiceConfig } from './service.js';

let service: DesktopService | undefined;
let stopping: Promise<void> | undefined;
let stopRequested = false;
let interactiveDrain = false;
const send = (message: object) =>
  new Promise<void>((resolve) => {
    if (process.connected) process.send?.(message, () => resolve());
    else resolve();
  });
async function stop() {
  stopRequested = true;
  stopping ??= (async () => {
    try {
      await service?.stop();
      await send({ type: 'stopped', version: protocolVersion });
      if (process.connected) process.disconnect();
    } catch {
      await send({ type: 'failed', version: protocolVersion, code: 'service_cleanup_failed' });
      if (interactiveDrain && process.connected) stopping = undefined;
      else {
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      }
    }
  })();
  return stopping;
}
process.on('message', (input) => {
  void (async () => {
    const message = record(input);
    if (message.version !== protocolVersion) throw new Error('invalid_protocol');
    if (message.type === 'select-directory') {
      exactKeys(message, ['type', 'version', 'requestId', 'scope', 'actionId', 'path']);
      const scope = record(message.scope);
      exactKeys(scope, ['projectId', 'taskId']);
      if (
        [message.requestId, message.actionId, scope.projectId, scope.taskId].some(
          (v) => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
        ) ||
        typeof message.path !== 'string' ||
        !isAbsolute(message.path) ||
        message.path.length > 4096
      )
        throw Error('invalid_protocol');
      try {
        if (!service || stopRequested) throw Error('service_not_ready');
        const result = await service.selectDirectory(
          scope as { projectId: string; taskId: string },
          message.actionId as string,
          message.path,
        );
        await send({
          type: 'selected',
          version: protocolVersion,
          requestId: message.requestId,
          ...result,
        });
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
            ? error.message
            : 'selection_failed';
        await send({
          type: 'selection-failed',
          version: protocolVersion,
          requestId: message.requestId,
          code,
        });
      }
      return;
    }
    if (message.type === 'stop') {
      exactKeys(message, ['type', 'version']);
      await stop();
      return;
    }
    exactKeys(message, ['type', 'version', 'config']);
    if (message.type !== 'start' || service || stopRequested) throw new Error('invalid_protocol');
    const config = record(message.config);
    exactKeys(config, [
      'stateRoot',
      'webRoot',
      'helper',
      'capability',
      ...(config.toolchainRoot === undefined ? [] : ['toolchainRoot']),
      ...(config.acceptanceRoots === undefined ? [] : ['acceptanceRoots']),
    ]);
    if (
      config.acceptanceRoots !== undefined &&
      (!Array.isArray(config.acceptanceRoots) ||
        config.acceptanceRoots.length > 16 ||
        config.acceptanceRoots.some((p) => typeof p !== 'string' || !isAbsolute(p)))
    )
      throw Error('invalid_protocol');
    if (
      config.toolchainRoot !== undefined &&
      (typeof config.toolchainRoot !== 'string' || !isAbsolute(config.toolchainRoot))
    )
      throw new Error('invalid_protocol');
    if (
      ['stateRoot', 'webRoot', 'helper'].some(
        (key) => typeof config[key] !== 'string' || !isAbsolute(config[key] as string),
      ) ||
      typeof config.capability !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.capability)
    )
      throw new Error('invalid_protocol');
    interactiveDrain = Array.isArray(config.acceptanceRoots) && config.acceptanceRoots.length > 0;
    service = new DesktopService(config as unknown as ServiceConfig);
    const ready = await service.start();
    if (ready && !stopRequested) await send({ type: 'ready', version: protocolVersion, ...ready });
  })().catch(async (error: unknown) => {
    const known = [
      'state_in_use',
      'unsafe_state_path',
      'unsupported_state_version',
      'upgrade_requires_quiescence',
      'credentials_timeout',
      'invalid_protocol',
    ];
    const code =
      error instanceof Error && known.includes(error.message)
        ? error.message
        : 'service_start_failed';
    process.exitCode = 1;
    await send({ type: 'failed', version: protocolVersion, code });
    await stop();
  });
});
process.on('disconnect', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
if (!process.connected) throw new Error('private_ipc_required');
