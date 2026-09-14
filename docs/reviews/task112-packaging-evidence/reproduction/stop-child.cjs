// This helper owns only detached, non-model packaging-probe process groups.
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
function waitForExit(child, milliseconds) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('exit', onExit);
  });
}
async function stopChild(child, { sendStop = true, graceMs = 3000, killMs = 3000 } = {}) {
  if (!child) return { forced: false };
  if (sendStop && child.connected) {
    try { child.send({ type: 'stop' }, () => {}); } catch { /* Exit is checked below. */ }
  }
  if (await waitForExit(child, graceMs)) return { forced: false };
  // fork({ detached: true }) gives this probe its own group. Never target a
  // caller-supplied PID or a product worker, and never claim forced exit is graceful.
  if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error('Invalid owned probe PID');
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (!await waitForExit(child, killMs)) throw new Error('Probe process did not exit after termination');
  return { forced: true };
}
module.exports = { stopChild };
