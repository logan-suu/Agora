// A real child with deterministic IPC faults; packaged Next/Keychain is tested separately.
process.on('message', (message) => {
  if (message.type === 'start') {
    if (message.mode === 'crash') process.exit(2);
    else
      process.send({
        type: 'ready',
        version: 1,
        origin: 'http://127.0.0.1:54321',
        credentials: 'ready',
      });
  }
  if (message.type === 'stop') {
    process.send({ type: 'stopped', version: 1 });
    setTimeout(() => process.disconnect(), 100);
  }
});
