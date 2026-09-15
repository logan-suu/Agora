// G5 bootstrap injects only an isolated real Keychain into the packaged production service.
let service;
let constructing;
let starting;
let stopping;
let stopRequested = false;
async function stop() {
  stopRequested = true;
  stopping ??= (async () => {
    await constructing?.catch(() => {});
    await service?.stop();
    await starting?.catch(() => {});
    if (process.connected)
      process.send({ type: 'stopped', version: 1 }, () => {
        if (process.connected) process.disconnect();
      });
  })();
  return stopping;
}
process.on('message', (message) => {
  void (async () => {
    if (message.type === 'start') {
      if (stopRequested || starting) throw new Error('invalid_start');
      constructing = (async () => {
        const { DesktopService } = await import(
          message.module ?? process.env.AGORA_VALIDATION_MODULE
        );
        const { keychainStore } = await import(
          message.storeModule ?? process.env.AGORA_VALIDATION_STORE_MODULE
        );
        if (stopRequested) return;
        service = new DesktopService(message.config, {
          system: keychainStore(message.config.helper, {
            service: 'com.agora.desktop.credentials',
            keychain: message.keychain ?? process.env.AGORA_VALIDATION_KEYCHAIN,
          }),
        });
      })();
      starting = (async () => {
        await constructing;
        if (stopRequested) return;
        const ready = await service.start();
        if (ready && !stopRequested) process.send({ type: 'ready', version: 1, ...ready });
      })();
      await starting;
    } else if (message.type === 'stop') {
      await stop();
    }
  })().catch((error) => {
    console.error(error);
    if (process.connected)
      process.send({ type: 'failed', version: 1, code: 'probe_failed' }, () => {});
  });
});
process.on('disconnect', () => {
  void stop().catch(() => {});
});
