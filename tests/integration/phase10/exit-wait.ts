export async function waitForExitStage(
  entered: Promise<void>,
  name: string,
  failure: () => Promise<string | undefined>,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let stopped = false;
  let checking = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let cancel: (() => void) | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), timeoutMs);
    const check = async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        const reason = await failure();
        if (!stopped && reason) reject(new Error(`${name} not reached: ${reason}`));
      } catch (error) {
        if (!stopped) reject(error);
      } finally {
        checking = false;
      }
    };
    poll = setInterval(() => void check(), 50);
    void check();
  });
  try {
    await Promise.race([entered, failed]);
  } finally {
    stopped = true;
    clearTimeout(deadline);
    clearInterval(poll);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}
