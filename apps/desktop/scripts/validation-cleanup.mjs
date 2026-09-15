// Only validation processes use forced cleanup; production lifecycle never calls this helper.
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null || !child.pid;
}

function waitForExit(child, timeout) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(result);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
  });
}

export async function cleanupChild(child, timeout = 10000) {
  if (!child || exited(child)) return false;
  const graceful = waitForExit(child, timeout);
  if (child.connected) child.send({ type: 'stop', version: 1 }, () => {});
  if (await graceful) return false;
  if (exited(child)) return false;
  const forced = waitForExit(child, timeout);
  child.kill('SIGKILL');
  if (!(await forced)) throw new Error('validation_child_cleanup_timeout');
  return true;
}
