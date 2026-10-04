// A real child with deterministic IPC faults; packaged Next/Keychain is tested separately.
let mode;
process.on('message', (message) => {
  if (message.type === 'start') {
    mode = message.mode;
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
    if (mode === 'cleanup-once') {
      mode = 'clean';
      process.send({ type: 'failed', version: 1, code: 'service_cleanup_failed' });
      return;
    }
    const finish = () => {
      process.send({ type: 'stopped', version: 1 });
      setTimeout(() => process.disconnect(), 100);
    };
    if (mode === 'slow-stop') setTimeout(finish, 160);
    else finish();
  }
});
