/** Bounded byte capture only. Main exit and pipe EOF never prove descendant cleanup. */
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';

type Output = { bytes: Buffer; observedBytes: number; truncated: boolean; error: string | null };
export type LocalCommandOutput = {
  mainResult: { exitCode: number | null; signal: string | null; error: string | null };
  stdout: Output;
  stderr: Output;
  tailDurationMs: number;
};

export function captureLocalCommandOutput(
  child: ChildProcess,
  stopObserving?: AbortSignal,
): Promise<LocalCommandOutput> {
  if (!child.stdout || !child.stderr) throw new Error('command_pipes_required');
  const streams = [child.stdout, child.stderr];
  const buffers: Buffer[][] = [[], []];
  const results: Output[] = streams.map(() => ({
    bytes: Buffer.alloc(0),
    observedBytes: 0,
    truncated: false,
    error: null,
  }));
  const retained = [0, 0];
  const ended = [false, false];
  let exitAt: number | undefined;
  let mainResult: LocalCommandOutput['mainResult'] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    let complete = false;
    function finish() {
      if (complete || !mainResult || !ended.every(Boolean)) return;
      complete = true;
      if (timer) clearTimeout(timer);
      stopObserving?.removeEventListener('abort', abandon);
      for (const [index, list] of buffers.entries()) {
        const result = results[index];
        if (result) result.bytes = Buffer.concat(list);
      }
      resolve({
        mainResult,
        stdout: { ...(results[0] as Output) },
        stderr: { ...(results[1] as Output) },
        tailDurationMs: performance.now() - (exitAt ?? performance.now()),
      });
    }
    function abandon() {
      if (complete) return;
      if (!mainResult) {
        exitAt = performance.now();
        mainResult = { exitCode: null, signal: null, error: 'command_observation_incomplete' };
      }
      for (const [index, stream] of streams.entries()) {
        if (ended[index]) continue;
        (results[index] as Output).truncated = true;
        ended[index] = true;
        stream.destroy();
      }
      finish();
    }
    function mainExit(exitCode: number | null, signal: string | null, error: string | null) {
      if (mainResult) return;
      exitAt = performance.now();
      mainResult = { exitCode, signal, error };
      timer = setTimeout(() => {
        for (const [index, stream] of streams.entries()) {
          if (ended[index]) continue;
          const result = results[index];
          if (result) result.truncated = true;
          ended[index] = true;
          stream.destroy();
        }
        finish();
      }, 1000);
      finish();
    }
    for (const [index, stream] of streams.entries()) {
      const result = results[index] as Output;
      const data = (chunk: Buffer) => {
        if (complete) return;
        result.observedBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          result.observedBytes + chunk.length,
        );
        const keep = Math.max(0, Math.min(chunk.length, 1024 * 1024 - (retained[index] ?? 0)));
        if (keep) {
          buffers[index]?.push(Buffer.from(chunk.subarray(0, keep)));
          retained[index] = (retained[index] ?? 0) + keep;
        }
        if (keep < chunk.length) result.truncated = true;
      };
      stream.on('data', data);
      stream.once('end', () => {
        ended[index] = true;
        finish();
      });
      stream.once('error', () => {
        result.error = 'output_read_failed';
        result.truncated = true;
        ended[index] = true;
        finish();
      });
      stream.once('close', () => {
        if (!(stream as Readable).readableEnded) result.truncated = true;
        ended[index] = true;
        stream.off('data', data);
        finish();
      });
    }
    child.once('exit', (code, signal) => mainExit(code, signal, null));
    child.once('error', () => mainExit(null, null, 'command_spawn_failed'));
    if (child.exitCode !== null || child.signalCode !== null)
      mainExit(child.exitCode, child.signalCode, null);
    stopObserving?.addEventListener('abort', abandon, { once: true });
    if (stopObserving?.aborted) abandon();
  });
}
