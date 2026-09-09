/** The retry read model is structural; raw provider failure details stay in JSONL. */
export interface TraceRetryView {
  retryId: string;
  retry: number;
  maxRetries: number;
  delayMs: number;
  scheduledAt: number;
  backoffEndedAt?: number;
  status: 'waiting' | 'backoff_completed' | 'closed_without_start';
  errorCode: 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT' | 'UNKNOWN';
}
const CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
function fail(): never {
  throw new Error('invalid Harness retry lifecycle');
}
const positive = (v: unknown): number =>
  Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : fail();
const finite = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : fail();
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : fail();
}

export function retryView(data: Record<string, unknown>, time: number): TraceRetryView {
  const code = record(data.failure).code;
  return {
    retryId: identity(data.retryId),
    retry: positive(data.retry),
    maxRetries: positive(data.maxRetries),
    delayMs: finite(data.delayMs, 10000),
    scheduledAt: time,
    status: 'waiting',
    errorCode: CODES.includes(code as string) ? (code as TraceRetryView['errorCode']) : 'UNKNOWN',
  };
}

/** Read-side relation checks over inspect records, independent of Cordis live invariants. */
export class RetryHistory {
  private provider: unknown;
  private readonly chains = new Map<
    string,
    { turn: number; step: number; provider: string; policy: string; last: TraceRetryView }
  >();
  private readonly stepChains = new Map<string, string>();

  header(data: Record<string, unknown>): void {
    this.provider = record(record(data.header).config).provider;
  }

  consume(
    type: string,
    data: Record<string, unknown>,
    time: number,
    turn: number | undefined,
    step: number | undefined,
  ): void {
    if (turn === undefined || step === undefined || data.turn !== turn || data.step !== step)
      fail();
    const id = identity(data.retryId);
    const prior = this.chains.get(id);
    if (type === 'llm/retry-started') {
      if (
        !prior ||
        prior.turn !== turn ||
        prior.step !== step ||
        prior.last.retry !== data.retry ||
        prior.last.status !== 'waiting' ||
        time < prior.last.scheduledAt
      )
        fail();
      prior.last.status = 'backoff_completed';
      prior.last.backoffEndedAt = time;
      return;
    }
    const view = retryView(data, time);
    if (
      typeof data.provider !== 'string' ||
      !data.provider ||
      data.provider !== this.provider ||
      data.mode !== 'normal'
    )
      fail();
    if (typeof data.policyKey !== 'string' || data.policyKey.length > 1024) fail();
    let policy: unknown;
    try {
      policy = JSON.parse(data.policyKey);
    } catch {
      fail();
    }
    if (
      !Array.isArray(policy) ||
      policy.length !== 6 ||
      policy[0] !== 'normal' ||
      policy[1] !== view.maxRetries ||
      view.maxRetries > 5 ||
      view.retry > view.maxRetries
    )
      fail();
    const p = policy as unknown[];
    if (
      !Array.isArray(p[2]) ||
      p[2].length === 0 ||
      p[2].some((code) => !CODES.includes(code)) ||
      new Set(p[2]).size !== p[2].length
    )
      fail();
    finite(p[3], 10000);
    finite(p[4], 10000);
    finite(p[5], 1);
    if ((p[3] as number) > (p[4] as number) || view.delayMs > (p[4] as number)) fail();
    const stepKey = `${turn}/${step}`;
    if (this.stepChains.has(stepKey) && this.stepChains.get(stepKey) !== id) fail();
    if (prior) {
      if (
        prior.turn !== turn ||
        prior.step !== step ||
        prior.provider !== data.provider ||
        prior.policy !== data.policyKey ||
        prior.last.retry + 1 !== view.retry ||
        prior.last.status !== 'backoff_completed' ||
        time < (prior.last.backoffEndedAt ?? 0)
      )
        fail();
    } else if (view.retry !== 1) fail();
    this.stepChains.set(stepKey, id);
    this.chains.set(id, {
      turn: turn as number,
      step: step as number,
      provider: data.provider as string,
      policy: data.policyKey,
      last: view,
    });
  }
}
