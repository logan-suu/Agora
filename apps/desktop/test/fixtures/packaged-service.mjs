// G5 bootstrap injects only an isolated real Keychain into the packaged production service.
let service;
let stopping;
process.on('message', (message) => {
  void (async () => {
    if (message.type === 'start') {
      const { DesktopService } = await import(
        message.module ?? process.env.AGORA_VALIDATION_MODULE
      );
      const { keychainStore } = await import(
        message.storeModule ?? process.env.AGORA_VALIDATION_STORE_MODULE
      );
      service = new DesktopService(message.config, {
        system: keychainStore(message.config.helper, {
          service: 'com.agora.desktop.credentials',
          keychain: message.keychain ?? process.env.AGORA_VALIDATION_KEYCHAIN,
        }),
      });
      const ready = await service.start();
      if (ready) process.send({ type: 'ready', version: 1, ...ready });
    } else if (message.type === 'stop') {
      stopping ??= (async () => {
        await service.stop();
        process.send({ type: 'stopped', version: 1 }, () => process.disconnect());
      })();
      await stopping;
    }
  })().catch((error) => {
    console.error(error);
    process.send?.({ type: 'failed', version: 1, code: 'probe_failed' });
  });
});
process.on('disconnect', () => {
  void service?.stop().catch(() => {});
});
