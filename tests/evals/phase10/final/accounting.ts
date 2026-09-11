import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export const PUBLIC_NAMES = ['grade-school', 'wordy', 'book-store', 'forth'] as const;
export type PublicName = (typeof PUBLIC_NAMES)[number];
export type Variant = 'single' | 'multi' | 'mixed' | 'parallel' | 'sparse';
export interface Trial {
  id: string;
  task: string;
  suite: 'public' | 'holdout';
  variant: Variant;
  attempt: number;
}
export const FRESH_HOLDOUT_NAMES = ['thermal-inspection', 'daily-availability'] as const;
export function trialMatrix(scope: 'legacy-all' | 'fresh-holdout' = 'legacy-all'): Trial[] {
  const names =
    scope === 'fresh-holdout'
      ? FRESH_HOLDOUT_NAMES
      : [...PUBLIC_NAMES, 'order-audit', 'shift-conflicts'];
  return names.flatMap((task) => {
    const suite = (PUBLIC_NAMES as readonly string[]).includes(task) ? 'public' : 'holdout';
    const variants: Variant[] =
      suite === 'public' ? ['single', 'multi', 'mixed'] : ['multi', 'parallel', 'sparse'];
    return [0, 1, 2].flatMap((round) =>
      [0, 1, 2].map((offset) => {
        const variant = variants[(round + offset) % 3] as Variant;
        return { id: `${task}-${variant}-${round + 1}`, task, suite, variant, attempt: round + 1 };
      }),
    );
  });
}

interface Charge {
  id: string;
  trial: string;
  category: 'formal' | 'diagnostic';
  reserved: number;
  status: 'reserved' | 'settled' | 'unknown';
  cost?: number;
  audit?: {
    method: 'reservation-upper-bound';
    reason: string;
    at: string;
    previousStatus: 'unknown';
  };
}
interface AuditAdjustment {
  id: string;
  category: Charge['category'];
  amountUsd: number;
  method: 'billing-window-upper-bound';
  evidenceSha256: string;
  reason: string;
  at: string;
}
function assertAuditAdjustment(a: AuditAdjustment): void {
  if (
    !a ||
    typeof a.id !== 'string' ||
    !a.id.trim() ||
    !['formal', 'diagnostic'].includes(a.category) ||
    !Number.isFinite(a.amountUsd) ||
    a.amountUsd <= 0 ||
    a.method !== 'billing-window-upper-bound' ||
    !/^[a-f0-9]{64}$/.test(a.evidenceSha256) ||
    typeof a.reason !== 'string' ||
    !a.reason.trim() ||
    !Number.isFinite(Date.parse(a.at))
  )
    throw new Error('invalid billing audit adjustment');
}
function auditTotal(state: Ledger, category?: Charge['category']): number {
  return (state.adjustments ?? [])
    .filter((a) => category === undefined || a.category === category)
    .reduce((sum, a) => sum + a.amountUsd, 0);
}
interface Ledger {
  version: 1;
  totalLimit: number;
  formalLimit: number;
  requests: Charge[];
  adjustments?: AuditAdjustment[];
}

