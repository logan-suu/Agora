import type { TokenUsage } from '@deepseek-ai/dsh-llm';

/** Flash-0731 USD / million tokens, official pricing checked 2026-09-08. */
export const PRICING = {
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  checked: '2026-09-08',
  peak: { input: 0.44, cacheRead: 0.014, output: 1.32 },
  offPeak: { input: 0.22, cacheRead: 0.007, output: 0.66 },
};

export function isPeak(date: Date): boolean {
  const day = date.getUTCDay(),
    hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export function usageCost(usage: TokenUsage, peak: boolean): number | undefined {
  const rates = peak ? PRICING.peak : PRICING.offPeak;
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens];
  if (values.some((value) => value === undefined || !Number.isFinite(value) || value < 0))
    return undefined;
  return (
    ((usage.inputTokens + (usage.cacheWriteTokens ?? 0)) * rates.input +
      (usage.cacheReadTokens as number) * rates.cacheRead +
      usage.outputTokens * rates.output) /
    1_000_000
  );
}

export class ExperimentBudget {
  private spent = 0;
  private unknown = false;
  private reservations = new Map<symbol, number>();
  constructor(readonly limitUsd = 10) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new Error('invalid experiment budget');
  }
  get costUsd(): number | 'unknown' {
    return this.unknown ? 'unknown' : this.spent;
  }
  reserve(maximum: number): symbol {
    if (!Number.isFinite(maximum) || maximum < 0) throw new Error('invalid request reservation');
    if (this.unknown) throw new Error('model cost unknown; refusing additional requests');
    if (
      this.spent + [...this.reservations.values()].reduce((a, b) => a + b, 0) + maximum >
      this.limitUsd
    )
      throw new Error('experiment cost budget exhausted');
    const id = Symbol('request');
    this.reservations.set(id, maximum);
    return id;
  }
  finish(id: symbol, cost: number | undefined): void {
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0))
      throw new Error('invalid request settlement');
    if (!this.reservations.delete(id)) throw new Error('unknown request reservation');
    if (cost === undefined) this.unknown = true;
    else this.spent += cost;
  }
}
