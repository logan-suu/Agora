/** Optional audit for the existing live regressions; requests and responses are not altered. */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import { isPeak } from '../../phase9/metrics';
import { BudgetLedger } from './accounting';
import { costOf } from './model-adapter';
import { OFFICIAL_CONFIG as CONFIG, OFFICIAL_MODELS as MODELS } from './model-profile';
import { observeResponse } from './wire-usage';

const path = process.env.AGORA_EVAL_BUDGET_FILE;
if (path) {
  const ledger = new BudgetLedger(path, 20, 17),
    original = globalThis.fetch;
  const pending = new Set<Promise<void>>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.hostname !== 'api.deepseek.com' || !url.pathname.endsWith('/chat/completions'))
      return original(input, init);
    const text =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    if (!text) throw new Error('cannot audit regression model request');
    const body = JSON.parse(text),
      model = body.model as (typeof MODELS)[number];
    if (!MODELS.includes(model)) throw new Error('unpriced regression model');
    const output = body.max_tokens ?? 32768;
    if (!Number.isInteger(output) || output <= 0) throw new Error('unbounded regression output');
    const bytes = Buffer.byteLength(text),
      rates = CONFIG.peakRates[model];
    const id = randomUUID(),
      start = new Date();
    ledger.reserve(
      id,
      'existing-live-regressions',
      'diagnostic',
      (bytes * rates.input + output * rates.output) / 1_000_000,
    );
    let response: Response;
    try {
      response = await original(input, init);
    } catch (error) {
      appendFileSync(
        `${path}.audit.jsonl`,
        `${JSON.stringify({ id, stage: 'transport', errorName: error instanceof Error ? error.name : 'unknown', errorCode: error instanceof Error && 'cause' in error ? (error.cause as { code?: string } | undefined)?.code : undefined })}\n`,
        { mode: 0o600 },
      );
      ledger.settle(id, undefined);
      throw error;
    }
    let resolveAudit!: () => void;
    let rejectAudit!: (error: unknown) => void;
    const audit = new Promise<void>((resolve, reject) => {
      resolveAudit = resolve;
      rejectAudit = reject;
    });
    pending.add(audit);
    void audit.catch(() => undefined);
    return observeResponse(response, (usage) => {
      try {
        appendFileSync(
          `${path}.audit.jsonl`,
          `${JSON.stringify({ id, httpStatus: response.status, inputBytes: bytes, maxOutputTokens: output, model, usage: usage ?? null })}\n`,
          { mode: 0o600 },
        );
        ledger.settle(
          id,
          usage === undefined ? undefined : costOf(model, usage, isPeak(start), CONFIG),
        );
        resolveAudit();
      } catch (error) {
        rejectAudit(error);
      }
    });
  };
  afterAll(async () => {
    await Promise.all(pending);
    globalThis.fetch = original;
  });
}