/** Persist before I/O; unresolved prior-process requests require an explicit accounting audit. */
export class BudgetLedger {
  private readonly active = new Set<string>();
  constructor(
    readonly path: string,
    readonly totalLimit: number,
    readonly formalLimit: number,
  ) {
    if (
      ![totalLimit, formalLimit].every((n) => Number.isFinite(n) && n > 0) ||
      formalLimit > totalLimit
    )
      throw new Error('invalid budget limits');
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({ version: 1, totalLimit, formalLimit, requests: [] }), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    this.read();
  }
  private read(): Ledger {
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as Ledger;
    if (
      value.version !== 1 ||
      value.totalLimit !== this.totalLimit ||
      value.formalLimit !== this.formalLimit ||
      !Array.isArray(value.requests)
    )
      throw new Error('budget configuration drift');
    const ids = new Set<string>();
    for (const r of value.requests) {
      if (
        !r.id ||
        !r.trial ||
        ids.has(r.id) ||
        !['formal', 'diagnostic'].includes(r.category) ||
        !['reserved', 'settled', 'unknown'].includes(r.status) ||
        !Number.isFinite(r.reserved) ||
        r.reserved <= 0 ||
        (r.status === 'settled' && (r.cost === undefined || !Number.isFinite(r.cost) || r.cost < 0))
      )
        throw new Error('corrupt budget ledger');
      ids.add(r.id);
    }
    if (value.adjustments !== undefined && !Array.isArray(value.adjustments))
      throw new Error('corrupt billing audit adjustments');
    const auditIds = new Set<string>();
    for (const adjustment of value.adjustments ?? []) {
      assertAuditAdjustment(adjustment);
      if (auditIds.has(adjustment.id)) throw new Error('duplicate billing audit adjustment');
      auditIds.add(adjustment.id);
    }
    return value;
  }
  private update(change: (state: Ledger) => void): void {
    const lock = `${this.path}.lock`;
    const fd = openSync(lock, 'wx', 0o600);
    try {
      const state = this.read();
      change(state);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  reserve(id: string, trial: string, category: Charge['category'], maximum: number): void {
    this.update((state) => {
      if (!id || !trial || !Number.isFinite(maximum) || maximum <= 0)
        throw new Error('invalid reservation');
      if (state.requests.some((r) => r.status === 'unknown'))
        throw new Error('unknown cost requires audit');
      if (state.requests.some((r) => r.status === 'reserved' && !this.active.has(r.id)))
        throw new Error('unresolved reservation requires audit');
      if (state.requests.some((r) => r.id === id)) throw new Error('duplicate request');
      const sum = (filter: (r: Charge) => boolean) =>
        state.requests
          .filter(filter)
          .reduce((n, r) => n + (r.status === 'settled' ? (r.cost as number) : r.reserved), 0);
      if (
        sum(() => true) + auditTotal(state) + maximum > this.totalLimit ||
        (category === 'formal' &&
          sum((r) => r.category === 'formal') + auditTotal(state, 'formal') + maximum >
            this.formalLimit) ||
        (category === 'diagnostic' &&
          sum((r) => r.category === 'diagnostic') + auditTotal(state, 'diagnostic') + maximum >
            this.totalLimit - this.formalLimit) ||
        sum((r) => r.trial === trial) + maximum > 2
      )
        throw new Error('budget exhausted');
      state.requests.push({ id, trial, category, reserved: maximum, status: 'reserved' });
    });
    this.active.add(id);
  }
  settle(id: string, cost: number | undefined): void {
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) throw new Error('invalid cost');
    this.update((state) => {
      const record = state.requests.find((r) => r.id === id);
      if (record?.status !== 'reserved' || !this.active.has(id))
        throw new Error('request is not active');
      record.status = cost === undefined ? 'unknown' : 'settled';
      if (cost !== undefined) record.cost = cost;
    });
    this.active.delete(id);
  }
  /** Explicit operator audit only; do not call automatically on a provider failure. */
  auditUnknown(id: string, reason: string): void {
    if (!reason.trim()) throw new Error('audit reason required');
    this.update((state) => {
      const record = state.requests.find((r) => r.id === id);
      if (record?.status !== 'unknown') throw new Error('request is not unknown');
      record.audit = {
        method: 'reservation-upper-bound',
        reason,
        at: new Date().toISOString(),
        previousStatus: 'unknown',
      };
      record.cost = record.reserved;
      record.status = 'settled';
    });
  }
  /** Explicit retrospective audit debit; never fabricates a provider request or usage. */
  addAuditAdjustment(adjustment: AuditAdjustment): void {
    assertAuditAdjustment(adjustment);
    this.update((state) => {
      const prior = state.adjustments?.find((a) => a.id === adjustment.id);
      if (prior) {
        const keys: (keyof AuditAdjustment)[] = [
          'id',
          'category',
          'amountUsd',
          'method',
          'evidenceSha256',
          'reason',
          'at',
        ];
        if (keys.some((key) => prior[key] !== adjustment[key]))
          throw new Error('billing audit adjustment conflict');
        return;
      }
      state.adjustments = [...(state.adjustments ?? []), structuredClone(adjustment)];
    });
  }
  get spent(): number | 'unknown' {
    const state = this.read();
    const rows = state.requests;
    return rows.some((r) => r.status === 'unknown')
      ? 'unknown'
      : rows.reduce((n, r) => n + (r.cost ?? r.reserved), 0) + auditTotal(state);
  }
  remaining(category: Charge['category']): number {
    const state = this.read();
    const rows = state.requests;
    if (rows.some((r) => r.status === 'unknown')) return 0;
    const total = rows.reduce((n, r) => n + (r.cost ?? r.reserved), 0) + auditTotal(state);
    const categoryTotal =
      rows.filter((r) => r.category === category).reduce((n, r) => n + (r.cost ?? r.reserved), 0) +
      auditTotal(state, category);
    const cap = category === 'formal' ? this.formalLimit : this.totalLimit - this.formalLimit;
    return Math.max(0, Math.min(this.totalLimit - total, cap - categoryTotal));
  }
}

function stats(values: number[]) {
  if (!values.length)
    return { count: 0, mean: null, median: null, variance: null, standardDeviation: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.length < 2
      ? null
      : values.reduce((s, n) => s + (n - mean) ** 2, 0) / (values.length - 1);
  const midpoint = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    mean,
    median:
      sorted.length % 2
        ? sorted[midpoint]
        : ((sorted[midpoint - 1] as number) + (sorted[midpoint] as number)) / 2,
    variance,
    standardDeviation: variance === null ? null : Math.sqrt(variance),
  };
}
export function summarize(
  rows: readonly { id: string; final: boolean; passed: boolean; durationMs: number }[],
) {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('duplicate trial');
  if (
    rows.some((r) => !Number.isFinite(r.durationMs) || r.durationMs < 0 || (!r.final && r.passed))
  )
    throw new Error('invalid trial result');
  return {
    started: rows.length,
    passed: rows.filter((r) => r.final && r.passed).length,
    provisional: rows.filter((r) => !r.final).length,
    successTime: stats(rows.filter((r) => r.final && r.passed).map((r) => r.durationMs)),
    failureTime: stats(rows.filter((r) => r.final && !r.passed).map((r) => r.durationMs)),
  };
}
